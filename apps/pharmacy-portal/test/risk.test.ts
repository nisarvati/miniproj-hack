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
const base = { DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" };
const config = loadConfig(base);

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
    await pharmacies[code]!.query("UPDATE inventory SET quantity = 12"); // everything healthy: each test lowers only what it needs
    await pharmacies[code]!.query("TRUNCATE outbox, inventory_movements, stock_alerts");
  }
});

async function login(email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/portal/login", payload: { email, password } });
  return String(res.headers["set-cookie"]).split(";")[0]!;
}
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined && { payload: payload as object }) });
const sell = (cookie: string, medicineCode: string, quantity: number) => call("POST", "/portal/sales", cookie, { medicineCode, quantity });
const alertsOf = async (cookie: string, qs = "") => (await call("GET", `/portal/alerts${qs}`, cookie)).json();
const setQty = (code: string, med: string, n: number) => pharmacies[code]!.query("UPDATE inventory SET quantity = $2 WHERE medicine_code = $1", [med, n]);

describe("authentication", () => {
  it("is required for risk and alerts", async () => {
    for (const url of ["/portal/risk", "/portal/risk/M001", "/portal/alerts"]) expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
  });
});

describe("threshold configuration", () => {
  it("is the existing LOW_STOCK_THRESHOLD, 5 by default, validated", () => {
    expect(loadConfig(base).lowStockThreshold).toBe(5);
    expect(loadConfig({ ...base, LOW_STOCK_THRESHOLD: "12" }).lowStockThreshold).toBe(12);
    for (const bad of ["0", "-3", "2.5", "many", "5000000"]) expect(() => loadConfig({ ...base, LOW_STOCK_THRESHOLD: bad })).toThrow(/LOW_STOCK_THRESHOLD/);
  });
});

