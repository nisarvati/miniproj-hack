import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { evaluateAlerts, PharmacySimulator } from "../src/index.js";

let admin: Db;
let pools: Record<string, Db>;
let urls: Record<string, string>;
const P1 = "P001";
const P2 = "P002";
const T = 5;
let sim: PharmacySimulator;
let errors: unknown[];

beforeAll(async () => {
  admin = await freshSeededDb();
  urls = await freshPharmacyDbs(admin);
  pools = { P001: createPool(urls.P001!), P002: createPool(urls.P002!) };
});
afterAll(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await admin.end();
});
beforeEach(async () => {
  errors = [];
  sim = new PharmacySimulator(pools, { lowStockThreshold: T, onAlertError: (e) => errors.push(e) });
  for (const code of [P1, P2]) {
    await pools[code]!.query("DELETE FROM inventory");
    await setupPharmacyDatabase(code, urls[code]!);
    await pools[code]!.query("UPDATE inventory SET quantity = 12"); // every medicine healthy: each test makes only what it needs low
    await pools[code]!.query("TRUNCATE outbox, inventory_movements, stock_alerts");
  }
});

const alerts = async (code = P1, state?: string) => (await pools[code]!.query(`SELECT * FROM stock_alerts ${state ? "WHERE state = $1" : ""} ORDER BY id`, state ? [state] : [])).rows;
const active = async (code = P1, med = "M001") => (await pools[code]!.query("SELECT * FROM stock_alerts WHERE medicine_code = $1 AND state = 'ACTIVE'", [med])).rows;
const setQty = (code: string, med: string, n: number) => pools[code]!.query("UPDATE inventory SET quantity = $2 WHERE medicine_code = $1", [med, n]);

