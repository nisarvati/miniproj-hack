import type { HeartbeatRecord } from "@medlink/db";
import { workerHealthKey } from "@medlink/event-schema";
import { parseConnectorReport, type ConnectorHealthSource, type ConnectorReading } from "./connector-health.js";
import { parseServiceReport, type SyncServiceHealthSource, type SyncServiceState } from "./service-health.js";

/**
 * Worker health from Redis heartbeats (packages/db health.ts `startHeartbeat`). This is how the search service learns about the connector and the sync service when
 * they run on other machines, with no port it could reach. Four outcomes, never blurred:
 *   healthy      a recent heartbeat whose report says the worker is ready
 *   unhealthy    a recent heartbeat whose report says it is NOT ready (the worker is alive and says what is wrong)
 *   stale        heartbeats exist but the newest is older than `staleAfterMs`: the worker stopped, hung, or lost Redis
 *   unreachable  no heartbeat at all, or Redis could not be read
 * Only the NEWEST instance counts (a deploy leaves the old instance's record behind for a while); a record older than `forgetAfterMs` is a worker that went away
 * and is ignored. A timestamp from the future (clock skew beyond `skewMs`) is not trusted as fresh.
 */
export type WorkerState = "healthy" | "unhealthy" | "stale" | "unreachable";

export interface WorkerReading {
  state: WorkerState;
  /** How old the newest usable heartbeat is. null: there is none. */
  ageMs: number | null;
  /** How many instances were heard from recently enough to count. */
  instances: number;
  /** The newest heartbeat's health report, for `healthy`, `unhealthy` and `stale` (a stale one is not used for evidence). */
  report: unknown | null;
}

export const WORKER_HEALTH_DEFAULTS = { staleAfterMs: 35_000, forgetAfterMs: 10 * 60_000, skewMs: 15_000, timeoutMs: 1000 } as const;

function parseRecord(raw: string): { at: number; report: unknown } | null {
  try {
    const r = JSON.parse(raw) as Partial<HeartbeatRecord> | null;
    if (typeof r !== "object" || r === null || r.v !== 1 || typeof r.at !== "number" || !Number.isFinite(r.at) || typeof r.report !== "object" || r.report === null) return null;
    return { at: r.at, report: r.report };
  } catch {
    return null;
  }
}

/** Pure: what a service's stored heartbeats (instance -> JSON) say about it right now. */
export function classifyHeartbeats(fields: Record<string, string> | null, now: number, opts: { staleAfterMs?: number; forgetAfterMs?: number; skewMs?: number } = {}): WorkerReading {
  const staleAfter = opts.staleAfterMs ?? WORKER_HEALTH_DEFAULTS.staleAfterMs;
  const forgetAfter = opts.forgetAfterMs ?? WORKER_HEALTH_DEFAULTS.forgetAfterMs;
  const skew = opts.skewMs ?? WORKER_HEALTH_DEFAULTS.skewMs;
  const usable = Object.values(fields ?? {})
    .map(parseRecord)
    .filter((r): r is { at: number; report: unknown } => r !== null)
    // A record from the far future is not "fresh"; it is a broken clock. Treat it as unusable rather than as proof of life.
    .filter((r) => r.at - now <= skew)
    .map((r) => ({ ...r, age: Math.max(0, now - r.at) }))
    .filter((r) => r.age <= forgetAfter)
    .sort((a, b) => a.age - b.age);
  if (usable.length === 0) return { state: "unreachable", ageMs: null, instances: 0, report: null };
  const newest = usable[0]!;
  if (newest.age > staleAfter) return { state: "stale", ageMs: newest.age, instances: 0, report: null };
  const fresh = usable.filter((r) => r.age <= staleAfter);
  // Several instances (for example during a deploy): the service is ready if any fresh one is. The report used is the freshest ready one, else the freshest.
  const ready = fresh.find((r) => (r.report as { ready?: unknown }).ready === true);
  const chosen = ready ?? newest;
  return { state: ready ? "healthy" : "unhealthy", ageMs: newest.age, instances: fresh.length, report: chosen.report };
}

/** The part of a Redis client this needs. */
export interface HashReader {
  hgetall(key: string): Promise<Record<string, string>>;
}

export class RedisWorkerHealth {
  constructor(
    private readonly redis: HashReader,
    private readonly opts: { keyPrefix?: string; staleAfterMs?: number; forgetAfterMs?: number; skewMs?: number; timeoutMs?: number; now?: () => number } = {},
  ) {}

  /** Never throws: a Redis that cannot be read is "unreachable", which means no evidence. */
  async read(service: string): Promise<WorkerReading> {
    try {
      const timeout = this.opts.timeoutMs ?? WORKER_HEALTH_DEFAULTS.timeoutMs;
      const fields = await Promise.race([
        this.redis.hgetall(workerHealthKey(service, this.opts.keyPrefix)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), timeout).unref()),
      ]);
      return classifyHeartbeats(fields, (this.opts.now ?? Date.now)(), this.opts);
    } catch {
      return { state: "unreachable", ageMs: null, instances: 0, report: null };
    }
  }
}

/** The connector, as seen through its heartbeat. A stale or missing one gives no per-pharmacy evidence (never a remembered backlog). */
export class HeartbeatConnectorHealth implements ConnectorHealthSource {
  constructor(private readonly workers: Pick<RedisWorkerHealth, "read">) {}
  async read(): Promise<ConnectorReading> {
    const w = await this.workers.read("inventory-connector");
    if (w.state === "stale") return { reachable: false, stale: true };
    if (w.state === "unreachable") return { reachable: false };
    return parseConnectorReport(w.report);
  }
}

/** The sync service, as seen through its heartbeat. `unhealthy` is the existing "not-ready". */
export class HeartbeatSyncServiceHealth implements SyncServiceHealthSource {
  constructor(private readonly workers: Pick<RedisWorkerHealth, "read">) {}
  async read(): Promise<SyncServiceState> {
    const w = await this.workers.read("inventory-sync");
    if (w.state === "stale") return "stale";
    if (w.state === "unreachable") return "unreachable";
    return parseServiceReport(w.report);
  }
}
