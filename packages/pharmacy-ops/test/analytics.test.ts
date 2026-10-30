import { describe, expect, it } from "vitest";
import type { Db } from "@medlink/db";
import { pharmacyAnalytics, rangeOf } from "../src/analytics.js";

/** A pharmacy database that answers each query by matching its SQL, or fails the way Postgres does. Records every statement. */
function fakeDb(handlers: { match: RegExp; rows?: unknown[]; fail?: { code?: string } }[]) {
  const statements: string[] = [];
  const db = {
    query: async (sql: string) => {
      statements.push(sql);
      const h = handlers.find((x) => x.match.test(sql));
      if (!h) return { rows: [], rowCount: 0 };
      if (h.fail) throw Object.assign(new Error("boom"), h.fail);
      return { rows: h.rows ?? [], rowCount: (h.rows ?? []).length };
    },
  } as unknown as Db;
  return { db, statements };
}
const NOW = new Date("2026-10-30T10:30:00.000Z");
const base = (extra: Parameters<typeof fakeDb>[0] = []) =>
  fakeDb([...extra, { match: /FROM inventory$/, rows: [{ quantity: 0 }, { quantity: 3 }, { quantity: 5 }, { quantity: 6 }, { quantity: 40 }] }, { match: /FROM restock_plans/, rows: [] }, { match: /FROM stock_alerts/, rows: [{ active: 2, resolved: 1, opened: 3 }] }]);

describe("rangeOf", () => {
  it("is the last N UTC calendar days, ending today, oldest first", () => {
    const r = rangeOf(7, NOW);
    expect(r.dates).toEqual(["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(r.from.toISOString()).toBe("2026-10-24T00:00:00.000Z");
    expect(r.to).toBe(NOW);
  });
  it("crosses month and year boundaries", () => {
    expect(rangeOf(14, new Date("2027-01-03T00:00:00Z")).dates.slice(0, 3)).toEqual(["2026-12-21", "2026-12-22", "2026-12-23"]);
  });
});

describe("pharmacyAnalytics", () => {
  it("only reads: every statement is a SELECT", async () => {
    const { db, statements } = base();
    await pharmacyAnalytics(db, { pharmacyCode: "P001", days: 7, threshold: 5, now: NOW });
    expect(statements.length).toBeGreaterThanOrEqual(6);
    for (const s of statements) expect(s.trim()).toMatch(/^SELECT/i);
    for (const s of statements) expect(s).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
  });

  it("fills every day of the range, with a real zero for a day with nothing recorded, and keeps sales and restocks apart", async () => {
    const { db } = base([{ match: /GROUP BY 1, 2/, rows: [{ day: "2026-10-30", operation: "SALE", transactions: 2, units: 9 }, { day: "2026-10-28", operation: "RESTOCK", transactions: 1, units: 30 }, { day: "2026-01-01", operation: "SALE", transactions: 9, units: 99 }] }]);
    const a = await pharmacyAnalytics(db, { pharmacyCode: "P001", days: 7, threshold: 5, now: NOW });
    if (!a.movements.available) throw new Error("expected movements");
    expect(a.movements.daily).toHaveLength(7);
    expect(a.movements.daily.at(-1)).toEqual({ date: "2026-10-30", salesUnits: 9, salesTransactions: 2, restockUnits: 0, restockTransactions: 0 });
    expect(a.movements.daily[4]).toMatchObject({ date: "2026-10-28", restockUnits: 30, salesUnits: 0 });
    expect(a.movements.totals).toEqual({ salesUnits: 9, salesTransactions: 2, restockUnits: 30, restockTransactions: 1 }); // a row outside the range is ignored
  });

  it("counts stock by the same thresholds search uses, and risk with the portal's own function", async () => {
    const { db } = base();
    const a = await pharmacyAnalytics(db, { pharmacyCode: "P001", days: 7, threshold: 5, now: NOW });
    expect(a.stock).toEqual({ available: true, total: 5, outOfStock: 1, lowStock: 2, inStock: 2, threshold: 5 });
    if (!a.risk.available) throw new Error("expected risk");
    expect(Object.values(a.risk.byLevel).reduce((x, y) => x + y, 0)).toBe(5);
    expect(a.risk.byLevel.UNKNOWN).toBe(0);
  });

  it("reports a section that cannot be read as unavailable with a reason, never as zero, and leaves the others alone", async () => {
    const { db } = base([{ match: /FROM restock_plans/, fail: { code: "42P01" } }, { match: /FROM stock_alerts/, fail: {} }]);
    const a = await pharmacyAnalytics(db, { pharmacyCode: "P001", days: 7, threshold: 5, now: NOW });
    expect(a.plans).toEqual({ available: false, reason: "SCHEMA_OUTDATED" });
    expect(a.alerts).toEqual({ available: false, reason: "ERROR" });
    expect(a.stock.available).toBe(true);
    expect(a.movements.available).toBe(true);
    expect(JSON.stringify(a.plans)).not.toMatch(/open|overdue|0/);
  });

  it("counts overdue as open plans whose target date is before today, from the database's own aggregate", async () => {
    const { db, statements } = base([{ match: /FROM restock_plans/, rows: [{ status: "PLANNED", n: 3, overdue: 1 }, { status: "IN_PROGRESS", n: 1, overdue: 1 }, { status: "COMPLETED", n: 4, overdue: 0 }, { status: "CANCELLED", n: 2, overdue: 0 }] }]);
    const a = await pharmacyAnalytics(db, { pharmacyCode: "P001", days: 7, threshold: 5, now: NOW });
    expect(a.plans).toEqual({ available: true, byStatus: { PLANNED: 3, IN_PROGRESS: 1, COMPLETED: 4, CANCELLED: 2 }, open: 4, overdue: 2 });
    expect(statements.find((s) => /restock_plans/.test(s))).toMatch(/status IN \('PLANNED', 'IN_PROGRESS'\) AND target_date < \$1::date/);
  });
});
