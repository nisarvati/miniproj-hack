import { createPool } from "@medlink/db";
import { createRedis, describeError, redisOptionsFromEnv } from "@medlink/redis";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { RedisLiveStock } from "./modules/live/live-stock.js";

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
const app = await buildApp(db, config, { live: redis && new RedisLiveStock(redis, { keyPrefix: process.env.REDIS_KEY_PREFIX }) });
app.log.info({ liveStock: redis ? "on" : "off" }, "search service configured");

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
