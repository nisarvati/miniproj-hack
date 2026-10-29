import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "../src/index.js";
import { freshPharmacyDbs, freshSeededDb } from "../src/testing.js";

let admin: Db;
let p1: Db;
let url: string;

beforeAll(async () => {
  admin = await freshSeededDb();
  const urls = await freshPharmacyDbs(admin);
  url = urls.P001!;
  p1 = createPool(url);
});
afterAll(async () => {
  await p1.end();
  await admin.end();
});
beforeEach(async () => {
  await setupPharmacyDatabase("P001", url); // known starting stock (also restores anything a test deleted)
  await p1.query("TRUNCATE outbox"); // ...and ignore the events that produced
});

interface OutboxRow {
  event_type: string;
  medicine_code: string;
  quantity_delta: number | null;
  quantity_after: number | null;
  price: string | null;
  event_id: string;
  published_at: Date | null;
}
const outbox = async () => (await p1.query<OutboxRow>("SELECT * FROM outbox ORDER BY id")).rows;
const summary = (r: OutboxRow) => [r.event_type, r.medicine_code, r.quantity_delta, r.quantity_after, r.price];

describe("outbox trigger", () => {
  it("records seeding as MEDICINE_ADDED events (fresh databases start with a full snapshot)", async () => {
    const urls = await freshPharmacyDbs(admin);
    const pool = createPool(urls.P002);
    try {
      const { rows } = await pool.query("SELECT event_type, count(*)::int AS n FROM outbox GROUP BY 1");
      expect(rows).toEqual([{ event_type: "MEDICINE_ADDED", n: 14 }]);
    } finally {
      await pool.end();
    }
  });

  it("a quantity decrease records a SALE with delta, resulting quantity and current price", async () => {
    await p1.query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'"); // 1 -> 0
    expect((await outbox()).map(summary)).toEqual([["SALE", "M001", -1, 0, "25.00"]]);
  });

  it("a quantity increase records a RESTOCK", async () => {
    await p1.query("UPDATE inventory SET quantity = quantity + 10 WHERE medicine_code = 'M001'"); // 1 -> 11
    expect((await outbox()).map(summary)).toEqual([["RESTOCK", "M001", 10, 11, "25.00"]]);
  });

  it("a price change alone records PRICE_UPDATED with no quantity fields", async () => {
    await p1.query("UPDATE inventory SET price = 27.5 WHERE medicine_code = 'M001'");
    expect((await outbox()).map(summary)).toEqual([["PRICE_UPDATED", "M001", null, null, "27.50"]]);
  });

  it("changing price and quantity together records both, price first, and the quantity event carries the new price", async () => {
    await p1.query("UPDATE inventory SET quantity = 5, price = 30 WHERE medicine_code = 'M001'");
    expect((await outbox()).map(summary)).toEqual([
      ["PRICE_UPDATED", "M001", null, null, "30.00"],
      ["RESTOCK", "M001", 4, 5, "30.00"],
    ]);
  });

  it("inserting an item records MEDICINE_ADDED, deleting it records MEDICINE_REMOVED", async () => {
    await p1.query("DELETE FROM inventory WHERE medicine_code = 'M002'");
    await p1.query("INSERT INTO inventory (medicine_code, quantity, price) VALUES ('M002', 9, 33)");
    await p1.query("DELETE FROM inventory WHERE medicine_code = 'M002'");
    const rows = await outbox();
    expect(rows.map(summary)).toEqual([
      ["MEDICINE_REMOVED", "M002", expect.any(Number), 0, null],
      ["MEDICINE_ADDED", "M002", 9, 9, "33.00"],
      ["MEDICINE_REMOVED", "M002", -9, 0, null],
    ]);
  });

  it("an UPDATE that changes nothing relevant records nothing (e.g. touching updated_at)", async () => {
    await p1.query("UPDATE inventory SET updated_at = now() WHERE medicine_code = 'M001'");
    await p1.query("UPDATE inventory SET quantity = quantity WHERE medicine_code = 'M001'");
    expect(await outbox()).toEqual([]);
  });

  it("a multi-row statement records one event per changed row", async () => {
    await p1.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code IN ('M001','M002','M003')");
    const rows = await outbox();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.event_type === "RESTOCK" && r.quantity_delta === 1)).toBe(true);
  });

  it("is atomic with the stock change: a rolled-back transaction leaves no event", async () => {
    const client = await p1.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE inventory SET quantity = quantity + 5 WHERE medicine_code = 'M001'");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await outbox()).toEqual([]);
  });

  it("a rejected change (negative stock) leaves no event", async () => {
    await expect(p1.query("UPDATE inventory SET quantity = -3 WHERE medicine_code = 'M001'")).rejects.toMatchObject({ code: "23514" });
    expect(await outbox()).toEqual([]);
  });

  it("forbids re-keying an item (medicine_code is immutable)", async () => {
    await expect(p1.query("UPDATE inventory SET medicine_code = 'M099' WHERE medicine_code = 'M001'")).rejects.toThrow(/immutable/);
  });

  it("gives every event a unique id and leaves it unpublished", async () => {
    await p1.query("UPDATE inventory SET quantity = quantity + 1 WHERE medicine_code IN ('M001','M002')");
    const rows = await outbox();
    expect(new Set(rows.map((r) => r.event_id)).size).toBe(2);
    expect(rows.every((r) => r.published_at === null)).toBe(true);
  });

  it("only allows known event types in the outbox", async () => {
    await expect(p1.query("INSERT INTO outbox (event_type, medicine_code) VALUES ('THEFT','M001')")).rejects.toMatchObject({ code: "23514" });
  });
});
