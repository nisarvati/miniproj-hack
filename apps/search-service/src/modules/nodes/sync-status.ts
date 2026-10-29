import { eventStreamKey, syncStatusKey } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";

/**
 * What the synchronization pipeline recorded about one pharmacy, read from Redis. Every field is `null` when it is missing
 * or malformed: "unknown" is never turned into 0. Written by the sync service (apps/inventory-sync):
 *   lastSyncedAt    when the sync service last PROCESSED an event for the pharmacy (SyncStatusHandler). Not a heartbeat: a pharmacy
 *                   that sells nothing has an old value and nothing is wrong.
 *   processedCount  events that reached the sync handler (duplicates are stopped before it, so they are not counted here).
 *   duplicateCount  events skipped because their id was already handled (DedupHandler).
 *   staleCount      events that changed nothing because a newer event had already decided every field (InventoryStateHandler).
 */
export interface SyncRecord {
  lastSyncedAt: string | null;
  processedCount: number | null;
  duplicateCount: number | null;
  staleCount: number | null;
}

export interface NodeReading {
  /** null: Redis holds no sync status for this pharmacy (nothing was ever synced). */
  record: SyncRecord | null;
  /**
   * Events in the pharmacy's stream that the sync service has not finished (group lag + delivered-but-unacknowledged).
   * null: could not be measured (no consumer group yet and no way to count, or Redis could not say).
   */
  backlog: number | null;
}

export type SyncReading = { redis: "up"; nodes: Map<string, NodeReading> } | { redis: "down" };

/** Where node status comes from. A fake in tests; Redis in the service. Read-only. */
export interface SyncStatusSource {
  read(pharmacyCodes: string[]): Promise<SyncReading>;
}

const toIso = (v: string | undefined): string | null => {
  if (v === undefined) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const toCount = (v: string | undefined): number | null => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);

/**
 * Reads a status hash defensively. The duplicate and stale counters are created by the first increment, so on a pharmacy that has
 * processed events (a valid processedCount) an ABSENT one really is zero; one that is present but malformed is unknown.
 */
export function parseSyncRecord(hash: Record<string, string>): SyncRecord | null {
  if (Object.keys(hash).length === 0) return null;
  const processedCount = toCount(hash.processedCount);
  const lazy = (v: string | undefined) => (v === undefined ? (processedCount !== null ? 0 : null) : toCount(v));
  return {
    lastSyncedAt: toIso(hash.lastSyncedAt),
    processedCount,
    duplicateCount: lazy(hash.duplicateCount),
    staleCount: lazy(hash.staleCount),
  };
}

export interface RedisSyncStatusOptions {
  keyPrefix?: string;
  /** The consumer group of the sync service (apps/inventory-sync, `group`). */
  group?: string;
  /** A slow Redis must not hang the dashboard: give up after this long and report "down". */
  timeoutMs?: number;
}

export class RedisSyncStatus implements SyncStatusSource {
  private readonly group: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly opts: RedisSyncStatusOptions = {},
  ) {
    this.group = opts.group ?? "inventory-sync";
    this.timeoutMs = opts.timeoutMs ?? 800;
  }

  async read(pharmacyCodes: string[]): Promise<SyncReading> {
    try {
      if ((await this.within(this.redis.ping())) !== "PONG") return { redis: "down" };
      // One pharmacy's keys share a hash tag, but different pharmacies are different slots: separate commands, not one pipeline.
      const entries = await this.within(
        Promise.all(
          pharmacyCodes.map(async (code) => {
            const hash = await this.redis.hgetall(syncStatusKey(code, this.opts.keyPrefix));
            return [code, { record: parseSyncRecord(hash), backlog: await this.backlog(code) }] as const;
          }),
        ),
      );
      return { redis: "up", nodes: new Map(entries) };
    } catch {
      return { redis: "down" };
    }
  }

  /** Unprocessed events: the group's lag plus what was delivered but not acknowledged. No stream: nothing was ever published (0). */
  private async backlog(code: string): Promise<number | null> {
    const stream = eventStreamKey(code, this.opts.keyPrefix);
    let groups: unknown;
    try {
      groups = await this.redis.xinfo("GROUPS", stream);
    } catch (err) {
      if (/no such key/i.test(String((err as Error).message))) return 0;
      return null;
    }
    const group = (Array.isArray(groups) ? groups : []).map(pairs).find((g) => g.name === this.group);
    if (!group) {
      // The stream exists but the sync service never created its group: everything in it is waiting.
      try {
        return Number(await this.redis.xlen(stream));
      } catch {
        return null;
      }
    }
    const pending = Number(group.pending);
    const lag = group.lag === null || group.lag === undefined ? null : Number(group.lag);
    // Redis reports lag as null when it cannot tell (for example after entries were deleted): unknown, not zero.
    return Number.isFinite(pending) && lag !== null && Number.isFinite(lag) ? pending + lag : null;
  }

  private within<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis did not answer within ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    work.catch(() => undefined);
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }
}

/** XINFO replies are flat [key, value, key, value, ...] lists. */
function pairs(flat: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}
