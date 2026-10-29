import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { parseInventoryEvent, type InventoryEvent } from "@medlink/event-schema";
import { InventoryConnector } from "../src/connector.js";
import { silentLogger } from "../src/logger.js";
import { MemoryPublisher, type EventPublisher } from "../src/publisher.js";

let admin: Db;
let urls: Record<string, string>;
let db: Db; // Pharmacy A (P001)

const connector = (publisher: EventPublisher, over: Partial<ConstructorParameters<typeof InventoryConnector>[0]> = {}) =>
  new InventoryConnector({ pharmacyId: "P001", db, publisher, logger: silentLogger, ...over });

const pending = async () => Number((await db.query("SELECT count(*) FROM outbox WHERE published_at IS NULL AND failed_at IS NULL")).rows[0].count);

beforeAll(async () => {
  admin = await freshSeededDb();
  urls = await freshPharmacyDbs(admin);
  db = createPool(urls.P001);
});
afterAll(async () => {
  await db.end();
  await admin.end();
});
beforeEach(async () => {
  await setupPharmacyDatabase("P001", urls.P001!); // known starting stock
  await db.query("TRUNCATE outbox");
});

describe("database change -> standardized event", () => {
  it("turns a sale at the pharmacy into a valid SALE event", async () => {
    await db.query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'"); // last Crocin: 1 -> 0
    const pub = new MemoryPublisher();
    const result = await connector(pub).runOnce();

    expect(result).toEqual({ published: 1, failed: 0 });
    expect(pub.events).toHaveLength(1);
    expect(pub.events[0]).toMatchObject({
      schemaVersion: 1,
      eventType: "SALE",
      pharmacyId: "P001",
      medicineId: "M001",
      quantityDelta: -1,
      quantityAfter: 0,
      price: 25,
    });
    expect(parseInventoryEvent(pub.events[0]).success).toBe(true);
    expect(Math.abs(Date.now() - Date.parse(pub.events[0]!.timestamp))).toBeLessThan(10_000);
  });

  it("emits the right event for every kind of change, in the order the changes happened", async () => {
    await db.query("UPDATE inventory SET quantity = quantity + 20 WHERE medicine_code = 'M001'");
    await db.query("UPDATE inventory SET price = 26.5 WHERE medicine_code = 'M001'");
    await db.query("DELETE FROM inventory WHERE medicine_code = 'M002'");
    await db.query("INSERT INTO inventory (medicine_code, quantity, price) VALUES ('M002', 4, 31)");
    await db.query("UPDATE inventory SET quantity = quantity - 3 WHERE medicine_code = 'M001'");

    const pub = new MemoryPublisher();
    expect(await connector(pub).runOnce()).toEqual({ published: 5, failed: 0 });
    expect(pub.events.map((e) => e.eventType)).toEqual(["RESTOCK", "PRICE_UPDATED", "MEDICINE_REMOVED", "MEDICINE_ADDED", "SALE"]);
    const by = (t: string) => pub.events.find((e) => e.eventType === t)!;
    expect(by("RESTOCK")).toMatchObject({ quantityDelta: 20, quantityAfter: 21 });
    expect(by("PRICE_UPDATED")).toMatchObject({ price: 26.5 });
    expect(by("MEDICINE_ADDED")).toMatchObject({ medicineId: "M002", quantityDelta: 4, quantityAfter: 4, price: 31 });
    expect(by("SALE")).toMatchObject({ quantityDelta: -3, quantityAfter: 18, price: 26.5 });
    expect(new Set(pub.events.map((e) => e.eventId)).size).toBe(5);
  });

  it("publishes the initial stock snapshot of a freshly seeded pharmacy", async () => {
    await db.query("DELETE FROM inventory");
    await db.query("TRUNCATE outbox");
    await setupPharmacyDatabase("P001", urls.P001!); // re-adds every item, as a brand-new pharmacy would
    const pub = new MemoryPublisher();
    await connector(pub, { batchSize: 100 }).runOnce();
    expect(pub.events).toHaveLength(14);
    expect(pub.events.every((e) => e.eventType === "MEDICINE_ADDED")).toBe(true);
    expect(pub.events.find((e) => e.medicineId === "M001")).toMatchObject({ quantityAfter: 1, price: 25 });
  });
});

