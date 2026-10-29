import {
  dedupKey,
  inventoryIndexKey,
  inventoryItemKey,
  medicineIndexKey,
  syncStatusKey,
  type InventoryEvent,
} from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";
import type { EventHandler, HandlerContext } from "./handler.js";

/** What the search side reads: one medicine at one pharmacy. */
export interface InventoryItem {
  pharmacyId: string;
  medicineId: string;
  quantity: number;
  /** null until some event carried a price. */
  price: number | null;
  removed: boolean;
  /** Timestamp (ISO) of the event that last set the quantity / price. */
  quantityAsOf: string | null;
  priceAsOf: string | null;
  lastEventId: string | null;
}

export type ApplyResult = "applied" | "stale" | "duplicate";

/**
 * Applies one event to the current state. Everything happens in this one script, so it is atomic:
 *
 *   KEYS  1 dedup marker, 2 item hash, 3 pharmacy index set, 4 pharmacy sync status
 *   ARGV  1 event type, 2 event time (epoch ms), 3 quantityAfter or "", 4 price or "", 5 medicineId,
 *         6 eventId, 7 dedup retention ms or "" (empty: the caller does not use the marker)
 *
 * Returns 1 applied, 0 stale (an equal-or-newer event already decided every field this one carries),
 * -1 duplicate (the marker is already "done").
 *
 * Order rules. Retries and take-over mean an older event can arrive after a newer one, so state is never "last
 * arrival wins":
 *  - quantity and price each remember the time of the event that set them; an event only changes a field if it
 *    is not older than that. A late price update therefore can't overwrite a newer price, and a newer sale can't
 *    block an older price update from being judged on its own.
 *  - quantityAfter (the pharmacy's own count) is stored, not "old quantity + delta", so a missed or reordered
 *    event heals itself with the next one.
 *  - A removed medicine stays a tombstone: only a newer MEDICINE_ADDED brings it back.
 */
const APPLY = `
if ARGV[7] ~= '' and redis.call('GET', KEYS[1]) == 'done' then return -1 end

local t, ts = ARGV[1], tonumber(ARGV[2])
local f = redis.call('HMGET', KEYS[2], 'quantityTs', 'priceTs', 'removed')
local qts, pts = tonumber(f[1]) or 0, tonumber(f[2]) or 0
local removed = f[3] == '1'
local applied = 0

if t == 'MEDICINE_ADDED' then
  if ts >= qts then
    redis.call('HSET', KEYS[2], 'quantity', ARGV[3], 'quantityTs', ts, 'removed', '0')
    removed = false
    applied = 1
  end
  if ts >= pts and ARGV[4] ~= '' and (applied == 1 or not removed) then
    redis.call('HSET', KEYS[2], 'price', ARGV[4], 'priceTs', ts)
    applied = 1
  end
elseif removed then
  -- tombstone: ignore everything except a newer MEDICINE_ADDED
elseif t == 'MEDICINE_REMOVED' then
  if ts >= qts then
    redis.call('HSET', KEYS[2], 'quantity', '0', 'quantityTs', ts, 'removed', '1')
    removed = true
    applied = 1
  end
else
  if ARGV[3] ~= '' and ts >= qts then
    redis.call('HSET', KEYS[2], 'quantity', ARGV[3], 'quantityTs', ts)
    applied = 1
  end
  if ARGV[4] ~= '' and ts >= pts then
    redis.call('HSET', KEYS[2], 'price', ARGV[4], 'priceTs', ts)
    applied = 1
  end
end

if applied == 1 then
  redis.call('HSET', KEYS[2], 'medicineId', ARGV[5], 'lastEventId', ARGV[6])
  if removed then redis.call('SREM', KEYS[3], ARGV[5]) else redis.call('SADD', KEYS[3], ARGV[5]) end
  redis.call('HINCRBY', KEYS[4], 'appliedCount', 1)
else
  redis.call('HINCRBY', KEYS[4], 'staleCount', 1)
end

if ARGV[7] ~= '' then redis.call('SET', KEYS[1], 'done', 'PX', ARGV[7]) end
return applied`;

export interface StateOptions {
  keyPrefix?: string;
}

/**
 * Keeps the current stock and price of every medicine at every pharmacy in Redis, by applying events.
 *
 * Inside a DedupHandler it also writes the "done" marker in the same script as the change, so a crash can never
 * leave a change applied but not marked (or marked but not applied).
 */
