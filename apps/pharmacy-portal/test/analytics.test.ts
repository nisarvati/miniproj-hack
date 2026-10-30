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
    await pharmacies[code]!.query("UPDATE inventory SET quantity = 12");
    await pharmacies[code]!.query("TRUNCATE outbox, inventory_movements, stock_alerts, restock_plans");
  }
});

async function login(email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/portal/login", payload: { email, password } });
  return String(res.headers["set-cookie"]).split(";")[0]!;
}
const call = (method: "GET" | "POST" | "PATCH", url: string, cookie: string, payload?: unknown) => app.inject({ method, url, headers: { cookie }, ...(payload !== undefined && { payload: payload as object }) });
const analytics = async (cookie = a, days = 14) => (await call("GET", `/portal/analytics?days=${days}`, cookie)).json().data;
const sell = (code: string, quantity: number, cookie = a) => call("POST", "/portal/sales", cookie, { medicineCode: code, quantity });
const restock = (code: string, quantity: number, cookie = a) => call("POST", "/portal/restocks", cookie, { medicineCode: code, quantity });
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const snapshot = async (code = "P001") => {
  const q = async (sql: string) => JSON.stringify((await pharmacies[code]!.query(sql)).rows);
  return [await q("SELECT medicine_code, quantity, price, updated_at FROM inventory ORDER BY medicine_code"), await q("SELECT count(*) FROM outbox"), await q("SELECT count(*) FROM inventory_movements"), await q("SELECT count(*) FROM stock_alerts"), await q("SELECT count(*) FROM restock_plans")];
};

