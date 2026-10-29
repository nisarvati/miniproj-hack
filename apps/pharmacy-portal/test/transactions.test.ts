import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let admin: Db;
let pharmacies: Record<string, Db>;
let urls: Record<string, string>;
let app: FastifyInstance;
let a: string; // P001's session cookie
let b: string; // P002's
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" });

beforeAll(async () => {
  admin = await freshSeededDb();
  urls = await freshPharmacyDbs(admin);
  pharmacies = Object.fromEntries(Object.entries(urls).map(([code, url]) => [code, createPool(url)]));
  await admin.query("DELETE FROM pharmacy_users");
  await admin.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('a@pharmacy.test', $1, 'P001'), ('b@pharmacy.test', $2, 'P002')", [await hashPassword("pw-a"), await hashPassword("pw-b")]);
  app = await buildApp({ db: admin, pharmacies }, config, { logger: false });
  a = await login("a@pharmacy.test", "pw-a");
  b = await login("b@pharmacy.test", "pw-b");
});
afterAll(async () => {
  await app.close();
  await Promise.all(Object.values(pharmacies).map((p) => p.end()));
  await admin.end();
});
beforeEach(async () => {
  for (const code of ["P001", "P002"]) {
    await pharmacies[code]!.query("DELETE FROM inventory");
    await setupPharmacyDatabase(code, urls[code]!);
    await pharmacies[code]!.query("UPDATE inventory SET quantity = 5 WHERE medicine_code IN ('M001', 'M002')");
    await pharmacies[code]!.query("TRUNCATE outbox, inventory_movements");
  }
});

async function login(email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/portal/login", payload: { email, password } });
  return String(res.headers["set-cookie"]).split(";")[0]!;
}
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { cookie, ...headers }, ...(payload !== undefined && { payload: payload as object }) });
const qty = async (code: string, med: string) => (await pharmacies[code]!.query("SELECT quantity FROM inventory WHERE medicine_code = $1", [med])).rows[0]?.quantity as number;
const outbox = async (code = "P001") => (await pharmacies[code]!.query("SELECT event_type, quantity_delta, quantity_after, event_id FROM outbox ORDER BY id")).rows;
const movementRows = async (code = "P001") => (await pharmacies[code]!.query("SELECT * FROM inventory_movements ORDER BY id")).rows;
const KEY = (n: string) => `portal-key-${n}-0000`;

describe("sign-in is required", () => {
  it("for sales, restocks and history", async () => {
    for (const [method, url] of [["POST", "/portal/sales"], ["POST", "/portal/restocks"], ["GET", "/portal/history"]] as const) {
      const res = await app.inject({ method, url, ...(method === "POST" && { payload: { medicineCode: "M001", quantity: 1 } }) });
      expect(res.statusCode).toBe(401);
    }
    expect(await qty("P001", "M001")).toBe(5);
    expect(await movementRows()).toHaveLength(0);
  });
});

