import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { resolveMedicine, resolvePharmacy, SimulatorError } from "../src/catalogue.js";
import { PharmacySimulator } from "../src/simulator.js";

let admin: Db;
let db: Db;
let url: string;
let sim: PharmacySimulator;
const P = "P001";

beforeAll(async () => {
  admin = await freshSeededDb();
  url = (await freshPharmacyDbs(admin)).P001!;
  db = createPool(url);
  sim = new PharmacySimulator({ [P]: db });
});
afterAll(async () => {
  await db.end();
  await admin.end();
});
beforeEach(async () => {
  await db.query("DELETE FROM inventory");
  await setupPharmacyDatabase(P, url); // starting stock: Crocin 500mg (M001) = 1, price 25.00 ...
  await db.query("TRUNCATE outbox");
  await db.query("UPDATE inventory SET quantity = 5 WHERE medicine_code = 'M001'");
  await db.query("TRUNCATE outbox");
});

const outbox = async () => (await db.query("SELECT event_id, event_type, medicine_code, quantity_delta, quantity_after, price FROM outbox ORDER BY id")).rows;
const row = async (code: string) => (await db.query("SELECT quantity, price FROM inventory WHERE medicine_code = $1", [code])).rows[0];
const refused = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as SimulatorError;

describe("sell", () => {
  it("takes units off the shelf and records exactly one SALE, whose id the caller gets back", async () => {
    const r = await sim.sell(P, "M001", 2);
    expect(r).toMatchObject({ action: "sell", pharmacyCode: P, medicineCode: "M001", medicineName: "Crocin 500mg", before: { quantity: 5 }, after: { quantity: 3 } });
    expect((await row("M001")).quantity).toBe(3);
    const events = await outbox();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "SALE", medicine_code: "M001", quantity_delta: -2, quantity_after: 3 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ eventId: events[0].event_id, eventType: "SALE" });
  });

  it("can sell the very last units", async () => {
    const r = await sim.sell(P, "M001", 5);
    expect(r.after!.quantity).toBe(0);
    expect((await outbox())[0]).toMatchObject({ event_type: "SALE", quantity_after: 0 });
  });

  it("refuses to sell more than is on the shelf: nothing changes and no event is recorded", async () => {
    const err = await refused(sim.sell(P, "M001", 6));
    expect(err).toBeInstanceOf(SimulatorError);
    expect(err.code).toBe("INSUFFICIENT_STOCK");
    expect(err.message).toContain("only 5");
    expect((await row("M001")).quantity).toBe(5);
    expect(await outbox()).toEqual([]);
  });

  it("two sales at the same moment can never oversell", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => sim.sell(P, "M001", 1)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failures.every((f) => (f.reason as SimulatorError).code === "INSUFFICIENT_STOCK")).toBe(true);
    expect((await row("M001")).quantity).toBe(0);
    expect((await outbox()).filter((e) => e.event_type === "SALE")).toHaveLength(5);
  });

  it("each call gets back only its own event, never a neighbour's", async () => {
    const results = await Promise.all([sim.sell(P, "M001", 1), sim.sell(P, "M001", 1), sim.sell(P, "M001", 1)]);
    const ids = results.flatMap((r) => r.events.map((e) => e.eventId));
    expect(results.every((r) => r.events.length === 1)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(new Set((await outbox()).map((e) => e.event_id))).toEqual(new Set(ids));
  });

  it("refuses a medicine the pharmacy does not carry", async () => {
    await db.query("DELETE FROM inventory WHERE medicine_code = 'M002'");
    await db.query("TRUNCATE outbox");
    expect((await refused(sim.sell(P, "M002", 1))).code).toBe("NOT_STOCKED");
    expect(await outbox()).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN, 2_000_000])("rejects the quantity %s", async (q) => {
    expect((await refused(Promise.resolve().then(() => sim.sell(P, "M001", q)))).code).toBe("INVALID");
    expect(await outbox()).toEqual([]);
  });
});

