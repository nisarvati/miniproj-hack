import { dedupKey, syncStatusKey, type InventoryEvent } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";
import type { EventHandler, HandlerContext } from "./handler.js";

export interface DedupOptions {
  keyPrefix?: string;
  /** How long a "done" marker is kept. Must outlast the longest time a duplicate can still arrive. */
  retentionMs: number;
  /** How long one delivery may hold an event before another delivery may take over (crashed consumer). */
  leaseMs: number;
}

export const DEFAULT_DEDUP_OPTIONS: DedupOptions = {
  retentionMs: 7 * 24 * 3600 * 1000,
  leaseMs: 30_000,
};

/** Thrown while another delivery of the same event is being handled. Not a failure: the entry is retried later. */
export class EventInFlightError extends Error {
  constructor(eventId: string) {
    super(`event ${eventId} is being handled by another delivery`);
    this.name = "EventInFlightError";
  }
}

/**
 * KEYS[1] marker, ARGV[1] lease ms.
 * Returns 0 if the event is already done, 1 if another delivery holds the lease, 2 if we now hold it.
 */
const BEGIN = `
local v = redis.call('GET', KEYS[1])
if v == 'done' then return 0 end
if v == 'processing' then return 1 end
redis.call('SET', KEYS[1], 'processing', 'PX', ARGV[1])
return 2`;

/** Releases our lease after a failure, but never un-does a "done" marker. */
const RELEASE = `
if redis.call('GET', KEYS[1]) == 'processing' then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Makes any handler safe against duplicate deliveries of the same `eventId`.
 *
 * Why not just "SET NX, then handle"? A crash after the SET would make every retry look like a duplicate and the
 * event would be lost. Instead there are two states:
 *   processing  short lease, taken before the handler runs; expires by itself if the consumer dies
 *   done        written only AFTER the handler succeeded; kept for `retentionMs`
 *
 * Result: an event is never skipped unless it was really handled, and handled events are not handled again.
 *
 * Limit: for a plain handler the marker and the handler's own writes are separate Redis calls, so a crash between
 * them can run the handler a second time for that one event. A handler that sets `commitsDedupMarker` (the
 * InventoryStateHandler) writes the marker in the same atomic script as its state change and has no such gap.
 */
export class DedupHandler implements EventHandler {
  readonly stats = { duplicates: 0, inFlight: 0 };
  private readonly opts: DedupOptions;

  constructor(
    private readonly redis: Redis,
    private readonly inner: EventHandler,
    opts: Partial<DedupOptions> = {},
  ) {
    this.opts = { ...DEFAULT_DEDUP_OPTIONS, ...opts };
  }

  async handle(event: InventoryEvent, ctx: HandlerContext): Promise<void> {
    const key = dedupKey(event.pharmacyId, event.eventId, this.opts.keyPrefix);
    const state = Number(await this.redis.eval(BEGIN, 1, key, String(this.opts.leaseMs)));

    if (state === 0) {
      this.stats.duplicates++;
      await this.redis.hincrby(syncStatusKey(event.pharmacyId, this.opts.keyPrefix), "duplicateCount", 1);
      return; // already handled: acknowledge without doing it again
    }
    if (state === 1) {
      this.stats.inFlight++;
      throw new EventInFlightError(event.eventId);
    }

    try {
      await this.inner.handle(event, { ...ctx, dedupMarker: { key, retentionMs: this.opts.retentionMs } });
    } catch (err) {
      await this.redis.eval(RELEASE, 1, key).catch(() => undefined); // best effort; the lease expires anyway
      throw err;
    }
    // A handler that commits the marker atomically with its own writes leaves nothing to do here.
    if (!this.inner.commitsDedupMarker) await this.redis.set(key, "done", "PX", this.opts.retentionMs);
  }
}