describe("POST /portal/sales", () => {
  it("sells, answers with the movement, and the stock, the outbox and the history all agree", async () => {
    const res = await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 2 });
    expect(res.statusCode).toBe(201);
    const { data, meta } = res.json();
    expect(meta).toEqual({ replayed: false });
    expect(data).toMatchObject({ pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", operation: "SALE", source: "TRANSACTION", quantity: 2, quantityDelta: -2, quantityBefore: 5, quantityAfter: 3, byYou: true });
    expect(data.movementId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(data.occurredAt).getTime()).not.toBeNaN();
    expect(await qty("P001", "M001")).toBe(3);
    expect(await outbox()).toEqual([expect.objectContaining({ event_type: "SALE", quantity_delta: -2, quantity_after: 3, event_id: data.eventId })]);
    const history = (await call("GET", "/portal/history", a)).json();
    expect(history.data).toHaveLength(1);
    expect(history.data[0]).toMatchObject({ movementId: data.movementId, quantityDelta: -2, quantityAfter: 3 });
    expect(JSON.stringify(res.json())).not.toMatch(/a@pharmacy\.test|password|scrypt/);
  });

  it("answers 409 INSUFFICIENT_STOCK for more than is on the shelf, and records nothing", async () => {
    const res = await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 6 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INSUFFICIENT_STOCK");
    expect(await qty("P001", "M001")).toBe(5);
    expect(await outbox()).toHaveLength(0);
    expect(await movementRows()).toHaveLength(0);
  });

  it.each([
    ["zero", { medicineCode: "M001", quantity: 0 }],
    ["negative", { medicineCode: "M001", quantity: -2 }],
    ["fractional", { medicineCode: "M001", quantity: 1.5 }],
    ["a string", { medicineCode: "M001", quantity: "2" }],
    ["missing", { medicineCode: "M001" }],
    ["a huge number", { medicineCode: "M001", quantity: 1e12 }],
    ["a bad medicine code", { medicineCode: "crocin", quantity: 1 }],
    ["no medicine", { quantity: 1 }],
    ["an extra pharmacy field", { medicineCode: "M001", quantity: 1, pharmacyCode: "P002" }],
    ["an extra field", { medicineCode: "M001", quantity: 1, note: "x" }],
  ])("rejects %s with 400 and changes nothing", async (_name, payload) => {
    const res = await call("POST", "/portal/sales", a, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(await qty("P001", "M001")).toBe(5);
    expect(await qty("P002", "M001")).toBe(5);
    expect(await movementRows()).toHaveLength(0);
  });

  it("answers 404 NOT_STOCKED for a medicine the pharmacy does not carry", async () => {
    await call("DELETE", "/portal/stock/M002", a);
    await pharmacies.P001!.query("TRUNCATE outbox, inventory_movements");
    const res = await call("POST", "/portal/sales", a, { medicineCode: "M002", quantity: 1 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_STOCKED");
    expect((await call("POST", "/portal/sales", a, { medicineCode: "M999", quantity: 1 })).json().error.code).toBe("NOT_STOCKED");
    expect(await qty("P002", "M002")).toBe(5); // P002 still has it; P001 could not touch it
    expect(await movementRows()).toHaveLength(0);
  });

  it("cannot oversell when requests arrive at the same time", async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 1 })));
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(5);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect(await qty("P001", "M001")).toBe(0);
    expect(await movementRows()).toHaveLength(5);
    expect(await outbox()).toHaveLength(5);
  });
});

describe("POST /portal/restocks", () => {
  it("adds stock, and the stock, the outbox and the history agree", async () => {
    const res = await call("POST", "/portal/restocks", a, { medicineCode: "M001", quantity: 10 });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ operation: "RESTOCK", quantity: 10, quantityDelta: 10, quantityBefore: 5, quantityAfter: 15, medicineName: "Crocin 500mg" });
    expect(await qty("P001", "M001")).toBe(15);
    expect(await outbox()).toEqual([expect.objectContaining({ event_type: "RESTOCK", quantity_delta: 10, quantity_after: 15, event_id: res.json().data.eventId })]);
  });

  it.each([{ quantity: 0 }, { quantity: -1 }, { quantity: 2.5 }, { quantity: "3" }, {}])("rejects %j", async (bad) => {
    const res = await call("POST", "/portal/restocks", a, { medicineCode: "M001", ...bad });
    expect(res.statusCode).toBe(400);
    expect(await qty("P001", "M001")).toBe(5);
    expect(await movementRows()).toHaveLength(0);
  });

  it("answers 404 for a medicine the pharmacy does not carry, and 400 past the stock limit", async () => {
    expect((await call("POST", "/portal/restocks", a, { medicineCode: "M999", quantity: 1 })).statusCode).toBe(404);
    expect((await call("POST", "/portal/restocks", a, { medicineCode: "M001", quantity: 1_000_000 })).statusCode).toBe(400);
    expect(await outbox()).toHaveLength(0);
  });
});