describe("GET /portal/analytics", () => {
  it("needs a signed-in pharmacy account and a supported range", async () => {
    expect((await app.inject({ method: "GET", url: "/portal/analytics" })).statusCode).toBe(401);
    expect((await call("GET", "/portal/analytics?days=5", a)).statusCode).toBe(400);
    expect((await call("GET", "/portal/analytics?days=abc", a)).statusCode).toBe(400);
    const ok = await call("GET", "/portal/analytics", a);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.range.days).toBe(14); // the default
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("sums the pharmacy's own recorded sales and restocks per day, and ranks what sold most from sales only", async () => {
    await sell("M001", 5);
    await sell("M001", 3);
    await sell("M003", 2);
    await restock("M002", 10);
    const d = await analytics(a, 7);
    expect(d.pharmacyCode).toBe("P001");
    expect(d.movements.daily).toHaveLength(7);
    const today = d.movements.daily.at(-1);
    expect(today).toMatchObject({ salesUnits: 10, salesTransactions: 3, restockUnits: 10, restockTransactions: 1 });
    expect(d.movements.daily.slice(0, -1).every((x: { salesUnits: number; restockUnits: number }) => x.salesUnits === 0 && x.restockUnits === 0)).toBe(true);
    expect(d.movements.totals).toEqual({ salesUnits: 10, salesTransactions: 3, restockUnits: 10, restockTransactions: 1 });
    expect(d.topSold.items.map((i: { medicineCode: string; units: number }) => [i.medicineCode, i.units])).toEqual([["M001", 8], ["M003", 2]]);
    expect(d.topSold.items[0].medicineName).toMatch(/\w+ \d/); // a name from the catalogue, not only a code
  });

  it("does not count stock-count corrections as sales", async () => {
    await call("PATCH", "/portal/stock/M001", a, { quantity: 4 }); // 12 -> 4: a count, recorded as STOCK_COUNT
    const d = await analytics();
    expect(d.movements.totals.salesUnits).toBe(0);
    expect(d.movements.stockCountAdjustments).toBe(1);
    expect(d.topSold.items).toEqual([]);
  });

  it("filters by date: a movement 10 days ago is in the 14 and 30 day views and not in the 7 day view; one 40 days ago is in none", async () => {
    for (const [days, units] of [[10, 6], [40, 50]] as const) {
      await pharmacies.P001!.query(
        `INSERT INTO inventory_movements (medicine_code, operation, source, quantity_delta, quantity_before, quantity_after, occurred_at) VALUES ('M001', 'SALE', 'TRANSACTION', $1, 100, $2, now() - ($3 || ' days')::interval)`,
        [-units, 100 - units, String(days)],
      );
    }
    const total = async (days: number) => (await analytics(a, days)).movements.totals.salesUnits;
    expect([await total(7), await total(14), await total(30)]).toEqual([0, 6, 6]);
  });

  it("is isolated by pharmacy: P002's staff see none of P001's movements, and the code is the session's, never the request's", async () => {
    await sell("M001", 4);
    const mine = await analytics(a);
    const theirs = await analytics(b);
    expect(mine.movements.totals.salesUnits).toBe(4);
    expect(theirs.pharmacyCode).toBe("P002");
    expect(theirs.movements.totals).toEqual({ salesUnits: 0, salesTransactions: 0, restockUnits: 0, restockTransactions: 0 });
    expect(theirs.topSold.items).toEqual([]);
    const spoof = await call("GET", "/portal/analytics?days=7&pharmacyCode=P001", b);
    expect(spoof.json().data.pharmacyCode).toBe("P002");
  });

  it("describes stock, risk, alerts and plans for this pharmacy as they stand, with consistent totals", async () => {
    await pharmacies.P001!.query("UPDATE inventory SET quantity = 0 WHERE medicine_code = 'M001'");
    await pharmacies.P001!.query("UPDATE inventory SET quantity = 2 WHERE medicine_code = 'M002'");
    await call("GET", "/portal/alerts", a); // staff opening the alerts view brings them up to date
    await pharmacies.P001!.query("INSERT INTO restock_plans (medicine_code, planned_quantity, target_date, status, completed_at) VALUES ('M003', 10, $1, 'PLANNED', NULL), ('M004', 5, $2, 'IN_PROGRESS', NULL), ('M005', 5, $2, 'COMPLETED', now()), ('M006', 5, $2, 'CANCELLED', NULL)", [inDays(-3), inDays(4)]);
    const d = await analytics();
    const rows = (await pharmacies.P001!.query("SELECT quantity FROM inventory")).rows as { quantity: number }[];
    expect(d.stock.total).toBe(rows.length);
    expect(d.stock.outOfStock).toBe(rows.filter((r) => r.quantity <= 0).length);
    expect(d.stock.lowStock).toBe(rows.filter((r) => r.quantity > 0 && r.quantity <= d.stock.threshold).length);
    expect(d.stock.inStock + d.stock.lowStock + d.stock.outOfStock).toBe(d.stock.total);
    expect(Object.values(d.risk.byLevel).reduce((x: number, y) => x + (y as number), 0)).toBe(d.risk.total);
    expect(d.alerts.active).toBe((await pharmacies.P001!.query("SELECT count(*)::int AS n FROM stock_alerts WHERE state = 'ACTIVE'")).rows[0].n);
    expect(d.alerts.active).toBeGreaterThanOrEqual(2);
    expect(d.plans).toEqual({ available: true, byStatus: { PLANNED: 1, IN_PROGRESS: 1, COMPLETED: 1, CANCELLED: 1 }, open: 2, overdue: 1 });
    expect((await analytics(b)).plans.open).toBe(0); // P002 has none of those
  });

  it("changes nothing: stock, outbox, movements, alerts and plans are the same after reading, even when stock is low", async () => {
    await pharmacies.P001!.query("UPDATE inventory SET quantity = 1 WHERE medicine_code = 'M001'");
    const before = await snapshot();
    await analytics(a, 7);
    await analytics(a, 30);
    expect(await snapshot()).toEqual(before);
    expect((await pharmacies.P001!.query("SELECT count(*)::int AS n FROM stock_alerts")).rows[0].n).toBe(0); // reading does not create alerts
  });

  it("answers a section that cannot be read with unavailable, not zero, and the rest still comes through", async () => {
    await pharmacies.P001!.query("DROP TABLE restock_plans");
    try {
      const res = await call("GET", "/portal/analytics", a);
      expect(res.statusCode).toBe(200);
      const d = res.json().data;
      expect(d.plans).toEqual({ available: false, reason: "SCHEMA_OUTDATED" });
      expect(d.movements.available).toBe(true);
      expect(d.stock.available).toBe(true);
    } finally {
      await setupPharmacyDatabase("P001", urls.P001!);
    }
  });
});
