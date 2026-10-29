import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, seed, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import type { Redis } from "@medlink/redis";
import type { HandlerContext } from "../src/handler.js";
import { createSyncHandler } from "../src/handlers.js";
import { CatalogueMirror } from "../src/mirror.js";
import { connect, deleteKeys, makeEvent, newPrefix } from "./helpers.js";

let db: Db;
let redis: Redis;
let prefix: string;
let mirror: CatalogueMirror;
let handler: ReturnType<typeof createSyncHandler>["handler"];
const ctx: HandlerContext = { streamId: "1-0", deliveries: 1 };

// The seeded rows are stamped "now", so events must be newer than that to be applied to the table.
const base = Date.now() + 60_000;
const at = (s: number) => new Date(base + s * 1000).toISOString();
const ev = (over: Record<string, unknown>) => makeEvent({ pharmacyId: "P001", medicineId: "M001", ...over });
const row = async (pharmacy = "P001", medicine = "M001") =>
  (
    await db.query<{ quantity: number; price: string; updated_at: Date }>(
      `SELECT i.quantity, i.price, i.updated_at FROM inventory i
       JOIN pharmacies p ON p.id = i.pharmacy_id JOIN medicines m ON m.id = i.medicine_id WHERE p.code = $1 AND m.code = $2`,
      [pharmacy, medicine],
    )
  ).rows[0];

beforeAll(async () => {
  db = await freshSeededDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await seed(db);
  redis = connect();
  prefix = newPrefix();
  mirror = new CatalogueMirror(db);
  handler = createSyncHandler(redis, { keyPrefix: prefix, mirror }).handler;
});
afterEach(async () => {
  await deleteKeys(redis, prefix);
  redis.disconnect();
});