describe("delivery semantics", () => {
  it("marks events published, so a second run sends nothing", async () => {
    await db.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code = 'M001'");
    const pub = new MemoryPublisher();
    const c = connector(pub);
    expect((await c.runOnce()).published).toBe(1);
    expect(await pending()).toBe(0);
    expect(await c.runOnce()).toEqual({ published: 0, failed: 0 });
    expect(pub.events).toHaveLength(1);
  });

  it("keeps events pending when publishing fails, and re-sends the SAME eventId afterwards (at-least-once)", async () => {
    await db.query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'");
    let failNext = true;
    const seen: InventoryEvent[] = [];
    const flaky: EventPublisher = {
      async publish(e) {
        seen.push(e);
        if (failNext) throw new Error("broker down");
      },
    };
    const c = connector(flaky);
    await expect(c.runOnce()).rejects.toThrow("broker down");
    expect(await pending()).toBe(1); // not lost

    failNext = false;
    expect(await c.runOnce()).toEqual({ published: 1, failed: 0 });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.eventId).toBe(seen[0]!.eventId);
    expect(await pending()).toBe(0);
  });

  it("on a mid-batch failure, keeps what was already sent and retries only the rest", async () => {
    await db.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code IN ('M001','M002','M003')");
    const delivered: string[] = [];
    let calls = 0;
    const pub: EventPublisher = {
      async publish(e) {
        if (++calls === 2) throw new Error("boom");
        delivered.push(e.medicineId);
      },
    };
    const c = connector(pub);
    await expect(c.runOnce()).rejects.toThrow("boom");
    expect(delivered).toEqual(["M001"]);
    expect(await pending()).toBe(2);

    expect((await c.runOnce()).published).toBe(2);
    expect(delivered).toEqual(["M001", "M002", "M003"]); // M001 not sent twice
  });

  it("parks a row that cannot become a valid event and carries on with the rest", async () => {
    await db.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code = 'M001'");
    // a corrupt row: a SALE with a positive delta
    await db.query("INSERT INTO outbox (event_type, medicine_code, quantity_delta, quantity_after) VALUES ('SALE', 'M002', 5, 5)");
    await db.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code = 'M003'");

    const pub = new MemoryPublisher();
    expect(await connector(pub).runOnce()).toEqual({ published: 2, failed: 1 });
    expect(pub.events.map((e) => e.medicineId)).toEqual(["M001", "M003"]);
    const parked = (await db.query("SELECT failed_at, error FROM outbox WHERE failed_at IS NOT NULL")).rows;
    expect(parked).toHaveLength(1);
    expect(parked[0].error).toMatch(/quantityDelta/);
    expect(await pending()).toBe(0);
    expect(await connector(pub).runOnce()).toEqual({ published: 0, failed: 0 }); // not retried forever
  });

  it("only takes one batch per run, oldest first", async () => {
    for (let i = 0; i < 7; i++) await db.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code = 'M001'");
    const pub = new MemoryPublisher();
    const c = connector(pub, { batchSize: 3 });
    expect((await c.runOnce()).published).toBe(3);
    expect(pub.events.map(after)).toEqual([2, 3, 4]);
    await c.runOnce();
    await c.runOnce();
    expect(pub.events.map(after)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("two connectors on one database never publish the same event twice", async () => {
    for (let i = 0; i < 20; i++) await db.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code = 'M001'");
    const pub = new MemoryPublisher();
    const a = connector(pub, { batchSize: 5 });
    const b = connector(pub, { batchSize: 5 });
    for (let round = 0; round < 3; round++) await Promise.all([a.runOnce(), b.runOnce()]);
    const ids = pub.events.map((e) => e.eventId);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(await pending()).toBe(0);
  });
});

describe("safety checks", () => {
  it("refuses to run against another pharmacy's database", async () => {
    const other = createPool(urls.P002);
    try {
      const wrong = new InventoryConnector({ pharmacyId: "P001", db: other, publisher: new MemoryPublisher(), logger: silentLogger });
      await expect(wrong.runOnce()).rejects.toThrow(/belongs to pharmacy P002/);
    } finally {
      await other.end();
    }
  });

  it("each pharmacy's connector only sees that pharmacy's changes", async () => {
    const p2 = createPool(urls.P002);
    try {
      await p2.query("TRUNCATE outbox");
      await db.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code = 'M001'");
      await p2.query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'");
      const pubA = new MemoryPublisher();
      const pubB = new MemoryPublisher();
      await connector(pubA).runOnce();
      await new InventoryConnector({ pharmacyId: "P002", db: p2, publisher: pubB, logger: silentLogger }).runOnce();
      expect(pubA.events.map((e) => [e.pharmacyId, e.eventType])).toEqual([["P001", "RESTOCK"]]);
      expect(pubB.events.map((e) => [e.pharmacyId, e.eventType])).toEqual([["P002", "SALE"]]);
    } finally {
      await p2.end();
    }
  });
});

describe("failure handling", () => {
  it("reports a pharmacy database outage as an error without losing anything", async () => {
    const dead = createPool("postgres://pharmacy_p001:x@127.0.0.1:1/pharmacy_p001");
    const c = new InventoryConnector({ pharmacyId: "P001", db: dead, publisher: new MemoryPublisher(), logger: silentLogger });
    await expect(c.runOnce()).rejects.toThrow();
    await dead.end();
  });

  it("the polling loop survives failures, backs off, and delivers once the problem clears", async () => {
    await db.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code = 'M001'");
    let failures = 2;
    const delivered: InventoryEvent[] = [];
    const errors: object[] = [];
    const pub: EventPublisher = {
      async publish(e) {
        if (failures-- > 0) throw new Error("transient");
        delivered.push(e);
      },
    };
    const logger = { ...silentLogger, error: (o: object) => void errors.push(o) };
    const c = connector(pub, { logger, pollIntervalMs: 5, maxBackoffMs: 20 });
    c.start();
    await waitFor(() => delivered.length === 1);
    await c.stop();
    expect(errors.length).toBeGreaterThanOrEqual(2); // the failures were reported, not swallowed
    expect(await pending()).toBe(0);
  });

  it("picks up changes made while it is running, and stop() ends the loop", async () => {
    const pub = new MemoryPublisher();
    const c = connector(pub, { pollIntervalMs: 10 });
    c.start();
    await db.query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'");
    await waitFor(() => pub.events.length === 1);
    expect(pub.events[0]!.eventType).toBe("SALE");
    await c.stop();
    await db.query("UPDATE inventory SET quantity = quantity + 5 WHERE medicine_code = 'M001'");
    await new Promise((r) => setTimeout(r, 50));
    expect(pub.events).toHaveLength(1); // stopped: nothing more published
  });
});

/** quantityAfter exists on every event type except PRICE_UPDATED. */
const after = (e: InventoryEvent) => ("quantityAfter" in e ? e.quantityAfter : undefined);

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