export class InventoryStateHandler implements EventHandler {
  readonly commitsDedupMarker = true;
  readonly stats = { applied: 0, stale: 0, duplicate: 0 };

  constructor(
    private readonly redis: Redis,
    private readonly opts: StateOptions = {},
  ) {}

  async handle(event: InventoryEvent, ctx: HandlerContext): Promise<void> {
    await this.apply(event, ctx.dedupMarker);
  }

  async apply(event: InventoryEvent, marker?: { key: string; retentionMs: number }): Promise<ApplyResult> {
    const { keyPrefix } = this.opts;
    // Cross-pharmacy index first, in its own slot, so it can never be missing an entry the state has. If we crash
    // before the state change, the retry repeats this (SADD is idempotent); the extra entry is filtered on read.
    if (event.eventType !== "MEDICINE_REMOVED") {
      await this.redis.sadd(medicineIndexKey(event.medicineId, keyPrefix), event.pharmacyId);
    }
    const quantity = "quantityAfter" in event && event.quantityAfter !== undefined ? String(event.quantityAfter) : "";
    const price = "price" in event && event.price !== undefined ? String(event.price) : "";
    const code = Number(
      await this.redis.eval(
        APPLY,
        4,
        marker?.key ?? dedupKey(event.pharmacyId, event.eventId, keyPrefix), // untouched when there is no marker
        inventoryItemKey(event.pharmacyId, event.medicineId, keyPrefix),
        inventoryIndexKey(event.pharmacyId, keyPrefix),
        syncStatusKey(event.pharmacyId, keyPrefix),
        event.eventType,
        String(Date.parse(event.timestamp)),
        quantity,
        price,
        event.medicineId,
        event.eventId,
        marker ? String(marker.retentionMs) : "",
      ),
    );
    const result: ApplyResult = code === 1 ? "applied" : code === 0 ? "stale" : "duplicate";
    this.stats[result]++;
    return result;
  }

  async getItem(pharmacyId: string, medicineId: string): Promise<InventoryItem | null> {
    const h = await this.redis.hgetall(inventoryItemKey(pharmacyId, medicineId, this.opts.keyPrefix));
    if (!h.quantityTs && !h.priceTs) return null;
    return toItem(pharmacyId, medicineId, h);
  }

  /**
   * Every pharmacy that currently lists a medicine, with its stock and price. The index only says "may stock";
   * each pharmacy's own item decides, so entries for removed or unknown items are skipped.
   * Reads one key per pharmacy (each in its own slot), so it costs one round trip per pharmacy in the index.
   */
  async pharmaciesWithMedicine(medicineId: string): Promise<InventoryItem[]> {
    const ids = (await this.redis.smembers(medicineIndexKey(medicineId, this.opts.keyPrefix))).sort();
    const items = await Promise.all(ids.map((id) => this.getItem(id, medicineId)));
    return items.filter((i): i is InventoryItem => i !== null && !i.removed);
  }

  /** All medicines a pharmacy currently lists. */
  async listItems(pharmacyId: string): Promise<InventoryItem[]> {
    const ids = (await this.redis.smembers(inventoryIndexKey(pharmacyId, this.opts.keyPrefix))).sort();
    const items = await Promise.all(ids.map((id) => this.getItem(pharmacyId, id)));
    return items.filter((i): i is InventoryItem => i !== null && !i.removed);
  }
}

const iso = (ms: string | undefined) => (ms ? new Date(Number(ms)).toISOString() : null);

function toItem(pharmacyId: string, medicineId: string, h: Record<string, string>): InventoryItem {
  return {
    pharmacyId,
    medicineId,
    quantity: Number(h.quantity ?? 0),
    price: h.price === undefined ? null : Number(h.price),
    removed: h.removed === "1",
    quantityAsOf: iso(h.quantityTs),
    priceAsOf: iso(h.priceTs),
    lastEventId: h.lastEventId ?? null,
  };
}

/** Runs several handlers in order. The last one decides whether the dedup marker is committed atomically. */
export class CompositeHandler implements EventHandler {
  readonly commitsDedupMarker: boolean;

  constructor(private readonly handlers: EventHandler[]) {
    this.commitsDedupMarker = handlers.at(-1)?.commitsDedupMarker ?? false;
  }

  async handle(event: InventoryEvent, ctx: HandlerContext): Promise<void> {
    for (const h of this.handlers) await h.handle(event, ctx);
  }
}
