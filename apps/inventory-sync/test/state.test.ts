import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dedupKey, eventStreamKey, inventoryItemKey, medicineIndexKey, syncStatusKey } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";
import { DedupHandler } from "../src/dedup.js";
import type { HandlerContext } from "../src/handler.js";
import { silentLogger } from "../src/logger.js";
import { SyncService } from "../src/service.js";
import { CompositeHandler, InventoryStateHandler } from "../src/state.js";
import { connect, deleteKeys, makeEvent, newPrefix, pendingCount, publish, waitFor } from "./helpers.js";

let redis: Redis;
let prefix: string;
let state: InventoryStateHandler;
const services: SyncService[] = [];
const ctx: HandlerContext = { streamId: "1-0", deliveries: 1 };

const at = (s: number) => new Date(Date.UTC(2026, 9, 5, 12, 0, s)).toISOString();
const ev = (over: Record<string, unknown>) => makeEvent({ pharmacyId: "P001", medicineId: "M001", ...over });
const item = () => state.getItem("P001", "M001");

beforeEach(() => {
  redis = connect();
  prefix = newPrefix();
  state = new InventoryStateHandler(redis, { keyPrefix: prefix });
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await deleteKeys(redis, prefix);
  redis.disconnect();
});

describe("InventoryStateHandler", () => {
  it("builds the current state from added, sold, restocked and repriced events", async () => {
    await state.handle(ev({ eventType: "MEDICINE_ADDED", quantityDelta: 20, quantityAfter: 20, price: 10, timestamp: at(1) }), ctx);
    await state.handle(ev({ eventType: "SALE", quantityDelta: -3, quantityAfter: 17, price: undefined, timestamp: at(2) }), ctx);
    await state.handle(ev({ eventType: "RESTOCK", quantityDelta: 10, quantityAfter: 27, price: undefined, timestamp: at(3) }), ctx);
    await state.handle(ev({ eventType: "PRICE_UPDATED", price: 12.5, quantityDelta: undefined, quantityAfter: undefined, timestamp: at(4) }), ctx);
    expect(await item()).toMatchObject({ quantity: 27, price: 12.5, removed: false, quantityAsOf: at(3), priceAsOf: at(4) });
    expect((await state.listItems("P001")).map((i) => i.medicineId)).toEqual(["M001"]);
  });

  it("stores the pharmacy's quantityAfter, so a missed event heals with the next one", async () => {
    await state.handle(ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 50, timestamp: at(1) }), ctx);
    // an event in between was never seen: the delta no longer matches, quantityAfter still wins
    await state.handle(ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 40, timestamp: at(5) }), ctx);
    expect((await item())?.quantity).toBe(40);
  });

  it("ignores an older event that arrives late", async () => {
    await state.handle(ev({ quantityAfter: 5, quantityDelta: -1, timestamp: at(10) }), ctx);
    const result = await state.apply(ev({ quantityAfter: 99, quantityDelta: -1, timestamp: at(3) }));
    expect(result).toBe("stale");
    expect((await item())?.quantity).toBe(5);
    expect(await redis.hget(syncStatusKey("P001", prefix), "staleCount")).toBe("1");
  });

  it("judges quantity and price separately: a late price update is not blocked by a newer sale", async () => {
    await state.handle(ev({ eventType: "MEDICINE_ADDED", quantityDelta: 9, quantityAfter: 9, price: 10, timestamp: at(1) }), ctx);
    await state.handle(ev({ quantityAfter: 8, quantityDelta: -1, price: undefined, timestamp: at(9) }), ctx);
    await state.handle(ev({ eventType: "PRICE_UPDATED", price: 11, quantityDelta: undefined, quantityAfter: undefined, timestamp: at(5) }), ctx);
    expect(await item()).toMatchObject({ quantity: 8, price: 11 });
    // ...but an older price still loses to the newer one
    expect(await state.apply(ev({ eventType: "PRICE_UPDATED", price: 99, quantityDelta: undefined, quantityAfter: undefined, timestamp: at(2) }))).toBe("stale");
    expect((await item())?.price).toBe(11);
  });

  it("keeps a removed medicine out of the listing, and a late older event cannot bring it back", async () => {
    await state.handle(ev({ eventType: "MEDICINE_ADDED", quantityDelta: 4, quantityAfter: 4, price: 10, timestamp: at(1) }), ctx);
    await state.handle(ev({ eventType: "MEDICINE_REMOVED", quantityDelta: -4, quantityAfter: 0, price: undefined, timestamp: at(5) }), ctx);
    expect(await item()).toMatchObject({ quantity: 0, removed: true });
    expect(await state.listItems("P001")).toEqual([]);

    await state.handle(ev({ quantityAfter: 3, quantityDelta: 1, eventType: "RESTOCK", timestamp: at(3) }), ctx); // older
    await state.handle(ev({ quantityAfter: 6, quantityDelta: 2, eventType: "RESTOCK", timestamp: at(7) }), ctx); // newer, but no ADDED
    expect(await item()).toMatchObject({ quantity: 0, removed: true });

    await state.handle(ev({ eventType: "MEDICINE_ADDED", quantityDelta: 12, quantityAfter: 12, price: 9, timestamp: at(8) }), ctx);
    expect(await item()).toMatchObject({ quantity: 12, price: 9, removed: false });
    expect((await state.listItems("P001")).map((i) => i.medicineId)).toEqual(["M001"]);
  });

  it("ends in the same state whatever order the events arrive in", async () => {
    const events = [
      ev({ eventType: "MEDICINE_ADDED", quantityDelta: 10, quantityAfter: 10, price: 10, timestamp: at(1) }),
      ev({ quantityAfter: 8, quantityDelta: -2, price: undefined, timestamp: at(2) }),
      ev({ eventType: "PRICE_UPDATED", price: 14, quantityDelta: undefined, quantityAfter: undefined, timestamp: at(3) }),
      ev({ eventType: "RESTOCK", quantityAfter: 18, quantityDelta: 10, price: undefined, timestamp: at(4) }),
      ev({ quantityAfter: 17, quantityDelta: -1, price: undefined, timestamp: at(5) }),
    ];
    const orders = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 4, 0, 3, 1], [1, 0, 4, 2, 3]];
    for (const order of orders) {
      await deleteKeys(redis, prefix);
      for (const i of order) await state.handle(events[i]!, ctx);
      expect(await item(), `order ${order}`).toMatchObject({ quantity: 17, price: 14, removed: false });
    }
  });

  it("keeps pharmacies and medicines apart", async () => {
    await state.handle(ev({ quantityAfter: 1, quantityDelta: -1, timestamp: at(1) }), ctx);
    await state.handle(ev({ pharmacyId: "P002", quantityAfter: 2, quantityDelta: -1, timestamp: at(1) }), ctx);
    await state.handle(ev({ medicineId: "M002", quantityAfter: 3, quantityDelta: -1, timestamp: at(1) }), ctx);
    expect((await state.getItem("P001", "M001"))?.quantity).toBe(1);
    expect((await state.getItem("P002", "M001"))?.quantity).toBe(2);
    expect((await state.getItem("P001", "M002"))?.quantity).toBe(3);
    expect(await state.getItem("P001", "M404")).toBeNull();
  });
});

