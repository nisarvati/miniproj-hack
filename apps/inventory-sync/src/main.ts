import { hostname } from "node:os";
import { createPool, healthPortFor, probe, startHealthServer, type HealthCheck } from "@medlink/db";
import { createRedis, describeError, redisOptionsFromEnv } from "@medlink/redis";
import { DEFAULT_DEDUP_OPTIONS } from "./dedup.js";
import { createSyncHandler } from "./handlers.js";
import { createLogger } from "./logger.js";
import { CatalogueMirror } from "./mirror.js";
import { DEFAULT_SYNC_OPTIONS, SyncService } from "./service.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");
const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

let redisConnection: ReturnType<typeof redisOptionsFromEnv>;
try {
  redisConnection = redisOptionsFromEnv();
} catch (err) {
  logger.error({ error: describeError(err) }, "invalid Redis configuration");
  process.exit(1);
}

const keyPrefix = process.env.REDIS_KEY_PREFIX;
const redis = createRedis({
  ...redisConnection,
  name: "inventory-sync",
  onError: (err) => logger.error({ error: describeError(err) }, "redis connection error"),
});

// Also copy every applied change into the central database, which search falls back to when live stock is unavailable.
// Needs DATABASE_URL; SYNC_MIRROR=off runs the service with Redis only.
const catalogueDb = process.env.DATABASE_URL && process.env.SYNC_MIRROR !== "off" ? createPool(process.env.DATABASE_URL) : undefined;
catalogueDb?.on("error", (err) => logger.error({ error: describeError(err) }, "catalogue database connection error"));
logger.info({ catalogueMirror: catalogueDb ? "on" : "off" }, "inventory-sync configured");

const { handler } = createSyncHandler(redis, {
  keyPrefix,
  mirror: catalogueDb && new CatalogueMirror(catalogueDb, logger),
  retentionMs: num("SYNC_DEDUP_RETENTION_HOURS", DEFAULT_DEDUP_OPTIONS.retentionMs / 3_600_000) * 3_600_000,
  leaseMs: num("SYNC_DEDUP_LEASE_MS", DEFAULT_DEDUP_OPTIONS.leaseMs),
});

const service = new SyncService(redis, handler, logger, {
  keyPrefix,
  group: process.env.SYNC_GROUP ?? DEFAULT_SYNC_OPTIONS.group,
  consumer: process.env.SYNC_CONSUMER ?? `${hostname()}-${process.pid}`,
  batchSize: num("SYNC_BATCH_SIZE", DEFAULT_SYNC_OPTIONS.batchSize),
  blockMs: num("SYNC_BLOCK_MS", DEFAULT_SYNC_OPTIONS.blockMs),
  minIdleMs: num("SYNC_MIN_IDLE_MS", DEFAULT_SYNC_OPTIONS.minIdleMs),
  maxDeliveries: num("SYNC_MAX_DELIVERIES", DEFAULT_SYNC_OPTIONS.maxDeliveries),
});
service.start();

const check: HealthCheck = async () => {
  const redisState = await probe(() => redis.ping());
  const postgres = catalogueDb ? await probe(() => catalogueDb.query("SELECT 1")) : "not-configured";
  return {
    dependencies: { redis: redisState, postgres },
    details: { catalogueMirror: catalogueDb ? "on" : "off", ...service.stats() },
    hints: [],
  };
};
const healthPort = healthPortFor("inventory-sync");
if (healthPort !== null) await startHealthServer({ service: "inventory-sync", port: healthPort, check, onProblem: (m) => logger.warn({}, m) });
void check().then((r) => {
  const down = Object.entries(r.dependencies).filter(([, s]) => s === "down").map(([n]) => n);
  if (down.length) logger.warn({ unreachable: down }, "inventory-sync started, but cannot reach everything it needs: it keeps retrying");
  else logger.info({ healthPort }, "inventory-sync ready: Redis (and the catalogue database, if enabled) answered");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    logger.info({ signal, ...service.stats() }, "shutting down");
    await service.stop();
    redis.disconnect();
    await catalogueDb?.end();
    process.exit(0);
  });
}
