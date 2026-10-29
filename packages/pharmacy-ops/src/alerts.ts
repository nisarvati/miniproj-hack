import type { Db } from "@medlink/db";
import { assessStockRisk } from "./risk.js";

/** The only alert type so far. It is open while the units on hand are at or below the threshold (zero stock included). */
export type AlertType = "LOW_STOCK";
export type AlertState = "ACTIVE" | "RESOLVED";
export type ResolvedReason = "STOCK_RECOVERED" | "NO_LONGER_STOCKED";

export interface StockAlert {
  alertId: string;
  pharmacyCode: string;
  medicineCode: string;
  type: AlertType;
  state: AlertState;
  quantityAtCreation: number;
  threshold: number;
  riskScoreAtCreation: number;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedReason: ResolvedReason | null;
  quantityAtResolution: number | null;
  /** The units on hand now (only while the medicine is still stocked). */
  currentQuantity: number | null;
}

/** What one evaluation changed. Both empty: the alerts already matched the stock. */
export interface AlertChanges {
  opened: string[];
  resolved: string[];
}

interface AlertRow {
  alert_id: string;
  medicine_code: string;
  alert_type: AlertType;
  state: AlertState;
  quantity_at_creation: number;
  threshold: number;
  risk_score: number;
  created_at: Date;
  resolved_at: Date | null;
  resolved_reason: ResolvedReason | null;
  quantity_at_resolution: number | null;
  current_quantity?: number | null;
}
const ALERT_COLUMNS = "a.alert_id, a.medicine_code, a.alert_type, a.state, a.quantity_at_creation, a.threshold, a.risk_score, a.created_at, a.resolved_at, a.resolved_reason, a.quantity_at_resolution, i.quantity AS current_quantity";

const toAlert = (pharmacyCode: string, r: AlertRow): StockAlert => ({
  alertId: r.alert_id,
  pharmacyCode,
  medicineCode: r.medicine_code,
  type: r.alert_type,
  state: r.state,
  quantityAtCreation: r.quantity_at_creation,
  threshold: r.threshold,
  riskScoreAtCreation: r.risk_score,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
  resolvedReason: r.resolved_reason,
  quantityAtResolution: r.quantity_at_resolution,
  currentQuantity: r.current_quantity ?? null,
});

/**
 * Makes the alerts match the stock: opens a LOW_STOCK alert for every medicine at or below `threshold`, and resolves the active alert of
 * every medicine that has recovered above it or is no longer stocked. `medicineCode` limits it to one medicine (after a change to it).
 *
 * Idempotent and safe to run at the same time as itself or as a sale:
 *  - it reads the stock under a row lock, so it sees what the latest committed change left (and a sale simply waits a moment for it);
 *  - the partial unique index allows one active alert per medicine, so a second opener finds the first instead of adding another;
 *  - resolving only touches ACTIVE rows, so doing it twice changes nothing.
 * Run it after a change has COMMITTED, never inside the change: a rolled-back change then never leaves an alert behind.
 */
export async function evaluateAlerts(db: Db, threshold: number, medicineCode?: string): Promise<AlertChanges> {
  if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError("the low-stock threshold must be a whole number of at least 1");
  const client = await db.connect();
  const changes: AlertChanges = { opened: [], resolved: [] };
  try {
    await client.query("BEGIN");
    const { rows: stock } = await client.query<{ medicine_code: string; quantity: number }>(
      `SELECT medicine_code, quantity FROM inventory ${medicineCode ? "WHERE medicine_code = $1" : ""} ORDER BY medicine_code FOR SHARE`,
      medicineCode ? [medicineCode] : [],
    );
    for (const { medicine_code: code, quantity } of stock) {
      if (quantity <= threshold) {
        const score = assessStockRisk({ quantity, threshold }).score!;
        const { rows } = await client.query<{ alert_id: string }>(
          `INSERT INTO stock_alerts (medicine_code, alert_type, quantity_at_creation, threshold, risk_score)
           VALUES ($1, 'LOW_STOCK', $2, $3, $4)
           ON CONFLICT (medicine_code, alert_type) WHERE state = 'ACTIVE' DO NOTHING
           RETURNING alert_id`,
          [code, quantity, threshold, score],
        );
        changes.opened.push(...rows.map((r) => r.alert_id));
      } else {
        const { rows } = await client.query<{ alert_id: string }>(
          `UPDATE stock_alerts SET state = 'RESOLVED', resolved_at = now(), resolved_reason = 'STOCK_RECOVERED', quantity_at_resolution = $2
           WHERE medicine_code = $1 AND alert_type = 'LOW_STOCK' AND state = 'ACTIVE' RETURNING alert_id`,
          [code, quantity],
        );
        changes.resolved.push(...rows.map((r) => r.alert_id));
      }
    }
    // A medicine the pharmacy no longer lists has no stock level to be low.
    const { rows: gone } = await client.query<{ alert_id: string }>(
      `UPDATE stock_alerts SET state = 'RESOLVED', resolved_at = now(), resolved_reason = 'NO_LONGER_STOCKED'
       WHERE state = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.medicine_code = stock_alerts.medicine_code)
         ${medicineCode ? "AND medicine_code = $1" : ""}
       RETURNING alert_id`,
      medicineCode ? [medicineCode] : [],
    );
    changes.resolved.push(...gone.map((r) => r.alert_id));
    await client.query("COMMIT");
    return changes;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** The pharmacy's alerts, newest first (ties broken by id so the order never changes). `total` counts every alert in that state. */
export async function listAlerts(
  db: Db,
  pharmacyCode: string,
  filter: { state: AlertState | "ALL"; limit: number; offset: number },
): Promise<{ items: StockAlert[]; total: number }> {
  const where = filter.state === "ALL" ? "" : "WHERE a.state = $1";
  const stateArg = filter.state === "ALL" ? [] : [filter.state];
  const [{ rows }, { rows: count }] = await Promise.all([
    db.query<AlertRow>(
      `SELECT ${ALERT_COLUMNS} FROM stock_alerts a LEFT JOIN inventory i ON i.medicine_code = a.medicine_code ${where}
       ORDER BY a.created_at DESC, a.id DESC LIMIT $${stateArg.length + 1} OFFSET $${stateArg.length + 2}`,
      [...stateArg, filter.limit, filter.offset],
    ),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM stock_alerts a ${where}`, stateArg),
  ]);
  return { items: rows.map((r) => toAlert(pharmacyCode, r)), total: Number(count[0]!.n) };
}

/** Every medicine the pharmacy stocks with its units on hand and its active alert, if any. Unbounded by design: the caller sorts and pages it. */
export async function stockWithAlerts(db: Db): Promise<{ medicineCode: string; quantity: number; alert: { alertId: string; createdAt: Date } | null }[]> {
  const { rows } = await db.query<{ medicine_code: string; quantity: number; alert_id: string | null; created_at: Date | null }>(
    `SELECT i.medicine_code, i.quantity, a.alert_id, a.created_at
     FROM inventory i LEFT JOIN stock_alerts a ON a.medicine_code = i.medicine_code AND a.alert_type = 'LOW_STOCK' AND a.state = 'ACTIVE'
     ORDER BY i.medicine_code`,
  );
  return rows.map((r) => ({ medicineCode: r.medicine_code, quantity: r.quantity, alert: r.alert_id ? { alertId: r.alert_id, createdAt: r.created_at! } : null }));
}