describe("dedup and state share one atomic step", () => {
  const make = () =>
    new DedupHandler(redis, new CompositeHandler([state]), { keyPrefix: prefix, retentionMs: 60_000, leaseMs: 5000 });

  it("writes the done marker together with the state change, and a duplicate changes nothing", async () => {
    const h = make();
    const e = ev({ quantityAfter: 7, quantityDelta: -1, timestamp: at(1) });
    await h.handle(e, ctx);
    expect(await redis.get(dedupKey("P001", e.eventId, prefix))).toBe("done");
    expect(await redis.pttl(dedupKey("P001", e.eventId, prefix))).toBeGreaterThan(50_000);
    await h.handle(e, { ...ctx, deliveries: 2 });
    expect(h.stats.duplicates).toBe(1);
    expect(await redis.hget(syncStatusKey("P001", prefix), "appliedCount")).toBe("1");
  });

  it("the script itself refuses an event already marked done, even if the lease check was bypassed", async () => {
    const e = ev({ quantityAfter: 7, quantityDelta: -1, timestamp: at(1) });
    const marker = { key: dedupKey("P001", e.eventId, prefix), retentionMs: 60_000 };
    expect(await state.apply(e, marker)).toBe("applied");
    expect(await state.apply(ev({ ...e, quantityAfter: 1 }), marker)).toBe("duplicate");
    expect((await item())?.quantity).toBe(7);
  });

  it("a stale event is still marked done, so it is not re-evaluated on every retry", async () => {
    const h = make();
    await h.handle(ev({ quantityAfter: 5, quantityDelta: -1, timestamp: at(9) }), ctx);
    const old = ev({ quantityAfter: 99, quantityDelta: -1, timestamp: at(2) });
    await h.handle(old, ctx);
    expect(await redis.get(dedupKey("P001", old.eventId, prefix))).toBe("done");
    expect((await item())?.quantity).toBe(5);
  });
});

