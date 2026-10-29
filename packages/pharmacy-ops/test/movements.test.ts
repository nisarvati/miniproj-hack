import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { PharmacySimulator, SimulatorError } from "../src/index.js";

let admin: Db;
let pools: Record<string, Db>;
let urls: Record<string, string>;
let sim: PharmacySimulator;
const P1 = "P001";
const P2 = "P002";

beforeAll(async () => {
  admin = await freshSeededDb();
  urls = await freshPharmacyDbs(admin);
  pools = { P001: createPool(urls.P001!), P002: createPool(urls.P002!) };
  sim = new PharmacySimulator(pools);
});
afterAll(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await admin.end();
});
beforeEach(async () => {
  for (const code of [P1, P2]) {
    await pools[code]!.query("DELETE FROM inventory");
    await setupPharmacyDatabase(code, urls[code]!);
    await pools[code]!.query("UPDATE inventory SET quantity = 5 WHERE medicine_code IN ('M001', 'M002')");
    await pools[code]!.query("TRUNCATE outbox, inventory_movements");
  }
});

const qty = async (code: string, med: string) => (await pools[code]!.query("SELECT quantity FROM inventory WHERE medicine_code = $1", [med])).rows[0]?.quantity as number | undefined;
const outbox = async (code = P1) => (await pools[code]!.query("SELECT event_id, event_type, medicine_code, quantity_delta, quantity_after FROM outbox ORDER BY id")).rows;
const movements = async (code = P1) => (await pools[code]!.query("SELECT * FROM inventory_movements ORDER BY id")).rows;
const refusal = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as SimulatorError;
const KEY = (n: string) => `key-${n}-0000000000`;