describe("restock", () => {
  it("adds units and records a RESTOCK", async () => {
    const r = await sim.restock(P, "M001", 30);
    expect(r).toMatchObject({ action: "restock", before: { quantity: 5 }, after: { quantity: 35 } });
    expect((await outbox())[0]).toMatchObject({ event_type: "RESTOCK", quantity_delta: 30, quantity_after: 35 });
  });

  it("works from empty (the case that notifies waiting users)", async () => {
    await sim.sell(P, "M001", 5);
    await db.query("TRUNCATE outbox");
    const r = await sim.restock(P, "M001", 12);
    expect(r.after!.quantity).toBe(12);
    expect((await outbox())[0]).toMatchObject({ event_type: "RESTOCK", quantity_delta: 12, quantity_after: 12 });
  });

  it("refuses a medicine the pharmacy does not carry, pointing at add", async () => {
    await db.query("DELETE FROM inventory WHERE medicine_code = 'M002'");
    await db.query("TRUNCATE outbox");
    const err = await refused(sim.restock(P, "M002", 5));
    expect(err.code).toBe("NOT_STOCKED");
    expect(err.message).toContain("add");
  });

  it.each([0, -3, 0.5])("rejects the quantity %s", async (q) => {
    expect((await refused(Promise.resolve().then(() => sim.restock(P, "M001", q)))).code).toBe("INVALID");
  });
});

describe("changePrice", () => {
  it("sets the price and records a PRICE_UPDATED, leaving the quantity alone", async () => {
    const r = await sim.changePrice(P, "M001", 27.5);
    expect(r).toMatchObject({ action: "price", before: { price: 25, quantity: 5 }, after: { price: 27.5, quantity: 5 } });
    const events = await outbox();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "PRICE_UPDATED", quantity_delta: null });
    expect(Number(events[0].price)).toBe(27.5);
  });

  it("a price equal to the current one is not a change: no event", async () => {
    const r = await sim.changePrice(P, "M001", 25);
    expect(r.events).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it.each([0, -1, 1.234, NaN, Infinity, 2_000_000])("rejects the price %s", async (price) => {
    expect((await refused(Promise.resolve().then(() => sim.changePrice(P, "M001", price)))).code).toBe("INVALID");
    expect(Number((await row("M001")).price)).toBe(25);
  });

  it("refuses a medicine the pharmacy does not carry", async () => {
    await db.query("DELETE FROM inventory WHERE medicine_code = 'M002'");
    expect((await refused(sim.changePrice(P, "M002", 10))).code).toBe("NOT_STOCKED");
  });
});

describe("addMedicine", () => {
  beforeEach(async () => {
    await db.query("DELETE FROM inventory WHERE medicine_code = 'M015'");
    await db.query("TRUNCATE outbox");
  });

  it("starts stocking a catalogue medicine and records a MEDICINE_ADDED", async () => {
    const r = await sim.addMedicine(P, "M015", 20, 140);
    expect(r).toMatchObject({ action: "add", before: null, after: { quantity: 20, price: 140 }, medicineName: "Volini 30g" });
    expect(await row("M015")).toMatchObject({ quantity: 20 });
    expect((await outbox())[0]).toMatchObject({ event_type: "MEDICINE_ADDED", medicine_code: "M015", quantity_delta: 20, quantity_after: 20 });
  });

  it("allows a medicine added with no stock yet", async () => {
    expect((await sim.addMedicine(P, "M015", 0, 140)).after!.quantity).toBe(0);
  });

  it("refuses one the pharmacy already carries, pointing at restock", async () => {
    const err = await refused(sim.addMedicine(P, "M001", 5, 25));
    expect(err.code).toBe("ALREADY_STOCKED");
    expect(err.message).toContain("restock");
    expect((await row("M001")).quantity).toBe(5);
  });

  it("refuses a medicine that is not in the MedLink catalogue", async () => {
    expect((await refused(Promise.resolve().then(() => sim.addMedicine(P, "M999", 5, 10)))).code).toBe("UNKNOWN_MEDICINE");
  });

  it("rejects bad numbers", async () => {
    expect((await refused(Promise.resolve().then(() => sim.addMedicine(P, "M015", -1, 10)))).code).toBe("INVALID");
    expect((await refused(Promise.resolve().then(() => sim.addMedicine(P, "M015", 5, 0)))).code).toBe("INVALID");
    expect(await outbox()).toEqual([]);
  });
});