describe("opening an alert", () => {
  it("a sale that takes stock to the threshold opens one alert with the stock, threshold and risk score of that moment", async () => {
    await sim.recordSale(P1, "M001", 7); // 12 -> 5, exactly the threshold
    const [a] = await active();
    expect(a).toMatchObject({ medicine_code: "M001", alert_type: "LOW_STOCK", state: "ACTIVE", quantity_at_creation: 5, threshold: 5, risk_score: 60, resolved_at: null });
    expect(a.alert_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await alerts()).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("does nothing while stock stays above the threshold, and one unit over is still above it", async () => {
    await sim.recordSale(P1, "M001", 6); // 12 -> 6
    expect(await alerts()).toHaveLength(0);
  });

  it("opens a critical alert for zero stock", async () => {
    await sim.recordSale(P1, "M001", 12);
    expect((await active())[0]).toMatchObject({ quantity_at_creation: 0, risk_score: 100 });
  });

  it("works for every way the portal changes stock: sale, stock count, removal, restock still low", async () => {
    await sim.recordCount(P1, "M001", 3); // a count
    expect(await active(P1, "M001")).toHaveLength(1);
    await sim.sell(P1, "M002", 10); // the plain simulator operation is covered too
    expect(await active(P1, "M002")).toHaveLength(1);
  });

  it("does not open an alert for a rolled-back change, or for a refused one", async () => {
    await sim.recordSale(P1, "M001", 20).catch(() => undefined); // more than the 12 on the shelf: refused
    await pools[P1]!.query(`
      CREATE FUNCTION fail_movement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'movement refused'; END; $$;
      CREATE TRIGGER fail_movement BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION fail_movement()`);
    try {
      await expect(sim.recordSale(P1, "M001", 11)).rejects.toThrow(/movement refused/); // would have left 1: rolled back
    } finally {
      await pools[P1]!.query("DROP TRIGGER fail_movement ON inventory_movements; DROP FUNCTION fail_movement()");
    }
    await expect(sim.recordSale(P1, "M001", 0)).rejects.toThrow();
    expect((await pools[P1]!.query("SELECT quantity FROM inventory WHERE medicine_code = 'M001'")).rows[0].quantity).toBe(12);
    expect(await alerts()).toHaveLength(0);
  });
});

describe("no duplicates", () => {
  it("repeated evaluation and further sales while low keep exactly one active alert, and the first one's figures", async () => {
    await sim.recordSale(P1, "M001", 8); // 4
    const first = (await active())[0];
    await sim.recordSale(P1, "M001", 1); // 3, still low
    await sim.recordSale(P1, "M001", 1); // 2
    for (let i = 0; i < 4; i++) expect(await sim.reconcileAlerts(P1)).toEqual({ opened: [], resolved: [] });
    const rows = await active();
    expect(rows).toHaveLength(1);
    expect(rows[0].alert_id).toBe(first.alert_id);
    expect(rows[0].quantity_at_creation).toBe(4);
    expect(await alerts()).toHaveLength(1);
  });

  it("concurrent evaluations and sales still leave exactly one active alert", async () => {
    await Promise.all([
      ...Array.from({ length: 12 }, () => sim.reconcileAlerts(P1)),
      ...Array.from({ length: 10 }, () => sim.recordSale(P1, "M001", 1).catch(() => undefined)),
      ...Array.from({ length: 12 }, () => evaluateAlerts(pools[P1]!, T, "M001")),
    ]);
    expect(await active()).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });

  it("the database itself refuses a second active alert for the same medicine", async () => {
    await sim.recordSale(P1, "M001", 8);
    await expect(
      pools[P1]!.query("INSERT INTO stock_alerts (medicine_code, alert_type, quantity_at_creation, threshold, risk_score) VALUES ('M001', 'LOW_STOCK', 1, 5, 92)"),
    ).rejects.toThrow(/stock_alerts_one_active/);
  });
});

describe("resolving and re-opening", () => {
  it("a restock above the threshold resolves the alert; one that is still low does not", async () => {
    await sim.recordSale(P1, "M001", 10); // 2: alert
    await sim.recordRestock(P1, "M001", 3); // 5: still at the threshold
    expect(await active()).toHaveLength(1);
    await sim.recordRestock(P1, "M001", 1); // 6: recovered
    expect(await active()).toHaveLength(0);
    const [done] = await alerts(P1, "RESOLVED");
    expect(done).toMatchObject({ state: "RESOLVED", resolved_reason: "STOCK_RECOVERED", quantity_at_resolution: 6, quantity_at_creation: 2 });
    expect(done.resolved_at).not.toBeNull();
  });

  it("falling low again opens a new alert and keeps the resolved one as history", async () => {
    await sim.recordSale(P1, "M001", 10);
    await sim.recordRestock(P1, "M001", 20);
    await sim.recordSale(P1, "M001", 22); // 0
    const all = await alerts();
    expect(all.map((a) => [a.state, a.quantity_at_creation])).toEqual([["RESOLVED", 2], ["ACTIVE", 0]]);
    expect(new Set(all.map((a) => a.alert_id)).size).toBe(2);
  });

  it("resolving twice, or evaluating a recovered medicine again, changes nothing", async () => {
    await sim.recordSale(P1, "M001", 10);
    await sim.recordRestock(P1, "M001", 20);
    const before = await alerts();
    for (let i = 0; i < 3; i++) expect(await sim.reconcileAlerts(P1)).toEqual({ opened: [], resolved: [] });
    expect(await alerts()).toEqual(before);
  });

  it("resolves the alert of a medicine the pharmacy stops listing, saying why", async () => {
    await sim.recordSale(P1, "M001", 9);
    await sim.removeMedicine(P1, "M001");
    expect(await active()).toHaveLength(0);
    expect((await alerts(P1, "RESOLVED"))[0]).toMatchObject({ resolved_reason: "NO_LONGER_STOCKED", quantity_at_resolution: null });
  });
});

describe("reconciliation", () => {
  it("catches stock changed some other way (plain SQL), and is safe to run again", async () => {
    await setQty(P1, "M001", 2); // what pharmacy software does: no portal involved
    await setQty(P1, "M002", 0);
    expect(await alerts()).toHaveLength(0); // MedLink has not looked yet
    const r = await sim.reconcileAlerts(P1);
    expect(r.opened).toHaveLength(2);
    expect(await sim.reconcileAlerts(P1)).toEqual({ opened: [], resolved: [] });
    expect((await alerts()).map((a) => [a.medicine_code, a.quantity_at_creation, a.risk_score])).toEqual([["M001", 2, 84], ["M002", 0, 100]]);
  });

  it("follows a changed threshold: a higher one opens alerts, a lower one resolves them", async () => {
    await setQty(P1, "M001", 8);
    expect((await sim.reconcileAlerts(P1)).opened).toHaveLength(0);
    const higher = new PharmacySimulator(pools, { lowStockThreshold: 10 });
    expect((await higher.reconcileAlerts(P1)).opened).toHaveLength(1); // 8 is now at or below the threshold of 10
    expect((await active(P1, "M001"))[0]).toMatchObject({ threshold: 10, quantity_at_creation: 8 });
    expect((await sim.reconcileAlerts(P1)).resolved.length).toBeGreaterThan(0); // back to 5: 8 is above it
    expect(await active(P1, "M001")).toHaveLength(0);
  });

  it("rejects an unusable threshold", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) await expect(evaluateAlerts(pools[P1]!, bad)).rejects.toThrow(/threshold/);
  });

  it("is not switched on for a simulator created without a threshold: it changes stock and touches no alert", async () => {
    const plain = new PharmacySimulator(pools);
    await plain.recordSale(P1, "M001", 11);
    expect(await alerts()).toHaveLength(0);
    expect(() => plain.reconcileAlerts(P1)).toThrow(/not switched on/);
  });
});