describe("recorded sale", () => {
  it("takes the units off, writes one movement, and records the outbox event the movement points to", async () => {
    const r = await sim.recordSale(P1, "M001", 2, { actorUserId: 7 });
    expect(r.replayed).toBe(false);
    expect(r.movement).toMatchObject({ pharmacyCode: P1, medicineCode: "M001", operation: "SALE", source: "TRANSACTION", quantityDelta: -2, quantityBefore: 5, quantityAfter: 3, actorUserId: 7, idempotencyKey: null });
    expect(r.movement!.movementId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await qty(P1, "M001")).toBe(3);

    const events = await outbox();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "SALE", medicine_code: "M001", quantity_delta: -2, quantity_after: 3 });
    expect(r.movement!.eventId).toBe(events[0].event_id); // history can be followed to the event downstream
    expect(await movements()).toHaveLength(1);
    expect(r.change!.events.map((e) => e.eventType)).toEqual(["SALE"]);
  });

  it("refuses to oversell and leaves no movement, no event and the stock as it was", async () => {
    const err = await refusal(sim.recordSale(P1, "M001", 6));
    expect(err).toBeInstanceOf(SimulatorError);
    expect(err.code).toBe("INSUFFICIENT_STOCK");
    expect(await qty(P1, "M001")).toBe(5);
    expect(await movements()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
    // Selling exactly what is there is fine, and stock never goes below zero.
    expect((await sim.recordSale(P1, "M001", 5)).movement).toMatchObject({ quantityAfter: 0 });
    expect((await refusal(sim.recordSale(P1, "M001", 1))).code).toBe("INSUFFICIENT_STOCK");
    expect(await qty(P1, "M001")).toBe(0);
  });

  it.each([0, -1, 1.5, Number.NaN, 1e9, Number.POSITIVE_INFINITY])("rejects the quantity %s without touching anything", async (bad) => {
    expect((await refusal(sim.recordSale(P1, "M001", bad))).code).toBe("INVALID");
    expect(await qty(P1, "M001")).toBe(5);
    expect(await movements()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  it("cannot sell a medicine the pharmacy does not carry, even if another pharmacy does", async () => {
    await sim.removeMedicine(P1, "M002");
    await pools[P1]!.query("TRUNCATE outbox, inventory_movements");
    expect((await refusal(sim.recordSale(P1, "M002", 1))).code).toBe("NOT_STOCKED");
    expect(await qty(P2, "M002")).toBe(5); // still on P002's shelf
    expect((await refusal(sim.recordSale(P1, "M999", 1))).code).toBe("NOT_STOCKED");
    expect(await movements()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  it("cannot oversell under concurrent requests", async () => {
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => sim.recordSale(P1, "M001", 1)));
    const done = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(done).toHaveLength(5);
    expect(refused).toHaveLength(7);
    expect(refused.every((r) => (r.reason as SimulatorError).code === "INSUFFICIENT_STOCK")).toBe(true);
    expect(await qty(P1, "M001")).toBe(0);
    const rows = await movements();
    expect(rows).toHaveLength(5);
    expect(rows.reduce((n, r) => n + r.quantity_delta, 0)).toBe(-5);
    expect(new Set(rows.map((r) => r.quantity_after))).toEqual(new Set([4, 3, 2, 1, 0])); // each saw what the one before left
    expect((await outbox()).filter((e) => e.event_type === "SALE")).toHaveLength(5);
  });

  it("is atomic: if the movement cannot be written, the stock change and its outbox event are rolled back too", async () => {
    await pools[P1]!.query(`
      CREATE FUNCTION fail_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'movement refused'; END; $$;
      CREATE TRIGGER fail_movement BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION fail_movement()`);
    try {
      const err = (await sim.recordSale(P1, "M001", 2).then(() => null, (e: unknown) => e)) as Error;
      expect(err.message).toMatch(/movement refused/);
      expect(await qty(P1, "M001")).toBe(5);
      expect(await outbox()).toHaveLength(0);
      expect(await movements()).toHaveLength(0);
    } finally {
      await pools[P1]!.query("DROP TRIGGER fail_movement ON inventory_movements; DROP FUNCTION fail_movement()");
    }
    expect((await sim.recordSale(P1, "M001", 2)).movement!.quantityAfter).toBe(3); // and it works again afterwards
  });
});

describe("recorded restock", () => {
  it("adds the units, writes a RESTOCK movement and a RESTOCK outbox event that agree", async () => {
    const r = await sim.recordRestock(P1, "M001", 10, { actorUserId: 3 });
    expect(r.movement).toMatchObject({ operation: "RESTOCK", source: "TRANSACTION", quantityDelta: 10, quantityBefore: 5, quantityAfter: 15, actorUserId: 3 });
    expect(await qty(P1, "M001")).toBe(15);
    const events = await outbox();
    expect(events).toEqual([expect.objectContaining({ event_type: "RESTOCK", quantity_delta: 10, quantity_after: 15, event_id: r.movement!.eventId })]);
  });

  it.each([0, -3, 2.5, Number.NaN])("rejects the quantity %s", async (bad) => {
    expect((await refusal(sim.recordRestock(P1, "M001", bad))).code).toBe("INVALID");
    expect(await qty(P1, "M001")).toBe(5);
    expect(await movements()).toHaveLength(0);
  });

  it("rejects stock beyond the limit, and a medicine the pharmacy does not carry", async () => {
    expect((await refusal(sim.recordRestock(P1, "M001", 1_000_000))).code).toBe("INVALID");
    await sim.removeMedicine(P1, "M002");
    await pools[P1]!.query("TRUNCATE outbox, inventory_movements");
    expect((await refusal(sim.recordRestock(P1, "M002", 1))).code).toBe("NOT_STOCKED");
    expect(await qty(P2, "M002")).toBe(5);
    expect(await movements()).toHaveLength(0);
    expect(await outbox()).toHaveLength(0);
  });

  it("is atomic like a sale", async () => {
    await pools[P1]!.query(`
      CREATE FUNCTION fail_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'movement refused'; END; $$;
      CREATE TRIGGER fail_movement BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION fail_movement()`);
    try {
      await expect(sim.recordRestock(P1, "M001", 4)).rejects.toThrow(/movement refused/);
      expect(await qty(P1, "M001")).toBe(5);
      expect(await outbox()).toHaveLength(0);
    } finally {
      await pools[P1]!.query("DROP TRIGGER fail_movement ON inventory_movements; DROP FUNCTION fail_movement()");
    }
  });
});

describe("recorded stock count", () => {
  it("records the correction by direction, marks it as a count, and records nothing when nothing changed", async () => {
    const down = await sim.recordCount(P1, "M001", 2, { actorUserId: 1 });
    expect(down.movement).toMatchObject({ operation: "SALE", source: "STOCK_COUNT", quantityDelta: -3, quantityBefore: 5, quantityAfter: 2 });
    const up = await sim.recordCount(P1, "M001", 9);
    expect(up.movement).toMatchObject({ operation: "RESTOCK", source: "STOCK_COUNT", quantityDelta: 7 });
    const same = await sim.recordCount(P1, "M001", 9);
    expect(same.movement).toBeNull();
    expect(same.change!.events).toEqual([]);
    expect(await movements()).toHaveLength(2);
    expect((await outbox()).map((e) => e.event_type)).toEqual(["SALE", "RESTOCK"]);
  });
});

describe("idempotent retries", () => {
  it("applies a request once however many times it is sent, and hands back the original movement", async () => {
    const first = await sim.recordSale(P1, "M001", 2, { idempotencyKey: KEY("a") });
    const again = await sim.recordSale(P1, "M001", 2, { idempotencyKey: KEY("a") });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.change).toBeNull();
    expect(again.movement).toEqual(first.movement);
    expect(await qty(P1, "M001")).toBe(3);
    expect(await movements()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });

  it("answers a replay with the original even after the stock has moved on or would no longer allow it", async () => {
    await sim.recordSale(P1, "M001", 5, { idempotencyKey: KEY("b") }); // takes all of it
    const again = await sim.recordSale(P1, "M001", 5, { idempotencyKey: KEY("b") }); // a fresh sale would be refused
    expect(again.replayed).toBe(true);
    expect(again.movement).toMatchObject({ quantityAfter: 0 });
    expect(await qty(P1, "M001")).toBe(0);
  });

  it("refuses the same key for a different request, whatever differs, and changes nothing", async () => {
    await sim.recordSale(P1, "M001", 2, { idempotencyKey: KEY("c") });
    for (const attempt of [
      () => sim.recordSale(P1, "M001", 3, { idempotencyKey: KEY("c") }), // another quantity
      () => sim.recordSale(P1, "M002", 2, { idempotencyKey: KEY("c") }), // another medicine
      () => sim.recordRestock(P1, "M001", 2, { idempotencyKey: KEY("c") }), // another operation
    ]) {
      expect((await refusal(attempt())).code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(await qty(P1, "M001")).toBe(3);
    expect(await qty(P1, "M002")).toBe(5);
    expect(await movements()).toHaveLength(1);
  });

  it("applies exactly one of several identical requests that arrive at the same time", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => sim.recordSale(P1, "M001", 2, { idempotencyKey: KEY("d") })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(5);
    expect(new Set(results.map((r) => r.movement!.movementId)).size).toBe(1);
    expect(await qty(P1, "M001")).toBe(3);
    expect(await movements()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });

  it("lets only one of two concurrent requests that reuse a key for different medicines through", async () => {
    const results = await Promise.allSettled([sim.recordSale(P1, "M001", 1, { idempotencyKey: KEY("e") }), sim.recordSale(P1, "M002", 1, { idempotencyKey: KEY("e") })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect((lost.reason as SimulatorError).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await movements()).toHaveLength(1);
    expect((await outbox()).length).toBe(1);
    expect((await qty(P1, "M001"))! + (await qty(P1, "M002"))!).toBe(9); // one unit sold in total
  });

  it("does not remember a request that failed: the same key works once the problem is gone", async () => {
    expect((await refusal(sim.recordSale(P1, "M001", 9, { idempotencyKey: KEY("f") }))).code).toBe("INSUFFICIENT_STOCK");
    await sim.recordRestock(P1, "M001", 10);
    const r = await sim.recordSale(P1, "M001", 9, { idempotencyKey: KEY("f") });
    expect(r.replayed).toBe(false);
    expect(await qty(P1, "M001")).toBe(6);
  });

  it("keeps keys apart per pharmacy, and rejects a malformed key", async () => {
    await sim.recordSale(P1, "M001", 1, { idempotencyKey: KEY("g") });
    const other = await sim.recordSale(P2, "M001", 1, { idempotencyKey: KEY("g") });
    expect(other.replayed).toBe(false);
    expect(await qty(P2, "M001")).toBe(4);
    for (const bad of ["short", "has spaces in it", "x".repeat(101), "bad/char/key!"]) {
      expect((await refusal(sim.recordSale(P1, "M001", 1, { idempotencyKey: bad }))).code).toBe("INVALID");
    }
  });
});

describe("movement history", () => {
  it("is durable, newest first, with correct before and after values", async () => {
    await sim.recordSale(P1, "M001", 1);
    await sim.recordRestock(P1, "M001", 10);
    await sim.recordSale(P1, "M002", 2);
    const { items, total } = await sim.history(P1, { limit: 10, offset: 0 });
    expect(total).toBe(3);
    expect(items.map((m) => [m.medicineCode, m.operation, m.quantityDelta, m.quantityBefore, m.quantityAfter])).toEqual([
      ["M002", "SALE", -2, 5, 3],
      ["M001", "RESTOCK", 10, 4, 14],
      ["M001", "SALE", -1, 5, 4],
    ]);
    // Read back through a brand new connection: it is in the database, not in memory.
    const fresh = new PharmacySimulator({ P001: createPool(urls.P001!) });
    expect((await fresh.history(P1, { limit: 10, offset: 0 })).total).toBe(3);
  });

  it("orders movements with the same timestamp by id, so the order never changes", async () => {
    await pools[P1]!.query(
      `INSERT INTO inventory_movements (medicine_code, operation, source, quantity_delta, quantity_before, quantity_after, occurred_at)
       SELECT 'M001', 'RESTOCK', 'TRANSACTION', 1, n, n + 1, '2026-01-01T00:00:00Z' FROM generate_series(1, 5) n`,
    );
    const a = (await sim.history(P1, { limit: 10, offset: 0 })).items.map((m) => m.quantityBefore);
    const b = (await sim.history(P1, { limit: 10, offset: 0 })).items.map((m) => m.quantityBefore);
    expect(a).toEqual([5, 4, 3, 2, 1]);
    expect(b).toEqual(a);
  });

  it("pages without overlap or gaps", async () => {
    for (let i = 0; i < 5; i++) await sim.recordRestock(P1, "M001", 1);
    const page = async (offset: number) => (await sim.history(P1, { limit: 2, offset })).items.map((m) => m.quantityAfter);
    expect([...(await page(0)), ...(await page(2)), ...(await page(4))]).toEqual([10, 9, 8, 7, 6]);
    expect(await page(6)).toEqual([]);
  });

  it("belongs to one pharmacy: another pharmacy's history never shows it", async () => {
    await sim.recordSale(P1, "M001", 1);
    await sim.recordSale(P2, "M001", 2);
    expect((await sim.history(P1, { limit: 10, offset: 0 })).items.map((m) => [m.pharmacyCode, m.quantityDelta])).toEqual([[P1, -1]]);
    expect((await sim.history(P2, { limit: 10, offset: 0 })).items.map((m) => [m.pharmacyCode, m.quantityDelta])).toEqual([[P2, -2]]);
  });

  it("starts empty: stock and outbox events from before tracking are not turned into movements", async () => {
    expect((await outbox()).length + (await qty(P1, "M001"))!).toBeGreaterThan(0); // the pharmacy has stock, and had events before
    await pools[P1]!.query("INSERT INTO outbox (event_type, medicine_code, quantity_delta, quantity_after) VALUES ('SALE', 'M001', -1, 4)"); // an old, untracked change
    expect(await sim.history(P1, { limit: 10, offset: 0 })).toEqual({ items: [], total: 0 });
  });

  it("is enforced by the schema: a movement whose numbers do not add up, or whose direction is wrong, cannot be stored", async () => {
    const insert = (op: string, delta: number, before: number, after: number) =>
      pools[P1]!.query("INSERT INTO inventory_movements (medicine_code, operation, source, quantity_delta, quantity_before, quantity_after) VALUES ('M001', $1, 'TRANSACTION', $2, $3, $4)", [op, delta, before, after]);
    await expect(insert("SALE", -2, 5, 4)).rejects.toThrow(/delta_matches/);
    await expect(insert("SALE", 2, 5, 7)).rejects.toThrow(/direction/);
    await expect(insert("RESTOCK", -2, 5, 3)).rejects.toThrow(/direction/);
    await expect(insert("SALE", -9, 5, -4)).rejects.toThrow();
  });
});