describe("CatalogueMirror", () => {
  it("copies sales, restocks and price changes into the central table", async () => {
    await handler.handle(ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 4, price: undefined, timestamp: at(1) }), ctx);
    expect(await row()).toMatchObject({ quantity: 4, price: "25.00" });
    await handler.handle(ev({ eventType: "RESTOCK", quantityDelta: 46, quantityAfter: 50, price: undefined, timestamp: at(2) }), ctx);
    await handler.handle(ev({ eventType: "PRICE_UPDATED", price: 31.5, quantityDelta: undefined, quantityAfter: undefined, timestamp: at(3) }), ctx);
    expect(await row()).toMatchObject({ quantity: 50, price: "31.50" });
    expect((await row())!.updated_at.toISOString()).toBe(at(3));
  });

  it("deletes a removed medicine and brings it back when it is added again", async () => {
    await handler.handle(ev({ eventType: "MEDICINE_REMOVED", quantityDelta: -5, quantityAfter: 0, price: undefined, timestamp: at(1) }), ctx);
    expect(await row()).toBeUndefined();
    await handler.handle(ev({ eventType: "MEDICINE_ADDED", quantityDelta: 7, quantityAfter: 7, price: 40, timestamp: at(2) }), ctx);
    expect(await row()).toMatchObject({ quantity: 7, price: "40.00" });
  });

  it("adds a medicine a pharmacy never had in the central table", async () => {
    await db.query("DELETE FROM inventory WHERE pharmacy_id = (SELECT id FROM pharmacies WHERE code = 'P001') AND medicine_id = (SELECT id FROM medicines WHERE code = 'M015')");
    expect(await row("P001", "M015")).toBeUndefined();
    await handler.handle(ev({ medicineId: "M015", eventType: "MEDICINE_ADDED", quantityDelta: 9, quantityAfter: 9, price: 140, timestamp: at(1) }), ctx);
    expect(await row("P001", "M015")).toMatchObject({ quantity: 9, price: "140.00" });
  });

  it("never lets an older event overwrite a newer one, whichever arrives last", async () => {
    await handler.handle(ev({ eventType: "RESTOCK", quantityDelta: 95, quantityAfter: 100, price: undefined, timestamp: at(10) }), ctx);
    await handler.handle(ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 3, price: undefined, timestamp: at(5) }), ctx);
    expect((await row())!.quantity).toBe(100);
  });

  it("does not let a stale copy overwrite a newer row", async () => {
    await db.query("UPDATE inventory SET quantity = 999, updated_at = $1 WHERE pharmacy_id = (SELECT id FROM pharmacies WHERE code = 'P001') AND medicine_id = (SELECT id FROM medicines WHERE code = 'M001')", [at(100)]);
    await handler.handle(ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 4, price: undefined, timestamp: at(1) }), ctx);
    expect((await row())!.quantity).toBe(999);
  });

  it("is harmless to repeat: a duplicate delivery changes nothing", async () => {
    const e = ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 4, price: undefined, timestamp: at(1) });
    await handler.handle(e, ctx);
    await handler.handle(e, ctx);
    expect(await row()).toMatchObject({ quantity: 4 });
    expect(mirror.stats.failed).toBe(0);
  });

  it("does not report a mirror write for a medicine or pharmacy the central database does not know", async () => {
    const count = async () => (await db.query("SELECT 1 FROM inventory")).rowCount;
    const before = await count();
    const written = mirror.stats.written;
    await handler.handle(ev({ medicineId: "M900", eventType: "MEDICINE_ADDED", quantityAfter: 3, quantityDelta: 3, price: 5, timestamp: at(1) }), ctx);
    await handler.handle(ev({ pharmacyId: "P900", eventType: "MEDICINE_ADDED", quantityAfter: 3, quantityDelta: 3, price: 5, timestamp: at(1) }), ctx);
    expect(await count()).toBe(before);
    expect(mirror.stats.failed).toBe(0); // not a database error...
    expect(mirror.stats.unmatched).toBe(2); // ...but not a success either
    expect(mirror.stats.written).toBe(written); // and never counted as written
  });

  it("still counts a stale or repeated write for a known pharmacy and medicine as fine, not unmatched", async () => {
    await handler.handle(ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 4, price: undefined, timestamp: at(5) }), ctx);
    const unmatched = mirror.stats.unmatched;
    await handler.handle(ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 3, price: undefined, timestamp: at(2) }), ctx); // older than what is stored
    expect(mirror.stats.unmatched).toBe(unmatched);
    // A removal of something the central table does not have is also fine for a known pair.
    await handler.handle(ev({ eventType: "MEDICINE_REMOVED", quantityDelta: -4, quantityAfter: 0, price: undefined, timestamp: at(9) }), ctx);
    await handler.handle(ev({ eventType: "MEDICINE_REMOVED", quantityDelta: 0, quantityAfter: 0, price: undefined, timestamp: at(10) }), ctx);
    expect(mirror.stats.unmatched).toBe(unmatched);
  });

  it("reports an event for a pharmacy with no central row as unmatched in the log", async () => {
    const warnings: object[] = [];
    const m = new CatalogueMirror(db, { warn: (o) => void warnings.push(o) });
    const { handler: h } = createSyncHandler(redis, { keyPrefix: prefix, mirror: m });
    await h.handle(ev({ pharmacyId: "P777", medicineId: "M001", eventType: "MEDICINE_ADDED", quantityAfter: 3, quantityDelta: 3, price: 5, timestamp: at(1) }), ctx);
    expect(m.stats).toMatchObject({ written: 0, unmatched: 1, failed: 0 });
    expect(warnings).toEqual([{ pharmacyId: "P777", medicineId: "M001" }]);
  });

  it("keeps the live state when the central database is down: logs, counts, and does not throw", async () => {
    const warnings: object[] = [];
    const bad = new CatalogueMirror(createPool("postgres://nobody:nopass@127.0.0.1:1/none"), { warn: (o) => void warnings.push(o) });
    const { handler: h, state } = createSyncHandler(redis, { keyPrefix: prefix, mirror: bad });
    await expect(h.handle(ev({ eventType: "SALE", quantityDelta: -1, quantityAfter: 4, price: undefined, timestamp: at(1) }), ctx)).resolves.toBeUndefined();
    expect(bad.stats.failed).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(await state.getItem("P001", "M001")).toMatchObject({ quantity: 4 });
  });
});