describe("GET /portal/risk", () => {
  it("lists the pharmacy's medicines riskiest first, each with its score, threshold, factors and alert", async () => {
    await sell(a, "M001", 12); // 0 left
    await sell(a, "M002", 9); // 3 left
    const res = await call("GET", "/portal/risk", a);
    expect(res.statusCode).toBe(200);
    const { data, meta } = res.json();
    expect(data.slice(0, 2).map((r: { medicineCode: string; score: number; level: string }) => [r.medicineCode, r.score, r.level])).toEqual([["M001", 100, "CRITICAL"], ["M002", 76, "CRITICAL"]]);
    expect(data[0]).toMatchObject({ medicineName: "Crocin 500mg", quantity: 0, threshold: 5, belowThreshold: true, alert: { state: "ACTIVE" } });
    expect(data[0].alert.alertId).toMatch(/^[0-9a-f-]{36}$/);
    expect(data[0].summary).toMatch(/Out of stock/);
    expect(data[0].factors.map((f: { id: string; available: boolean }) => [f.id, f.available])).toEqual([["position", true], ["depth", true], ["demand", false]]);
    expect(data[0].factors.find((f: { id: string }) => f.id === "demand").detail).toMatch(/Not used/);
    expect(data.at(-1)).toMatchObject({ belowThreshold: false, alert: null });
    const scores = data.map((r: { score: number }) => r.score);
    expect([...scores].sort((x: number, y: number) => y - x)).toEqual(scores);
    expect(meta).toMatchObject({ threshold: 5, thresholdSetting: "LOW_STOCK_THRESHOLD", salesSpeedUsed: false, limit: 50, offset: 0, hasMore: false });
    expect(meta.total).toBe(data.length);
  });

  it("is derived from the stock as it is now, including changes made outside the portal", async () => {
    await setQty("P001", "M001", 2); // pharmacy software changed it: MedLink has not seen an event from the portal
    const { data } = (await call("GET", "/portal/risk", a)).json();
    expect(data[0]).toMatchObject({ medicineCode: "M001", score: 84, alert: { state: "ACTIVE" } });
  });

  it("filters by level and pages with bounded limits", async () => {
    await sell(a, "M001", 12);
    await sell(a, "M002", 7); // 5: at the threshold
    const critical = (await call("GET", "/portal/risk?level=CRITICAL", a)).json();
    expect(critical.data.map((r: { medicineCode: string }) => r.medicineCode)).toEqual(["M001"]);
    expect((await call("GET", "/portal/risk?level=HIGH", a)).json().data.map((r: { medicineCode: string }) => r.medicineCode)).toEqual(["M002"]);
    const first = (await call("GET", "/portal/risk?limit=2&offset=0", a)).json();
    const second = (await call("GET", "/portal/risk?limit=2&offset=2", a)).json();
    expect(first.data).toHaveLength(2);
    expect(first.meta.hasMore).toBe(true);
    expect(second.data.map((r: { medicineCode: string }) => r.medicineCode)).not.toEqual(first.data.map((r: { medicineCode: string }) => r.medicineCode));
    expect((await call("GET", "/portal/risk?offset=500", a)).json().data).toEqual([]);
  });

  it.each(["limit=0", "limit=201", "limit=-1", "limit=x", "offset=-1", "offset=9999999", "level=BOGUS", "level=low"])("rejects %s", async (qs) => {
    const res = await call("GET", `/portal/risk?${qs}`, a);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /portal/risk/:code", () => {
  it("explains one medicine", async () => {
    await sell(a, "M001", 9); // 3
    const res = await call("GET", "/portal/risk/M001", a);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ medicineCode: "M001", quantity: 3, threshold: 5, score: 76, level: "CRITICAL", alert: { state: "ACTIVE" } });
    expect(res.json().data.factors[1].detail).toMatch(/2 units short of the threshold of 5/);
    expect(res.json().meta).toMatchObject({ threshold: 5, salesSpeedUsed: false });
  });

  it("is 404 for a medicine this pharmacy does not carry, and 400 for a malformed code", async () => {
    await call("DELETE", "/portal/stock/M002", a);
    expect((await call("GET", "/portal/risk/M002", a)).json().error.code).toBe("NOT_STOCKED");
    expect((await call("GET", "/portal/risk/M002", b)).statusCode).toBe(200); // P002 still carries it
    expect((await call("GET", "/portal/risk/M999", a)).statusCode).toBe(404);
    expect((await call("GET", "/portal/risk/crocin", a)).statusCode).toBe(400);
  });
});