describe("state in the running service", () => {
  it("turns a stream of events, including a republished one, into the right current state", async () => {
    const dedup = new DedupHandler(redis, new CompositeHandler([state]), { keyPrefix: prefix });
    const svc = new SyncService(redis, dedup, silentLogger, { keyPrefix: prefix, blockMs: 100, minIdleMs: 150, claimIntervalMs: 40, discoveryIntervalMs: 40 });
    services.push(svc);
    svc.start();

    const added = ev({ eventType: "MEDICINE_ADDED", quantityDelta: 10, quantityAfter: 10, price: 8, timestamp: at(1) });
    const sale = ev({ quantityAfter: 9, quantityDelta: -1, price: undefined, timestamp: at(2) });
    await publish(redis, prefix, added);
    await publish(redis, prefix, sale);
    await publish(redis, prefix, sale); // connector crashed after XADD: same eventId again
    await publish(redis, prefix, ev({ pharmacyId: "P002", quantityAfter: 4, quantityDelta: -1, timestamp: at(3) }));
    await waitFor(() => svc.stats().processed === 4);

    expect(await item()).toMatchObject({ quantity: 9, price: 8 });
    expect((await state.getItem("P002", "M001"))?.quantity).toBe(4);
    expect(state.stats.applied).toBe(3);
    expect(dedup.stats.duplicates).toBe(1);
    expect(await pendingCount(redis, eventStreamKey("P001", prefix))).toBe(0);
    expect(await redis.exists(inventoryItemKey("P001", "M001", prefix))).toBe(1);
  });
});

describe("cross-pharmacy lookup (who has this medicine?)", () => {
  const sale = (pharmacyId: string, q: number, t: number) => ev({ pharmacyId, quantityAfter: q, quantityDelta: -1, timestamp: at(t) });

  it("lists every pharmacy that stocks a medicine, with its own quantity and price", async () => {
    await state.handle(sale("P001", 5, 1), ctx);
    await state.handle(ev({ pharmacyId: "P002", eventType: "MEDICINE_ADDED", quantityDelta: 8, quantityAfter: 8, price: 30, timestamp: at(1) }), ctx);
    await state.handle(sale("P003", 0, 1), ctx);
    await state.handle(ev({ medicineId: "M002", pharmacyId: "P001", quantityAfter: 1, quantityDelta: -1, timestamp: at(1) }), ctx);

    const found = await state.pharmaciesWithMedicine("M001");
    expect(found.map((i) => [i.pharmacyId, i.quantity])).toEqual([["P001", 5], ["P002", 8], ["P003", 0]]);
    expect(found.find((i) => i.pharmacyId === "P002")?.price).toBe(30);
    expect((await state.pharmaciesWithMedicine("M002")).map((i) => i.pharmacyId)).toEqual(["P001"]);
    expect(await state.pharmaciesWithMedicine("M404")).toEqual([]);
  });

  it("drops a pharmacy that removed the medicine, and brings it back when the medicine is added again", async () => {
    await state.handle(sale("P001", 5, 1), ctx);
    await state.handle(sale("P002", 5, 1), ctx);
    await state.handle(ev({ pharmacyId: "P002", eventType: "MEDICINE_REMOVED", quantityDelta: -5, quantityAfter: 0, price: undefined, timestamp: at(2) }), ctx);
    expect((await state.pharmaciesWithMedicine("M001")).map((i) => i.pharmacyId)).toEqual(["P001"]);
    await state.handle(ev({ pharmacyId: "P002", eventType: "MEDICINE_ADDED", quantityDelta: 3, quantityAfter: 3, price: 9, timestamp: at(3) }), ctx);
    expect((await state.pharmaciesWithMedicine("M001")).map((i) => i.pharmacyId)).toEqual(["P001", "P002"]);
  });

  it("ignores an index entry that has no state behind it (a crash between the index write and the state change)", async () => {
    await state.handle(sale("P001", 5, 1), ctx);
    await redis.sadd(medicineIndexKey("M001", prefix), "P009"); // index written, state change never happened
    expect((await state.pharmaciesWithMedicine("M001")).map((i) => i.pharmacyId)).toEqual(["P001"]);
  });

  it("a redelivery after such a crash completes the state change and the index stays correct", async () => {
    const e = sale("P001", 7, 1);
    await redis.sadd(medicineIndexKey("M001", prefix), "P001");
    await state.handle(e, ctx);
    await state.handle(e, ctx); // replay: index write is idempotent, state change is stale-safe
    expect((await state.pharmaciesWithMedicine("M001")).map((i) => [i.pharmacyId, i.quantity])).toEqual([["P001", 7]]);
  });
});
