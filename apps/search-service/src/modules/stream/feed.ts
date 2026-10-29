import { dedupKey, eventStreamKey, parseInventoryEvent, STREAM_EVENT_FIELD, type EventType } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";

/** A stock change as browsers hear about it. Only what search already shows: no sale sizes (quantityDelta), no event internals. */
export interface StockChange {
  eventId: string;
  pharmacyCode: string;
  medicineCode: string;
  eventType: EventType;
  /** The pharmacy's own quantity after the change. null: this event does not carry one (a price update). */
  quantity: number | null;
  /** null: this event does not carry a price. */
  price: number | null;
  /** When the change happened at the pharmacy. */
  occurredAt: string;
}

/** Where stock changes come from. Redis in the service; a fake in tests. */
export interface StockFeed {
  /** New changes since the last call, in order per pharmacy. Throws when the source cannot be read (the caller retries). */
  poll(): Promise<StockChange[]>;
  stats(): FeedStats;
}

export interface FeedStats {
  /** Stream entries that were not valid events (or named another pharmacy) and were skipped. */
  malformed: number;
  /** Entries given up on because the sync service never confirmed them within `confirmTimeoutMs` (for example a dead-lettered event). */
  unconfirmed: number;
}

export interface RedisStockFeedOptions {
  pharmacyCodes: () => string[];
  keyPrefix?: string;
  /** Entries read per pharmacy per poll. */
  batch?: number;
  /** How long to wait for the sync service to finish an event before skipping it, so one stuck event cannot hold back the rest. */
  confirmTimeoutMs?: number;
  now?: () => number;
}

/**
 * Observes the per-pharmacy event streams (the same ones the sync service consumes) with plain XREAD:
 *  - no consumer group, no XREADGROUP, no XACK: it cannot take or acknowledge a message that belongs to the sync service, and it
 *    leaves the group's cursor and pending list untouched;
 *  - one command per pharmacy (a cluster cannot read keys from different slots in one command) on the shared client: no new connection;
 *  - it starts at each stream's current end, so history is never replayed to a browser.
 * A change is released only once the sync service has marked that event id "done" (its dedup marker), so a browser that refreshes
 * on it sees the applied state. This is a hint, not a ledger: the API stays the truth.
 */
export class RedisStockFeed implements StockFeed {
  private readonly cursors = new Map<string, string>();
  private readonly counters: FeedStats = { malformed: 0, unconfirmed: 0 };
  private readonly batch: number;
  private readonly confirmTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly redis: Redis,
    private readonly opts: RedisStockFeedOptions,
  ) {
    this.batch = opts.batch ?? 100;
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  stats(): FeedStats {
    return { ...this.counters };
  }

  async poll(): Promise<StockChange[]> {
    const out: StockChange[] = [];
    for (const code of this.opts.pharmacyCodes()) out.push(...(await this.pollOne(code)));
    return out;
  }

  private async pollOne(code: string): Promise<StockChange[]> {
    const stream = eventStreamKey(code, this.opts.keyPrefix);
    let cursor = this.cursors.get(code);
    if (cursor === undefined) {
      // First look: start at the end of the stream. A stream that does not exist yet starts from its first entry when it appears.
      const last = (await this.redis.xrevrange(stream, "+", "-", "COUNT", 1)) as [string, string[]][];
      cursor = last[0]?.[0] ?? "0-0";
      this.cursors.set(code, cursor);
      return [];
    }

    const reply = (await this.redis.xread("COUNT", this.batch, "STREAMS", stream, cursor)) as [string, [string, string[]][]][] | null;
    const entries = reply?.[0]?.[1] ?? [];
    const out: StockChange[] = [];
    for (const [id, fields] of entries) {
      const change = this.decode(code, fields);
      if (change === "malformed") {
        this.counters.malformed++;
      } else {
        const state = await this.redis.get(dedupKey(code, change.eventId, this.opts.keyPrefix));
        if (state !== "done") {
          // Not processed yet: wait for it, in order, unless it has been stuck too long.
          if (this.now() - streamIdMs(id) <= this.confirmTimeoutMs) break;
          this.counters.unconfirmed++;
        } else {
          out.push(change);
        }
      }
      cursor = id;
      this.cursors.set(code, id);
    }
    return out;
  }

  private decode(code: string, fields: string[]): StockChange | "malformed" {
    const at = fields.indexOf(STREAM_EVENT_FIELD);
    const raw = at >= 0 ? fields[at + 1] : undefined;
    if (raw === undefined) return "malformed";
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return "malformed";
    }
    const parsed = parseInventoryEvent(json);
    // A pharmacy's stream carries only that pharmacy's events: an entry naming another one is never passed on.
    if (!parsed.success || parsed.event.pharmacyId !== code) return "malformed";
    const e = parsed.event;
    return {
      eventId: e.eventId,
      pharmacyCode: e.pharmacyId,
      medicineCode: e.medicineId,
      eventType: e.eventType,
      quantity: "quantityAfter" in e ? e.quantityAfter : null,
      price: "price" in e && e.price !== undefined ? e.price : null,
      occurredAt: e.timestamp,
    };
  }
}

/** The millisecond part of a stream id ("1791210893077-0"). A malformed id counts as ancient, so it cannot block anything. */
const streamIdMs = (id: string): number => {
  const ms = Number(id.split("-")[0]);
  return Number.isFinite(ms) ? ms : 0;
};