describe("GET /portal/alerts", () => {
  it("shows an alert the moment a sale takes stock to the threshold, with today's assessment", async () => {
    expect((await alertsOf(a)).data).toEqual([]);
    expect((await sell(a, "M001", 7)).statusCode).toBe(201); // 12 -> 5
    const { data, meta } = await alertsOf(a);
    expect(meta).toMatchObject({ total: 1, state: "ACTIVE", threshold: 5, limit: 20, offset: 0, hasMore: false });
    expect(data[0]).toMatchObject({
      pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", type: "LOW_STOCK", state: "ACTIVE",
      quantityAtCreation: 5, threshold: 5, riskScoreAtCreation: 60, resolvedAt: null, resolvedReason: null, quantityAtResolution: null,
      current: { quantity: 5, score: 60, level: "HIGH", belowThreshold: true },
    });
    expect(data[0].alertId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(data[0].createdAt).getTime()).not.toBeNaN();
  });

  it("does not repeat an alert for further sales, and resolves it when stock recovers", async () => {
    await sell(a, "M001", 8); // 4
    await sell(a, "M001", 1); // 3
    await call("GET", "/portal/risk", a);
    expect((await alertsOf(a)).meta.total).toBe(1);
    const restock = await call("POST", "/portal/restocks", a, { medicineCode: "M001", quantity: 10 }); // 13
    expect(restock.statusCode).toBe(201);
    expect((await alertsOf(a)).data).toEqual([]);
    const resolved = (await alertsOf(a, "?state=RESOLVED")).data;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ state: "RESOLVED", resolvedReason: "STOCK_RECOVERED", quantityAtCreation: 4, quantityAtResolution: 13, current: null });
    expect(resolved[0].resolvedAt).not.toBeNull();
    expect((await alertsOf(a, "?state=ALL")).meta.total).toBe(1);
  });

  it("opens a fresh alert when stock falls low again, and lists newest first", async () => {
    await sell(a, "M001", 10); // 2
    await call("POST", "/portal/restocks", a, { medicineCode: "M001", quantity: 20 });
    await sell(a, "M001", 22); // 0
    const all = (await alertsOf(a, "?state=ALL")).data;
    expect(all.map((x: { state: string; quantityAtCreation: number }) => [x.state, x.quantityAtCreation])).toEqual([["ACTIVE", 0], ["RESOLVED", 2]]);
  });

  it("opens no alert for a refused or invalid sale", async () => {
    expect((await sell(a, "M001", 13)).statusCode).toBe(409);
    expect((await sell(a, "M001", 0)).statusCode).toBe(400);
    expect((await alertsOf(a, "?state=ALL")).meta.total).toBe(0);
  });

  it("opens an alert for a stock count made in the portal", async () => {
    await call("PATCH", "/portal/stock/M002", a, { quantity: 1 });
    expect((await alertsOf(a)).data.map((x: { medicineCode: string }) => x.medicineCode)).toEqual(["M002"]);
  });

  it("pages with bounded limits and filters by state, and rejects bad values", async () => {
    await sell(a, "M001", 12);
    await sell(a, "M002", 12);
    const p1 = await alertsOf(a, "?limit=1&offset=0");
    const p2 = await alertsOf(a, "?limit=1&offset=1");
    expect([p1.data[0].medicineCode, p2.data[0].medicineCode]).toEqual(["M002", "M001"]);
    expect(p1.meta).toMatchObject({ total: 2, hasMore: true });
    expect(p2.meta.hasMore).toBe(false);
    for (const qs of ["limit=0", "limit=101", "offset=-1", "state=OPEN", "state=active", "limit=abc"]) {
      expect((await call("GET", `/portal/alerts?${qs}`, a)).statusCode).toBe(400);
    }
  });

  it("belongs to the signed-in pharmacy: no parameter reaches another's alerts, and no staff identity appears", async () => {
    await sell(a, "M001", 12);
    await sell(b, "M002", 12);
    expect((await alertsOf(a)).data.map((x: { pharmacyCode: string; medicineCode: string }) => [x.pharmacyCode, x.medicineCode])).toEqual([["P001", "M001"]]);
    expect((await alertsOf(b)).data.map((x: { pharmacyCode: string; medicineCode: string }) => [x.pharmacyCode, x.medicineCode])).toEqual([["P002", "M002"]]);
    expect((await alertsOf(a, "?pharmacyCode=P002")).data.map((x: { pharmacyCode: string }) => x.pharmacyCode)).toEqual(["P001"]);
    expect((await call("GET", "/portal/risk?pharmacyCode=P002", a)).json().data[0].medicineCode).toBe("M001");
    const body = (await call("GET", "/portal/alerts?state=ALL", a)).body;
    expect(body).not.toMatch(/@pharmacy\.test|password|scrypt/);
  });
});

describe("when the alert tables are missing", () => {
  it("a sale still succeeds, and reading alerts says what to do (503), not a bare error", async () => {
    await pharmacies.P001!.query("ALTER TABLE stock_alerts RENAME TO stock_alerts_away");
    try {
      expect((await sell(a, "M001", 9)).statusCode).toBe(201);
      const res = await call("GET", "/portal/alerts", a);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("PHARMACY_SCHEMA_OUTDATED");
      expect(res.json().error.message).toMatch(/pharmacies:migrate/);
    } finally {
      await pharmacies.P001!.query("ALTER TABLE stock_alerts_away RENAME TO stock_alerts");
    }
    expect((await alertsOf(a)).data).toHaveLength(1); // repaired by the next read
  });
});
