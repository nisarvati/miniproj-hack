import type { Db } from "@medlink/db";
import { pharmacyByCode } from "./catalogue.js";
import { toCsv } from "./csv.js";

/**
 * Restock plans: a pharmacy's planning list ("get N more of this medicine by this date"). A plan is only a plan. Nothing in this file reads or writes
 * `inventory`, `inventory_movements`, the outbox or Redis for the purpose of changing stock: marking a plan COMPLETED does not mean stock arrived, and stock
 * changes only through the recorded restock (simulator.recordRestock, which updates stock, history and outbox in one transaction).
 *
 * Lifecycle (every change is checked here, on the server, under a row lock):
 *
 *   PLANNED      -> IN_PROGRESS, COMPLETED, CANCELLED
 *   IN_PROGRESS  -> PLANNED (put back), COMPLETED, CANCELLED
 *   COMPLETED    -> IN_PROGRESS (reopen, which clears the completion time)
 *   CANCELLED    -> nothing: it is final; make a new plan instead
 *
 * Quantity, target date and notes can be changed only while the plan is open (PLANNED or IN_PROGRESS, or in the same change that reopens it). The medicine,
 * the pharmacy and the creator never change. At most one plan per medicine is open at a time (a unique index), which also stops duplicates from a double click.
 */
export type PlanStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export const PLAN_STATUSES: readonly PlanStatus[] = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];
export const OPEN_STATUSES: readonly PlanStatus[] = ["PLANNED", "IN_PROGRESS"];
export const TRANSITIONS: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = {
  PLANNED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["PLANNED", "COMPLETED", "CANCELLED"],
  COMPLETED: ["IN_PROGRESS"],
  CANCELLED: [],
};
export const isOpen = (s: PlanStatus) => OPEN_STATUSES.includes(s);

export type PlanFilter = PlanStatus | "OPEN" | "ALL";
export const MAX_PLAN_QUANTITY = 1_000_000;
export const MAX_NOTES = 500;
/** A CSV export holds at most this many plans (the response says when it was cut short). */
export const MAX_EXPORT_ROWS = 10_000;

export type PlanErrorCode = "INVALID" | "NOT_FOUND" | "NOT_STOCKED" | "PLAN_ALREADY_OPEN" | "INVALID_TRANSITION" | "PLAN_CLOSED" | "UNKNOWN_PHARMACY";
export class PlanError extends Error {
  constructor(
    public readonly code: PlanErrorCode,
    message: string,
    /** For PLAN_ALREADY_OPEN: the plan that is already open. */
    public readonly details?: { planId: string; status: PlanStatus },
  ) {
    super(message);
    this.name = "PlanError";
  }
}
const invalid = (message: string) => new PlanError("INVALID", message);

export interface RestockPlan {
  planId: string;
  pharmacyCode: string;
  medicineCode: string;
  plannedQuantity: number;
  status: PlanStatus;
  /** YYYY-MM-DD. */
  targetDate: string;
  notes: string | null;
  createdByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  /** The units on the shelf now, for context. null: the pharmacy no longer lists the medicine. Planning never changes it. */
  currentQuantity: number | null;
}

export interface PlanInput {
  medicineCode: string;
  quantity: number;
  targetDate: string;
  notes?: string | null;
}
export interface PlanPatch {
  status?: PlanStatus;
  quantity?: number;
  targetDate?: string;
  notes?: string | null;
}

const DAY = 86_400_000;
/**
 * A target date is a real calendar day (YYYY-MM-DD) from yesterday (UTC: a person east of Greenwich can already be on the next day, and one far west a day behind)
 * to two years ahead. Nothing is converted or defaulted: anything else is refused.
 */
export function validateTargetDate(value: unknown, now: Date = new Date()): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid("The target date must be a date like 2026-11-05.");
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw invalid("The target date is not a real calendar date.");
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  if (ms < today - DAY) throw invalid("The target date cannot be in the past.");
  if (ms > today + 730 * DAY) throw invalid("The target date is too far ahead (two years at most).");
  return value;
}

