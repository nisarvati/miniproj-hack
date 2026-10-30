import { createPool } from "@medlink/db";
import { createRedis, describeError, redisOptionsFromEnv } from "@medlink/redis";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { RedisLiveStock } from "./modules/live/live-stock.js";
import { workerHealthFromEnv } from "./modules/nodes/health-config.js";
import { registryPharmacies } from "./modules/nodes/service.js";
import { RedisSyncStatus } from "./modules/nodes/sync-status.js";
import { RedisEventHistory } from "./modules/analytics/events.js";
import { RedisStockFeed } from "./modules/stream/feed.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

// Live stock: the current state the sync service keeps in Redis. Optional: without it (LIVE_STOCK=off, no Redis
// settings, Redis down) search answers from the database alone.
let redis: ReturnType<typeof createRedis> | undefined;
if (process.env.LIVE_STOCK !== "off") {
  try {
    redis = createRedis({
      ...redisOptionsFromEnv(),
      name: "search-service",
      failFast: true,
      commandTimeoutMs: 400,
      onError: () => undefined, // a down Redis shows up as live: "down" in /api/health, not as log noise per retry
    });
  } catch (err) {
    console.warn(`live stock disabled: ${describeError(err)}`);
  }
}
// Node status (GET /api/nodes): the sync service's Redis status, plus the workers' health, read the way WORKER_HEALTH says (modules/nodes/health-config.ts).
const workerHealth = workerHealthFromEnv(process.env, redis);
const app = await buildApp(db, config, {
  live: redis && new RedisLiveStock(redis, { keyPrefix: process.env.REDIS_KEY_PREFIX }),
  nodes: {
    sync: redis && new RedisSyncStatus(redis, { keyPrefix: process.env.REDIS_KEY_PREFIX }),
    connector: workerHealth.connector,
    syncService: workerHealth.syncService,
  },
  // GET /api/analytics/network: counts the entries each event stream retains per time bucket (XRANGE ids only).
  events: redis && new RedisEventHistory(redis, { keyPrefix: process.env.REDIS_KEY_PREFIX }),
  // GET /api/stream (live updates): tails the same event streams the sync service consumes, read-only, on the same Redis client.
  stream: { stock: redis && new RedisStockFeed(redis, { pharmacyCodes: () => registryPharmacies().map((p) => p.code), keyPrefix: process.env.REDIS_KEY_PREFIX }) },
});
app.log.info({ liveStock: redis ? "on" : "off", workerHealth: workerHealth.mode }, `search service configured; ${workerHealth.note}`);

// Pool errors on idle clients must not crash the process.
db.on("error", (err) => app.log.error({ err }, "idle database client error"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    redis?.disconnect();
    await db.end();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