describe("one pharmacy cannot reach another", () => {
  it("a sale, a restock and the history are always the signed-in pharmacy's, whatever the request says", async () => {
    // The pharmacy is not a parameter: a body field is refused, a query parameter is ignored.
    expect((await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 1, pharmacyCode: "P002" })).statusCode).toBe(400);
    expect((await call("POST", "/portal/sales?pharmacyCode=P002", a, { medicineCode: "M001", quantity: 1 }, { "x-pharmacy-code": "P002" })).statusCode).toBe(201);
    expect(await qty("P001", "M001")).toBe(4);
    expect(await qty("P002", "M001")).toBe(5);

    await call("POST", "/portal/restocks", b, { medicineCode: "M001", quantity: 7 });
    expect(await qty("P002", "M001")).toBe(12);
    expect(await qty("P001", "M001")).toBe(4);

    const historyOf = async (cookie: string, qs = "") => (await call("GET", `/portal/history${qs}`, cookie)).json().data as { pharmacyCode: string; quantityDelta: number }[];
    expect((await historyOf(a)).map((m) => [m.pharmacyCode, m.quantityDelta])).toEqual([["P001", -1]]);
    expect((await historyOf(b)).map((m) => [m.pharmacyCode, m.quantityDelta])).toEqual([["P002", 7]]);
    expect(await historyOf(a, "?pharmacyCode=P002")).toEqual(await historyOf(a)); // ignored
    expect((await historyOf(b, "?pharmacyCode=P001")).map((m) => m.pharmacyCode)).toEqual(["P002"]);
  });

  it("an idempotency key used at one pharmacy has no effect on another", async () => {
    await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 1 }, { "idempotency-key": KEY("x") });
    const res = await call("POST", "/portal/sales", b, { medicineCode: "M001", quantity: 1 }, { "idempotency-key": KEY("x") });
    expect(res.statusCode).toBe(201);
    expect(res.json().meta.replayed).toBe(false);
    expect(await qty("P002", "M001")).toBe(4);
  });

  it("byYou is false for a colleague's movement and nobody's email is shown", async () => {
    await admin.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('c@pharmacy.test', $1, 'P001')", [await hashPassword("pw-c")]);
    const c = await login("c@pharmacy.test", "pw-c");
    await call("POST", "/portal/sales", c, { medicineCode: "M001", quantity: 1 });
    const res = await call("GET", "/portal/history", a);
    expect(res.json().data[0].byYou).toBe(false);
    expect(res.body).not.toMatch(/@pharmacy\.test/);
    await admin.query("DELETE FROM pharmacy_users WHERE email = 'c@pharmacy.test'");
  });
});

describe("the Idempotency-Key header", () => {
  it("makes a retried request return the original instead of selling twice", async () => {
    const first = await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 2 }, { "idempotency-key": KEY("1") });
    const retry = await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 2 }, { "idempotency-key": KEY("1") });
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().meta).toEqual({ replayed: true });
    expect(retry.json().data).toEqual(first.json().data);
    expect(await qty("P001", "M001")).toBe(3);
    expect(await movementRows()).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });

  it("refuses the same key with a different request: 422 IDEMPOTENCY_KEY_REUSED", async () => {
    await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 2 }, { "idempotency-key": KEY("2") });
    for (const [url, body] of [
      ["/portal/sales", { medicineCode: "M001", quantity: 3 }],
      ["/portal/sales", { medicineCode: "M002", quantity: 2 }],
      ["/portal/restocks", { medicineCode: "M001", quantity: 2 }],
    ] as const) {
      const res = await call("POST", url, a, body, { "idempotency-key": KEY("2") });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(await qty("P001", "M001")).toBe(3);
    expect(await movementRows()).toHaveLength(1);
  });

  it("applies one of several identical requests sent at once", async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => call("POST", "/portal/restocks", a, { medicineCode: "M001", quantity: 4 }, { "idempotency-key": KEY("3") })));
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(4);
    expect(await qty("P001", "M001")).toBe(9);
    expect(await movementRows()).toHaveLength(1);
  });

  it("rejects a malformed key, and without a key every request is its own", async () => {
    for (const bad of ["short", "contains spaces here", "x".repeat(101)]) {
      expect((await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 1 }, { "idempotency-key": bad })).statusCode).toBe(400);
    }
    expect(await qty("P001", "M001")).toBe(5);
    await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 1 });
    await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 1 });
    expect(await qty("P001", "M001")).toBe(3);
  });
});