export function validateQuantity(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PLAN_QUANTITY) throw invalid(`The planned quantity must be a whole number from 1 to ${MAX_PLAN_QUANTITY}.`);
  return value;
}

/** Trimmed notes, or null for none. Longer than the limit or not text is refused, never cut. */
export function validateNotes(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalid("Notes must be text.");
  const text = value.trim();
  if (text.length > MAX_NOTES) throw invalid(`Notes can be at most ${MAX_NOTES} characters.`);
  return text === "" ? null : text;
}

interface PlanRow {
  plan_id: string;
  medicine_code: string;
  planned_quantity: number;
  status: PlanStatus;
  target_date: string;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  current_quantity: number | null;
}
// target_date is read as text so it never passes through a JavaScript Date (and a time zone).
const COLUMNS = `p.plan_id, p.medicine_code, p.planned_quantity, p.status, to_char(p.target_date, 'YYYY-MM-DD') AS target_date, p.notes, p.created_by_user_id,
  p.created_at, p.updated_at, p.completed_at, i.quantity AS current_quantity`;
const FROM = "restock_plans p LEFT JOIN inventory i ON i.medicine_code = p.medicine_code";

const toPlan = (pharmacyCode: string, r: PlanRow): RestockPlan => ({
  planId: r.plan_id,
  pharmacyCode,
  medicineCode: r.medicine_code,
  plannedQuantity: r.planned_quantity,
  status: r.status,
  targetDate: r.target_date,
  notes: r.notes,
  createdByUserId: r.created_by_user_id === null ? null : Number(r.created_by_user_id),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  currentQuantity: r.current_quantity,
});

const statusClause = (filter: PlanFilter, first: number): { sql: string; args: string[] } =>
  filter === "ALL" ? { sql: "", args: [] } : filter === "OPEN" ? { sql: `WHERE p.status IN ('PLANNED', 'IN_PROGRESS')`, args: [] } : { sql: `WHERE p.status = $${first}`, args: [filter] };