describe("removeMedicine", () => {
  it("stops stocking the medicine and records a MEDICINE_REMOVED for the stock that was on the shelf", async () => {
    const r = await sim.removeMedicine(P, "M001");
    expect(r).toMatchObject({ action: "remove", before: { quantity: 5, price: 25 }, after: null });
    expect(await row("M001")).toBeUndefined();
    expect((await outbox())[0]).toMatchObject({ event_type: "MEDICINE_REMOVED", medicine_code: "M001", quantity_delta: -5, quantity_after: 0 });
  });

  it("can be added back afterwards", async () => {
    await sim.removeMedicine(P, "M001");
    expect((await sim.addMedicine(P, "M001", 8, 26)).after).toEqual({ quantity: 8, price: 26 });
  });

  it("refuses a medicine the pharmacy does not carry", async () => {
    await sim.removeMedicine(P, "M001");
    await db.query("TRUNCATE outbox");
    expect((await refused(sim.removeMedicine(P, "M001"))).code).toBe("NOT_STOCKED");
    expect(await outbox()).toEqual([]);
  });
});

describe("a pharmacy that is not configured", () => {
  it("is refused clearly", async () => {
    expect((await refused(sim.sell("P002", "M001", 1))).code).toBe("UNKNOWN_PHARMACY");
    expect((await refused(sim.sell("P999", "M001", 1))).code).toBe("UNKNOWN_PHARMACY");
  });
});

describe("naming things", () => {
  it("accepts pharmacy codes in any case", () => {
    expect(resolvePharmacy("p004")).toBe("P004");
    expect(() => resolvePharmacy("P999")).toThrow(/Unknown pharmacy/);
  });

  it("accepts a medicine by code or by brand name", () => {
    expect(resolveMedicine("m001")).toBe("M001");
    expect(resolveMedicine("Crocin")).toBe("M001");
    expect(resolveMedicine("croc")).toBe("M001");
    expect(resolveMedicine("  AUGMENTIN ")).toBe("M006");
  });

  it("also knows the products of the expanded catalogue, without changing the demo medicines", () => {
    expect(resolveMedicine("Retaunch")).toMatch(/^M\d{3}$/);
    expect(resolveMedicine("retaunch")).toBe(resolveMedicine("RETAUNCH"));
    expect(resolveMedicine("m100")).toBe("M100");
    expect(resolveMedicine("Dolo")).toBe("M002"); // listed in the batch too, but still one product
    expect(() => resolveMedicine("Viotace")).toThrow(/Unknown medicine/); // held back for manual verification
  });

  it("explains an unknown or ambiguous medicine", () => {
    expect(() => resolveMedicine("M999")).toThrow(/Unknown medicine/);
    expect(() => resolveMedicine("nonsense")).toThrow(/Unknown medicine/);
    expect(() => resolveMedicine("  ")).toThrow(/Name a medicine/);
    expect(() => resolveMedicine("c")).toThrow(/several medicines/); // Crocin, Calpol, Combiflam, Cetzine
  });
});

describe("setQuantity", () => {
  it("records a SALE when the count is lower than the books", async () => {
    const r = await sim.setQuantity(P, "M001", 2);
    expect(r).toMatchObject({ action: "set", before: { quantity: 5 }, after: { quantity: 2 } });
    expect(await outbox()).toMatchObject([{ event_type: "SALE", quantity_delta: -3, quantity_after: 2 }]);
  });

  it("records a RESTOCK when the count is higher", async () => {
    await sim.setQuantity(P, "M001", 12);
    expect(await outbox()).toMatchObject([{ event_type: "RESTOCK", quantity_delta: 7, quantity_after: 12 }]);
  });

  it("can count down to zero, and records nothing when the count matches", async () => {
    await sim.setQuantity(P, "M001", 5);
    expect(await outbox()).toHaveLength(0);
    await sim.setQuantity(P, "M001", 0);
    expect((await row("M001")).quantity).toBe(0);
  });

  it("refuses a bad count or a medicine the pharmacy does not carry, and changes nothing", async () => {
    expect((await refused((async () => sim.setQuantity(P, "M001", -1))())).code).toBe("INVALID");
    expect((await refused((async () => sim.setQuantity(P, "M001", 1.5))())).code).toBe("INVALID");
    await db.query("DELETE FROM inventory WHERE medicine_code = 'M002'");
    await db.query("TRUNCATE outbox");
    expect((await refused(sim.setQuantity(P, "M002", 3))).code).toBe("NOT_STOCKED");
    expect(await outbox()).toHaveLength(0);
  });
});