describe("GET /portal/history", () => {
  const seedMovements = async () => {
    await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 1 });
    await call("POST", "/portal/restocks", a, { medicineCode: "M001", quantity: 10 });
    await call("POST", "/portal/sales", a, { medicineCode: "M002", quantity: 2 });
    await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 3 });
  };

  it("is newest first with the right before and after values, and starts empty", async () => {
    expect((await call("GET", "/portal/history", a)).json()).toEqual({ data: [], meta: { total: 0, limit: 20, offset: 0, hasMore: false } });
    await seedMovements();
    const { data, meta } = (await call("GET", "/portal/history", a)).json();
    expect(meta).toEqual({ total: 4, limit: 20, offset: 0, hasMore: false });
    expect(data.map((m: { medicineCode: string; operation: string; quantityDelta: number; quantityBefore: number; quantityAfter: number }) => [m.medicineCode, m.operation, m.quantityDelta, m.quantityBefore, m.quantityAfter])).toEqual([
      ["M001", "SALE", -3, 14, 11],
      ["M002", "SALE", -2, 5, 3],
      ["M001", "RESTOCK", 10, 4, 14],
      ["M001", "SALE", -1, 5, 4],
    ]);
    expect(data[0].medicineName).toBe("Crocin 500mg");
  });

  it("pages with a bounded limit and an offset", async () => {
    await seedMovements();
    const page = async (qs: string) => (await call("GET", `/portal/history?${qs}`, a)).json();
    const first = await page("limit=3&offset=0");
    expect(first.data).toHaveLength(3);
    expect(first.meta).toEqual({ total: 4, limit: 3, offset: 0, hasMore: true });
    const second = await page("limit=3&offset=3");
    expect(second.data).toHaveLength(1);
    expect(second.meta.hasMore).toBe(false);
    expect([...first.data, ...second.data].map((m: { movementId: string }) => m.movementId)).toEqual((await page("")).data.map((m: { movementId: string }) => m.movementId));
    expect((await page("offset=50")).data).toEqual([]);
  });

  it.each(["limit=0", "limit=101", "limit=-1", "limit=abc", "limit=1.5", "offset=-1", "offset=abc", "offset=1000000"])("rejects %s with 400", async (qs) => {
    const res = await call("GET", `/portal/history?${qs}`, a);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("includes a stock count made in the portal, marked as a count, but not a price change", async () => {
    await call("PATCH", "/portal/stock/M001", a, { quantity: 8 });
    await call("PATCH", "/portal/stock/M001", a, { price: 30.5 });
    await call("PATCH", "/portal/stock/M001", a, { quantity: 8 }); // no change
    const { data } = (await call("GET", "/portal/history", a)).json();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ operation: "RESTOCK", source: "STOCK_COUNT", quantityDelta: 3, quantityBefore: 5, quantityAfter: 8, byYou: true });
  });

  it("does not turn changes from before tracking into history", async () => {
    // The pharmacy already has outbox events (its starting stock); none of them is a movement.
    await pharmacies.P001!.query("INSERT INTO outbox (event_type, medicine_code, quantity_delta, quantity_after) VALUES ('SALE', 'M001', -1, 4)");
    expect((await call("GET", "/portal/history", a)).json().data).toEqual([]);
  });
});

describe("the events still flow, and a refused change is never announced", () => {
  it("a sale and a restock each leave exactly the outbox event the pipeline expects, and a refusal leaves none", async () => {
    await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 6 }); // refused
    expect(await outbox()).toHaveLength(0);
    await call("POST", "/portal/sales", a, { medicineCode: "M001", quantity: 1 });
    await call("POST", "/portal/restocks", a, { medicineCode: "M001", quantity: 2 });
    expect((await outbox()).map((e) => [e.event_type, e.quantity_delta, e.quantity_after])).toEqual([["SALE", -1, 4], ["RESTOCK", 2, 6]]);
    // A sale is never a RESTOCK (which is what makes patients' restock notifications fire).
    expect((await outbox()).filter((e) => e.event_type === "RESTOCK")).toHaveLength(1);
  });
});
