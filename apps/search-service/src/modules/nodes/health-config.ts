import { healthPortFor } from "@medlink/db";
import { HttpConnectorHealth, type ConnectorHealthSource } from "./connector-health.js";
import { HeartbeatConnectorHealth, HeartbeatSyncServiceHealth, RedisWorkerHealth, WORKER_HEALTH_DEFAULTS, type HashReader } from "./heartbeat-health.js";
import { HttpSyncServiceHealth, type SyncServiceHealthSource } from "./service-health.js";

export type WorkerHealthMode = "http" | "redis" | "off";

export interface WorkerHealthSources {
  mode: WorkerHealthMode;
  connector?: ConnectorHealthSource;
  syncService?: SyncServiceHealthSource;
  /** One line for the startup log. Never a secret. */
  note: string;
}

function httpUrl(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid configuration: ${name} is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`Invalid configuration: ${name} must be an http or https URL`);
  if (u.username || u.password) throw new Error(`Invalid configuration: ${name} must not contain credentials`);
  return u.toString();
}

/**
 * Where the search service learns about the background workers' health (docs/node-status.md). WORKER_HEALTH selects it:
 *   http   (default, local development) each worker's own GET /health, on 127.0.0.1 unless WORKER_HEALTH_URL_CONNECTOR / WORKER_HEALTH_URL_SYNC say otherwise
 *          (a private-network address; the worker must then listen there with HEALTH_HOST)
 *   redis  heartbeats the workers store in Redis (they need WORKER_HEARTBEAT=redis): nothing to reach over HTTP, so it works across machines
 *   off    no worker health: nodes with nothing waiting are reported unknown, never healthy
 * Redis mode without a Redis connection is `off`, and the note says so.
 */
export function workerHealthFromEnv(env: NodeJS.ProcessEnv, redis: HashReader | undefined): WorkerHealthSources {
  const raw = (env.WORKER_HEALTH ?? "http").trim().toLowerCase();
  if (raw !== "http" && raw !== "redis" && raw !== "off") throw new Error(`Invalid configuration: WORKER_HEALTH must be http, redis or off (got "${raw}")`);
  if (raw === "off") return { mode: "off", note: "worker health is off" };
  if (raw === "redis") {
    if (!redis) return { mode: "off", note: "WORKER_HEALTH=redis but there is no Redis connection (LIVE_STOCK=off or no REDIS_URL): worker health is off" };
    const num = (name: string, fallback: number) => (env[name]?.trim() && Number.isFinite(Number(env[name])) && Number(env[name]) > 0 ? Number(env[name]) : fallback);
    const workers = new RedisWorkerHealth(redis, {
      keyPrefix: env.REDIS_KEY_PREFIX,
      staleAfterMs: num("WORKER_HEALTH_STALE_AFTER_MS", WORKER_HEALTH_DEFAULTS.staleAfterMs),
    });
    return { mode: "redis", connector: new HeartbeatConnectorHealth(workers), syncService: new HeartbeatSyncServiceHealth(workers), note: "worker health from Redis heartbeats" };
  }
  const connectorUrl = httpUrl(env, "WORKER_HEALTH_URL_CONNECTOR");
  const syncUrl = httpUrl(env, "WORKER_HEALTH_URL_SYNC");
  const connectorPort = healthPortFor("inventory-connector", env);
  const syncPort = healthPortFor("inventory-sync", env);
  return {
    mode: "http",
    connector: connectorUrl ? new HttpConnectorHealth(connectorUrl) : connectorPort === null ? undefined : new HttpConnectorHealth(`http://127.0.0.1:${connectorPort}/health`),
    syncService: syncUrl ? new HttpSyncServiceHealth(syncUrl) : syncPort === null ? undefined : new HttpSyncServiceHealth(`http://127.0.0.1:${syncPort}/health`),
    note: connectorUrl || syncUrl ? "worker health from the configured health URLs" : "worker health from each worker's local /health endpoint",
  };
}
