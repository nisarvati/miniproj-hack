import { createPool, healthPortFor, loadPharmacyUrls, PHARMACY_CODES, probe, startHealthServer, type HealthCheck } from "@medlink/db";
import { createRedis, describeError, redisOptionsFromEnv } from "@medlink/redis";
import { InventoryConnector } from "./connector.js";
import { createLogger } from "./logger.js";
import { RedisStreamPublisher } from "./redis-publisher.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");

let redisConnection: ReturnType<typeof redisOptionsFromEnv>;
try {
  redisConnection = redisOptionsFromEnv();
} catch (err) {
  logger.error({ error: describeError(err) }, "invalid Redis configuration");
  process.exit(1);
}

// One independent connector per pharmacy (each with its own database connection and failure handling).
// CONNECTOR_PHARMACIES="P001,P003" runs a subset, e.g. one container per pharmacy.
const wanted = (process.env.CONNECTOR_PHARMACIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const codes = wanted.length ? wanted : [...PHARMACY_CODES];
const unknown = codes.filter((c) => !PHARMACY_CODES.includes(c));
if (unknown.length) {
  logger.error({ unknown }, "unknown pharmacy codes in CONNECTOR_PHARMACIES");
  process.exit(1);
}

const urls = loadPharmacyUrls();
// Fail fast when Redis is unreachable: the outbox keeps the events, and the connector retries with backoff.
const redis = createRedis({
  ...redisConnection,
  name: "inventory-connector",
  failFast: true,
  onError: (err) => logger.error({ error: describeError(err) }, "redis connection error"),
});
const publisher = new RedisStreamPublisher(redis, { keyPrefix: process.env.REDIS_KEY_PREFIX });
const pools = codes.map((code) => createPool(urls[code]));
const connectors = codes.map(
  (code, i) =>
    new InventoryConnector({
      pharmacyId: code,
      db: pools[i]!,
      publisher,
      logger,
      batchSize: Number(process.env.CONNECTOR_BATCH_SIZE ?? 50),
      pollIntervalMs: Number(process.env.CONNECTOR_POLL_INTERVAL_MS ?? 1000),
    }),
);

for (const [i, pool] of pools.entries()) {
  pool.on("error", (err) => logger.error({ pharmacyId: codes[i], error: err.message }, "idle database client error"));
}
connectors.forEach((c) => c.start());

/**
 * What the health endpoint (and the startup report) says: Redis and each pharmacy database answered a bounded probe just now,
 * how many outbox rows are still waiting to be published (a read-only count), and whether each polling loop is succeeding.
 * Counts and codes only; no connection strings.
 */
const check: HealthCheck = async () => {
  const redisState = await probe(() => redis.ping());
  const perPharmacy = await Promise.all(
    codes.map(async (code, i) => {
      let pending: number | null = null;
      const db = await probe(async () => {
        const { rows } = await pools[i]!.query<{ n: string }>("SELECT count(*) AS n FROM outbox WHERE published_at IS NULL AND failed_at IS NULL");
        pending = Number(rows[0]!.n);
      });
      return { code, db, pending, loop: connectors[i]!.status };
    }),
  );
  const loopsFailing = perPharmacy.filter((p) => p.loop.consecutiveFailures > 0).map((p) => p.code);
  const dbDown = perPharmacy.filter((p) => p.db === "down").map((p) => p.code);
  return {
    dependencies: { redis: redisState, ...Object.fromEntries(perPharmacy.map((p) => [`postgres:${p.code}`, p.db])) },
    ready: redisState === "up" && dbDown.length === 0 && loopsFailing.length === 0,
    details: {
      pharmacies: codes,
      unpublishedOutbox: Object.fromEntries(perPharmacy.map((p) => [p.code, p.pending])),
      pollingFailing: loopsFailing,
    },
    hints: [
      ...dbDown.map((c) => `the database for ${c} is not reachable: check PHARMACY_${c}_DATABASE_URL and that npm run pharmacies:setup has been run`),
      ...loopsFailing.map((c) => `the ${c} connector's last poll failed: see this service's log`),
    ],
  };
};
const healthPort = healthPortFor("inventory-connector");
if (healthPort !== null) await startHealthServer({ service: "inventory-connector", port: healthPort, check, onProblem: (m) => logger.warn({}, m) });
void check().then((r) => {
  const down = Object.entries(r.dependencies).filter(([, s]) => s === "down").map(([n]) => n);
  if (down.length) logger.warn({ unreachable: down }, "connector started, but cannot reach everything it needs: events stay in each pharmacy's outbox until it can");
  else logger.info({ pharmacies: codes, unpublishedOutbox: r.details?.unpublishedOutbox, healthPort }, "connector ready: Redis and every pharmacy database answered");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, "shutting down");
    await Promise.all(connectors.map((c) => c.stop()));
    await Promise.all(pools.map((p) => p.end()));
    redis.disconnect();
    process.exit(0);
  });
}