/** Plans live in the pharmacy's own database, so every call names the pharmacy (from the signed-in session, never the request) and can only reach its plans. */
export class RestockPlanner {
  constructor(
    private readonly pharmacies: Record<string, Db>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private db(pharmacyCode: string): Db {
    pharmacyByCode(pharmacyCode); // a clear error for an unknown code
    const db = this.pharmacies[pharmacyCode];
    if (!db) throw new PlanError("UNKNOWN_PHARMACY", `No database is configured for ${pharmacyCode}`);
    return db;
  }

  async create(pharmacyCode: string, input: PlanInput, actorUserId?: number): Promise<RestockPlan> {
    const db = this.db(pharmacyCode);
    const quantity = validateQuantity(input.quantity);
    const targetDate = validateTargetDate(input.targetDate, this.clock());
    const notes = validateNotes(input.notes);
    if (typeof input.medicineCode !== "string" || !/^M\d{3,}$/.test(input.medicineCode)) throw invalid("The medicine code must look like M001.");

    // Only a medicine this pharmacy lists can be planned for.
    const stocked = await db.query("SELECT 1 FROM inventory WHERE medicine_code = $1", [input.medicineCode]);
    if (!stocked.rowCount) throw new PlanError("NOT_STOCKED", `${pharmacyCode} does not list ${input.medicineCode}, so there is nothing to plan a restock for.`);

    try {
      const { rows } = await db.query<{ plan_id: string }>(
        `INSERT INTO restock_plans (medicine_code, planned_quantity, target_date, notes, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING plan_id`,
        [input.medicineCode, quantity, targetDate, notes, actorUserId ?? null],
      );
      return (await this.get(pharmacyCode, rows[0]!.plan_id))!;
    } catch (err) {
      throw await this.alreadyOpen(db, input.medicineCode, err);
    }
  }

  async get(pharmacyCode: string, planId: string): Promise<RestockPlan | null> {
    const { rows } = await this.db(pharmacyCode).query<PlanRow>(`SELECT ${COLUMNS} FROM ${FROM} WHERE p.plan_id = $1`, [planId]);
    return rows[0] ? toPlan(pharmacyCode, rows[0]) : null;
  }

  /** Soonest target first, then oldest plan first (a fixed order). `total` counts every plan that matches the filter. */
  async list(pharmacyCode: string, page: { status: PlanFilter; limit: number; offset: number }): Promise<{ items: RestockPlan[]; total: number }> {
    const db = this.db(pharmacyCode);
    const w = statusClause(page.status, 1);
    const [{ rows }, { rows: count }] = await Promise.all([
      db.query<PlanRow>(`SELECT ${COLUMNS} FROM ${FROM} ${w.sql} ORDER BY p.target_date, p.id LIMIT $${w.args.length + 1} OFFSET $${w.args.length + 2}`, [...w.args, page.limit, page.offset]),
      db.query<{ n: string }>(`SELECT count(*) AS n FROM restock_plans p ${w.sql}`, w.args),
    ]);
    return { items: rows.map((r) => toPlan(pharmacyCode, r)), total: Number(count[0]!.n) };
  }

  /**
   * Changes a plan under a row lock, so two changes at once are applied one after the other and the second is checked against what the first left.
   * An empty change, a change to the current status, a move the lifecycle does not allow, or an edit to a plan that is not open is refused.
   */
  async update(pharmacyCode: string, planId: string, patch: PlanPatch): Promise<RestockPlan> {
    const db = this.db(pharmacyCode);
    if (patch.status !== undefined && !PLAN_STATUSES.includes(patch.status)) throw invalid(`The status must be one of ${PLAN_STATUSES.join(", ")}.`);
    const edits = {
      quantity: patch.quantity === undefined ? undefined : validateQuantity(patch.quantity),
      targetDate: patch.targetDate === undefined ? undefined : validateTargetDate(patch.targetDate, this.clock()),
      notes: patch.notes === undefined ? undefined : validateNotes(patch.notes),
    };
    const edited = Object.values(edits).some((v) => v !== undefined);
    if (patch.status === undefined && !edited) throw invalid("Nothing to change: send a status, quantity, targetDate or notes.");

    const client = await db.connect();
    let medicineCode = "";
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ status: PlanStatus; medicine_code: string }>("SELECT status, medicine_code FROM restock_plans WHERE plan_id = $1 FOR UPDATE", [planId]);
      const current = rows[0];
      if (!current) throw new PlanError("NOT_FOUND", "No such restock plan.");
      medicineCode = current.medicine_code;

      const next = patch.status ?? current.status;
      if (patch.status !== undefined) {
        if (patch.status === current.status) throw new PlanError("INVALID_TRANSITION", `The plan is already ${current.status}.`);
        if (!TRANSITIONS[current.status].includes(patch.status)) {
          throw new PlanError(
            "INVALID_TRANSITION",
            current.status === "CANCELLED" ? "A cancelled plan is final. Make a new plan instead." : `A ${current.status} plan cannot become ${patch.status}. It can become: ${TRANSITIONS[current.status].join(", ")}.`,
          );
        }
      }
      if (edited && !isOpen(next)) {
        throw new PlanError("PLAN_CLOSED", current.status === "CANCELLED" ? "A cancelled plan cannot be edited." : "Only a planned or in-progress plan can be edited. Reopen a completed plan first.");
      }

      const sets: string[] = ["updated_at = now()"];
      const args: unknown[] = [planId];
      const set = (column: string, value: unknown) => sets.push(`${column} = $${args.push(value)}`);
      if (patch.status !== undefined) {
        set("status", next);
        sets.push(next === "COMPLETED" ? "completed_at = now()" : "completed_at = NULL");
      }
      if (edits.quantity !== undefined) set("planned_quantity", edits.quantity);
      if (edits.targetDate !== undefined) set("target_date", edits.targetDate);
      if (edits.notes !== undefined) set("notes", edits.notes);
      await client.query(`UPDATE restock_plans SET ${sets.join(", ")} WHERE plan_id = $1`, args);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (err instanceof PlanError) throw err;
      throw await this.alreadyOpen(db, medicineCode, err); // reopening a plan while another one for the medicine is open
    } finally {
      client.release();
    }
    return (await this.get(pharmacyCode, planId))!;
  }

  /** The open plan of each given medicine, if any. A pharmacy whose database has no restock_plans table yet simply has none. */
  async openPlans(pharmacyCode: string, medicineCodes: string[]): Promise<Map<string, { planId: string; status: PlanStatus; targetDate: string }>> {
    if (medicineCodes.length === 0) return new Map();
    try {
      const { rows } = await this.db(pharmacyCode).query<{ plan_id: string; medicine_code: string; status: PlanStatus; target_date: string }>(
        `SELECT plan_id, medicine_code, status, to_char(target_date, 'YYYY-MM-DD') AS target_date FROM restock_plans WHERE status IN ('PLANNED', 'IN_PROGRESS') AND medicine_code = ANY($1)`,
        [medicineCodes],
      );
      return new Map(rows.map((r) => [r.medicine_code, { planId: r.plan_id, status: r.status, targetDate: r.target_date }]));
    } catch (err) {
      if ((err as { code?: string }).code === "42P01") return new Map();
      throw err;
    }
  }

  /** The plans an export holds, in the list order, up to MAX_EXPORT_ROWS. `truncated` says some were left out. */
  async forExport(pharmacyCode: string, status: PlanFilter): Promise<{ plans: RestockPlan[]; truncated: boolean }> {
    const w = statusClause(status, 1);
    const { rows } = await this.db(pharmacyCode).query<PlanRow>(`SELECT ${COLUMNS} FROM ${FROM} ${w.sql} ORDER BY p.target_date, p.id LIMIT $${w.args.length + 1}`, [...w.args, MAX_EXPORT_ROWS + 1]);
    return { plans: rows.slice(0, MAX_EXPORT_ROWS).map((r) => toPlan(pharmacyCode, r)), truncated: rows.length > MAX_EXPORT_ROWS };
  }

  private async alreadyOpen(db: Db, medicineCode: string, err: unknown): Promise<unknown> {
    const e = err as { code?: string; constraint?: string };
    if (e.code !== "23505" || e.constraint !== "restock_plans_one_open") return err;
    const { rows } = await db.query<{ plan_id: string; status: PlanStatus }>("SELECT plan_id, status FROM restock_plans WHERE medicine_code = $1 AND status IN ('PLANNED', 'IN_PROGRESS')", [medicineCode]);
    const open = rows[0];
    return new PlanError("PLAN_ALREADY_OPEN", "There is already an open restock plan for this medicine. Change that one, or finish it first.", open && { planId: open.plan_id, status: open.status });
  }
}

export const EXPORT_COLUMNS = ["plan_id", "medicine_code", "medicine_name", "planned_quantity", "status", "target_date", "created_at", "updated_at", "completed_at", "notes"] as const;

/** The plans as CSV (always with the header row). `names` maps medicine codes to display names. */
export function plansToCsv(plans: readonly RestockPlan[], names: ReadonlyMap<string, string>): string {
  return toCsv(
    EXPORT_COLUMNS,
    plans.map((p) => [p.planId, p.medicineCode, names.get(p.medicineCode) ?? p.medicineCode, p.plannedQuantity, p.status, p.targetDate, p.createdAt.toISOString(), p.updatedAt.toISOString(), p.completedAt?.toISOString() ?? "", p.notes]),
  );
}
