import { inventoryIndexKey, inventoryItemKey, medicineIndexKey } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";

/** One medicine at one pharmacy, as the event pipeline last left it. */
export interface LiveItem {
  /** null if no event has carried a quantity yet (only a price update was seen). */
  quantity: number | null;
  /** null until some event carried a price. */
  price: number | null;
  /** When the most recent event that changed it happened at the pharmacy. */
  updatedAt: Date;
  /** The pharmacy stopped stocking it. */
  removed: boolean;
}

/**
 * Current stock as kept by the sync service in Redis (milestones 7 to 10). Search overlays it on the catalogue
 * database so a sale or restock at a pharmacy shows up within a second or two instead of whenever someone edits the
 * central table. Everything here is read-only.
 */
export interface LiveStock {
  /** Live state for the given (pharmacy, medicine) codes. A pair that was never seen is simply absent. */
  getMany(pairs: { pharmacyCode: string; medicineCode: string }[]): Promise<Map<string, LiveItem>>;
  /** Pharmacies that may stock a medicine: a superset hint, each pharmacy's own record is the truth. */
  pharmaciesFor(medicineCode: string): Promise<string[]>;
  /** Everything a pharmacy currently lists, keyed by medicine code. */
  pharmacyItems(pharmacyCode: string): Promise<Map<string, LiveItem>>;
  /** True if Redis answers. */
  ping(): Promise<boolean>;
}

export const liveKey = (pharmacyCode: string, medicineCode: string) => `${pharmacyCode}|${medicineCode}`;

export interface RedisLiveStockOptions {
  keyPrefix?: string;
  /** A slow Redis must never make search slow: give up after this long (the caller falls back). */
  timeoutMs?: number;
}

export class RedisLiveStock implements LiveStock {
  private readonly timeoutMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly opts: RedisLiveStockOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 400;
  }

  async getMany(pairs: { pharmacyCode: string; medicineCode: string }[]): Promise<Map<string, LiveItem>> {
    // One key per pair, each in its own slot on a cluster, so these are separate commands rather than a pipeline.
    const entries = await this.within(
      Promise.all(
        pairs.map(async (p) => {
          const hash = await this.redis.hgetall(inventoryItemKey(p.pharmacyCode, p.medicineCode, this.opts.keyPrefix));
          return [liveKey(p.pharmacyCode, p.medicineCode), parseItem(hash)] as const;
        }),
      ),
    );
    return new Map(entries.filter((e): e is readonly [string, LiveItem] => e[1] !== null));
  }

  async pharmaciesFor(medicineCode: string): Promise<string[]> {
    return this.within(this.redis.smembers(medicineIndexKey(medicineCode, this.opts.keyPrefix)));
  }

  async pharmacyItems(pharmacyCode: string): Promise<Map<string, LiveItem>> {
    // The index holds the medicines the pharmacy lists; removed ones are kept out of it.
    const codes = await this.within(this.redis.smembers(inventoryIndexKey(pharmacyCode, this.opts.keyPrefix)));
    const pairs = codes.map((medicineCode) => ({ pharmacyCode, medicineCode }));
    const items = await this.getMany(pairs);
    return new Map(codes.flatMap((c) => (items.has(liveKey(pharmacyCode, c)) ? [[c, items.get(liveKey(pharmacyCode, c))!] as const] : [])));
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.within(this.redis.ping())) === "PONG";
    } catch {
      return false;
    }
  }

  private within<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`live stock did not answer within ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    // Whichever finishes first; a late answer is ignored (and its rejection swallowed so it cannot crash the process).
    work.catch(() => undefined);
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }
}

function parseItem(h: Record<string, string>): LiveItem | null {
  const quantityTs = Number(h.quantityTs);
  const priceTs = Number(h.priceTs);
  if (!Number.isFinite(quantityTs) && !Number.isFinite(priceTs)) return null; // no record
  const latest = Math.max(Number.isFinite(quantityTs) ? quantityTs : 0, Number.isFinite(priceTs) ? priceTs : 0);
  return {
    quantity: h.quantity === undefined ? null : Number(h.quantity),
    price: h.price === undefined ? null : Number(h.price),
    updatedAt: new Date(latest),
    removed: h.removed === "1",
  };
}
