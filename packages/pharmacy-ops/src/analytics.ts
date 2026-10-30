import type { Db } from "@medlink/db";
import { assessStockRisk, type RiskLevel } from "./risk.js";

/**
 * Read-only aggregates for ONE pharmacy, computed in that pharmacy's own database. Nothing here writes, reconciles alerts or touches the outbox.
 * Each section stands alone: one that cannot be read (an older database without the table, a failing query) is reported as unavailable with a
 * reason, and never as zero. Staff only: it is meant for the signed-in pharmacy's own dashboard.
 */
export const ANALYTICS_RANGES = [7, 14, 30] as const;
export type AnalyticsDays = (typeof ANALYTICS_RANGES)[number];

export type Section<T> = ({ available: true } & T) | { available: false; reason: "SCHEMA_OUTDATED" | "ERROR" };

export interface DayMovement {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  salesUnits: number;
  salesTransactions: number;
  restockUnits: number;
  restockTransactions: number;
}

export interface PharmacyAnalytics {
  pharmacyCode: string;
  generatedAt: string;
  range: { days: AnalyticsDays; from: string; to: string; timeZone: "UTC" };
  /**
   * Sales and restocks recorded through the portal (source TRANSACTION). Stock-count corrections are not sales and are counted apart. Movements
   * are recorded only from the day that history was introduced, and changes made another way have no row, so a quiet day can also mean "not recorded".
   */
  movements: Section<{ daily: DayMovement[]; totals: { salesUnits: number; salesTransactions: number; restockUnits: number; restockTransactions: number }; stockCountAdjustments: number }>;
  topSold: Section<{ items: { medicineCode: string; units: number; transactions: number }[] }>;
  stock: Section<{ total: number; inStock: number; lowStock: number; outOfStock: number; threshold: number }>;
  risk: Section<{ byLevel: Record<RiskLevel, number>; total: number; threshold: number }>;
  /** Alerts as recorded. They are brought up to date when staff open the risk or alert views, so this may trail the stock for a moment. */
  alerts: Section<{ active: number; resolvedInRange: number; openedInRange: number }>;
  plans: Section<{ byStatus: { PLANNED: number; IN_PROGRESS: number; COMPLETED: number; CANCELLED: number }; open: number; overdue: number }>;
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function section<T>(read: () => Promise<T>): Promise<({ available: true } & T) | { available: false; reason: "SCHEMA_OUTDATED" | "ERROR" }> {
  try {
    return { available: true, ...(await read()) };
  } catch (err) {
    return { available: false, reason: (err as { code?: string }).code === "42P01" ? "SCHEMA_OUTDATED" : "ERROR" };
  }
}

/** UTC midnight at the start of the first of the last `days` days, ending now. */
export function rangeOf(days: AnalyticsDays, now: Date): { from: Date; to: Date; dates: string[] } {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(startOfToday - (days - 1) * DAY_MS);
  return { from, to: now, dates: Array.from({ length: days }, (_, i) => isoDay(from.getTime() + i * DAY_MS)) };
}

export async function pharmacyAnalytics(db: Db, opts: { pharmacyCode: string; days: AnalyticsDays; threshold: number; now?: Date }): Promise<PharmacyAnalytics> {
  const now = opts.now ?? new Date();
  const { from, to, dates } = rangeOf(opts.days, now);

  const movements = await section(async () => {
    const { rows } = await db.query<{ day: string; operation: "SALE" | "RESTOCK"; transactions: number; units: number }>(
      `SELECT to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, operation, COUNT(*)::int AS transactions, COALESCE(SUM(abs(quantity_delta)), 0)::int AS units
       FROM inventory_movements WHERE source = 'TRANSACTION' AND occurred_at >= $1 AND occurred_at <= $2 GROUP BY 1, 2`,
      [from, to],
    );
    const byDay = new Map<string, DayMovement>(dates.map((date) => [date, { date, salesUnits: 0, salesTransactions: 0, restockUnits: 0, restockTransactions: 0 }]));
    for (const r of rows) {
      const d = byDay.get(r.day);
      if (!d) continue;
      if (r.operation === "SALE") Object.assign(d, { salesUnits: r.units, salesTransactions: r.transactions });
      else Object.assign(d, { restockUnits: r.units, restockTransactions: r.transactions });
    }
    const daily = dates.map((date) => byDay.get(date)!);
    const sum = (k: keyof Omit<DayMovement, "date">) => daily.reduce((n, d) => n + d[k], 0);
    const counts = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM inventory_movements WHERE source = 'STOCK_COUNT' AND occurred_at >= $1 AND occurred_at <= $2", [from, to]);
    return {
      daily,
      totals: { salesUnits: sum("salesUnits"), salesTransactions: sum("salesTransactions"), restockUnits: sum("restockUnits"), restockTransactions: sum("restockTransactions") },
      stockCountAdjustments: counts.rows[0]?.n ?? 0,
    };
  });

  const topSold = await section(async () => {
    const { rows } = await db.query<{ medicine_code: string; units: number; transactions: number }>(
      `SELECT medicine_code, SUM(abs(quantity_delta))::int AS units, COUNT(*)::int AS transactions
       FROM inventory_movements WHERE source = 'TRANSACTION' AND operation = 'SALE' AND occurred_at >= $1 AND occurred_at <= $2
       GROUP BY medicine_code ORDER BY units DESC, medicine_code LIMIT 5`,
      [from, to],
    );
    return { items: rows.map((r) => ({ medicineCode: r.medicine_code, units: r.units, transactions: r.transactions })) };
  });

  // Stock and risk come from one read of the pharmacy's own inventory; the risk level is the same pure function the portal uses.
  const quantities = await section(async () => {
    const { rows } = await db.query<{ quantity: number }>("SELECT quantity FROM inventory");
    return { quantities: rows.map((r) => r.quantity) };
  });
  const stock: PharmacyAnalytics["stock"] = quantities.available
    ? {
        available: true,
        total: quantities.quantities.length,
        outOfStock: quantities.quantities.filter((q) => q <= 0).length,
        lowStock: quantities.quantities.filter((q) => q > 0 && q <= opts.threshold).length,
        inStock: quantities.quantities.filter((q) => q > opts.threshold).length,
        threshold: opts.threshold,
      }
    : quantities;
  const risk: PharmacyAnalytics["risk"] = quantities.available
    ? (() => {
        const byLevel: Record<RiskLevel, number> = { LOW: 0, MODERATE: 0, HIGH: 0, CRITICAL: 0, UNKNOWN: 0 };
        for (const q of quantities.quantities) byLevel[assessStockRisk({ quantity: q, threshold: opts.threshold }).level]++;
        return { available: true as const, byLevel, total: quantities.quantities.length, threshold: opts.threshold };
      })()
    : quantities;

  const alerts = await section(async () => {
    const { rows } = await db.query<{ active: number; resolved: number; opened: number }>(
      `SELECT COUNT(*) FILTER (WHERE state = 'ACTIVE')::int AS active,
              COUNT(*) FILTER (WHERE resolved_at >= $1 AND resolved_at <= $2)::int AS resolved,
              COUNT(*) FILTER (WHERE created_at >= $1 AND created_at <= $2)::int AS opened
       FROM stock_alerts`,
      [from, to],
    );
    const r = rows[0];
    return { active: r?.active ?? 0, resolvedInRange: r?.resolved ?? 0, openedInRange: r?.opened ?? 0 };
  });

  const plans = await section(async () => {
    const { rows } = await db.query<{ status: keyof PharmacyAnalyticsPlans; n: number; overdue: number }>(
      `SELECT status, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE status IN ('PLANNED', 'IN_PROGRESS') AND target_date < $1::date)::int AS overdue FROM restock_plans GROUP BY status`,
      [isoDay(now.getTime())],
    );
    const byStatus: PharmacyAnalyticsPlans = { PLANNED: 0, IN_PROGRESS: 0, COMPLETED: 0, CANCELLED: 0 };
    let overdue = 0;
    for (const r of rows) {
      if (r.status in byStatus) byStatus[r.status] = r.n;
      overdue += r.overdue;
    }
    return { byStatus, open: byStatus.PLANNED + byStatus.IN_PROGRESS, overdue };
  });

  return { pharmacyCode: opts.pharmacyCode, generatedAt: now.toISOString(), range: { days: opts.days, from: from.toISOString(), to: to.toISOString(), timeZone: "UTC" }, movements, topSold, stock, risk, alerts, plans };
}
type PharmacyAnalyticsPlans = { PLANNED: number; IN_PROGRESS: number; COMPLETED: number; CANCELLED: number };