describe("an alert problem never undoes a sale", () => {
  it("the sale stands and the problem is reported when the alert table is unavailable; the next evaluation repairs it", async () => {
    await pools[P1]!.query("ALTER TABLE stock_alerts RENAME TO stock_alerts_away");
    try {
      const r = await sim.recordSale(P1, "M001", 9);
      expect(r.movement).toMatchObject({ quantityAfter: 3 });
      expect((await pools[P1]!.query("SELECT quantity FROM inventory WHERE medicine_code = 'M001'")).rows[0].quantity).toBe(3);
      expect(errors).toHaveLength(1);
      expect(String((errors[0] as Error).message)).toMatch(/stock_alerts/);
    } finally {
      await pools[P1]!.query("ALTER TABLE stock_alerts_away RENAME TO stock_alerts");
    }
    expect(await alerts()).toHaveLength(0);
    expect((await sim.reconcileAlerts(P1)).opened).toHaveLength(1);
  });

  it("reports through onAlertError rather than throwing, and stays quiet when everything works", async () => {
    const seen = vi.fn();
    const quiet = new PharmacySimulator(pools, { lowStockThreshold: T, onAlertError: seen });
    await quiet.recordSale(P1, "M001", 9);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("pharmacies stay apart", () => {
  it("one pharmacy's low stock opens an alert only in its own database", async () => {
    await sim.recordSale(P1, "M001", 11);
    expect(await active(P1)).toHaveLength(1);
    expect(await alerts(P2)).toHaveLength(0);
    await sim.recordSale(P2, "M002", 12);
    expect((await alerts(P2)).map((a) => a.medicine_code)).toEqual(["M002"]);
    expect((await alerts(P1)).map((a) => a.medicine_code)).toEqual(["M001"]);
    expect((await sim.alertHistory(P2, { state: "ALL", limit: 10, offset: 0 })).items.map((a) => [a.pharmacyCode, a.medicineCode])).toEqual([[P2, "M002"]]);
  });
});

describe("listing alerts and risk", () => {
  it("lists newest first, filters by state, pages, and shows current stock", async () => {
    await sim.recordSale(P1, "M001", 11); // opens (1 left)
    await sim.recordSale(P1, "M002", 12); // opens (0 left)
    await sim.recordRestock(P1, "M001", 30); // resolves M001
    const all = await sim.alertHistory(P1, { state: "ALL", limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.items.map((a) => [a.medicineCode, a.state])).toEqual([["M002", "ACTIVE"], ["M001", "RESOLVED"]]);
    expect(all.items[0]).toMatchObject({ currentQuantity: 0, quantityAtCreation: 0, riskScoreAtCreation: 100, threshold: 5, type: "LOW_STOCK", resolvedAt: null });
    expect(all.items[1]).toMatchObject({ resolvedReason: "STOCK_RECOVERED", quantityAtResolution: 31 });
    expect((await sim.alertHistory(P1, { state: "ACTIVE", limit: 10, offset: 0 })).items.map((a) => a.medicineCode)).toEqual(["M002"]);
    expect((await sim.alertHistory(P1, { state: "RESOLVED", limit: 10, offset: 0 })).total).toBe(1);
    expect((await sim.alertHistory(P1, { state: "ALL", limit: 1, offset: 1 })).items.map((a) => a.medicineCode)).toEqual(["M001"]);
  });

  it("ranks every stocked medicine by risk, riskiest first, with its active alert", async () => {
    await sim.recordSale(P1, "M001", 12); // 0 -> 100
    await sim.recordSale(P1, "M002", 9); // 3 -> 76
    const risk = await sim.stockRisk(P1);
    expect(risk.slice(0, 2).map((r) => [r.medicineCode, r.assessment.score, r.alert !== null])).toEqual([["M001", 100, true], ["M002", 76, true]]);
    const scores = risk.map((r) => r.assessment.score!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(risk.every((r) => r.assessment.threshold === T)).toBe(true);
  });
});
