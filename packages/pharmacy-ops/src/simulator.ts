import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Db } from "@medlink/db";
import { evaluateAlerts, listAlerts, stockWithAlerts, type AlertChanges, type AlertState, type StockAlert } from "./alerts.js";
import { assessStockRisk, type RiskAssessment } from "./risk.js";
import { catalogueEntryByCode, medicineLabel, pharmacyByCode, SimulatorError } from "./catalogue.js";

export interface StockLine {
  quantity: number;
  price: number;
}

/** An event the pharmacy database recorded for the change (see the outbox trigger in the pharmacy schema). */
export interface RecordedEvent {
  eventId: string;
  eventType: string;
  occurredAt: Date;
}

export interface ChangeResult {
  action: "sell" | "restock" | "price" | "add" | "remove" | "set";
  pharmacyCode: string;
  pharmacyName: string;
  medicineCode: string;
  medicineName: string;
  before: StockLine | null;
  /** null after a removal: the pharmacy no longer carries the medicine. */
  after: StockLine | null;
  /** Empty if nothing changed (a price change to the price it already has). */
  events: RecordedEvent[];
}

/** Who is making a recorded change and, for an explicit sale or restock, the key that makes a retry safe. */
export interface MovementContext {
  /** pharmacy_users.id of the signed-in staff member. */
  actorUserId?: number;
  /** 8 to 100 characters. The same key with the same request is applied once; with a different request it is refused. */
  idempotencyKey?: string;
}

/** One row of the pharmacy's movement history (table `inventory_movements`). */
export interface Movement {
  movementId: string;
  pharmacyCode: string;
  medicineCode: string;
  /** A decrease is a SALE, an increase a RESTOCK: the same classification the outbox trigger uses. */
  operation: "SALE" | "RESTOCK";
  /** TRANSACTION: an explicit sale or restock. STOCK_COUNT: staff corrected the quantity after counting the shelf. */
  source: "TRANSACTION" | "STOCK_COUNT";
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  actorUserId: number | null;
  idempotencyKey: string | null;
  /** The outbox event this change produced. */
  eventId: string | null;
  occurredAt: Date;
}

export interface MovementResult {
  /** null: the quantity did not change (a stock count equal to the current quantity), so nothing was recorded. */
  movement: Movement | null;
  /** true: this exact request had been applied before; nothing was changed now and `movement` is the original. */
  replayed: boolean;
  /** The change this call made (events recorded, before and after). null when it was a replay. */
  change: ChangeResult | null;
}

interface Recording {
  source: Movement["source"];
  ctx: MovementContext;
  /** What was asked for, hashed: the same key must always come with the same request. */
  requestHash: string;
}

interface MovementRow {
  movement_id: string;
  medicine_code: string;
  operation: Movement["operation"];
  source: Movement["source"];
  quantity_delta: number;
  quantity_before: number;
  quantity_after: number;
  actor_user_id: string | null;
  idempotency_key: string | null;
  request_hash: string | null;
  event_id: string | null;
  occurred_at: Date;
}
const MOVEMENT_COLUMNS = "movement_id, medicine_code, operation, source, quantity_delta, quantity_before, quantity_after, actor_user_id, idempotency_key, request_hash, event_id, occurred_at";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,100}$/;
const IDEMPOTENCY_INDEX = "inventory_movements_idempotency_key";

const requestHash = (action: string, medicineCode: string, quantity: number) => createHash("sha256").update(`${action}|${medicineCode}|${quantity}`).digest("hex");

const MAX = 1_000_000;

const invalid = (message: string) => new SimulatorError("INVALID", message);
function wholeNumber(value: number, what: string, min: number): number {
  if (!Number.isInteger(value) || value < min || value > MAX) throw invalid(`${what} must be a whole number from ${min} to ${MAX}`);
  return value;
}
function money(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX || Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    throw invalid(`price must be more than 0 and have at most two decimals`);
  }
  return Math.round(value * 100) / 100;
}

type Plan = (tx: PoolClient, before: StockLine | null) => Promise<{ sql: string; params: unknown[] }>;

const toMovement = (pharmacyCode: string, r: MovementRow): Movement => ({
  movementId: r.movement_id,
  pharmacyCode,
  medicineCode: r.medicine_code,
  operation: r.operation,
  source: r.source,
  quantityDelta: r.quantity_delta,
  quantityBefore: r.quantity_before,
  quantityAfter: r.quantity_after,
  actorUserId: r.actor_user_id === null ? null : Number(r.actor_user_id),
  idempotencyKey: r.idempotency_key,
  eventId: r.event_id,
  occurredAt: r.occurred_at,
});

/**
 * What pharmacy software does: it changes the pharmacy's OWN database with plain SQL and knows nothing about MedLink.
 * The pharmacy schema's trigger records an event for every change in the same transaction (the outbox), and the
 * connector, sync service and notification service take it from there. This class never talks to Redis.
 *
 * Every operation locks the row, checks, changes and returns the events the database recorded, in one transaction.
 * A refused operation (selling more than is on the shelf, say) changes nothing and records nothing.
 */
export class PharmacySimulator {
  /**
   * `alerts`: with a `lowStockThreshold`, every successful change also makes the pharmacy's low-stock alerts match its stock. That is done after
   * the change has committed and in its own transaction, so a problem with alerts is reported to `onAlertError` and never fails or undoes a
   * sale. Without it nothing about alerts happens (the simulator and the demo tools).
   */
  constructor(
    private readonly pharmacies: Record<string, Db>,
    private readonly alerts: { lowStockThreshold: number; onAlertError?: (err: unknown) => void } | null = null,
  ) {}

  /** Sells `quantity` units. Cannot sell more than is on the shelf. */
  sell(pharmacyCode: string, medicineCode: string, quantity: number): Promise<ChangeResult> {
    wholeNumber(quantity, "quantity", 1);
    return this.change("sell", pharmacyCode, medicineCode, this.sellPlan(pharmacyCode, medicineCode, quantity));
  }

  private sellPlan(pharmacyCode: string, medicineCode: string, quantity: number): Plan {
    return async (_tx, before) => {
      if (!before) throw this.notStocked(pharmacyCode, medicineCode);
      if (before.quantity < quantity) {
        throw new SimulatorError("INSUFFICIENT_STOCK", `${pharmacyCode} has only ${before.quantity} of ${medicineLabel(medicineCode)}, cannot sell ${quantity}`);
      }
      return { sql: "UPDATE inventory SET quantity = quantity - $2, updated_at = now() WHERE medicine_code = $1", params: [medicineCode, quantity] };
    };
  }

  /** Receives `quantity` more units of a medicine the pharmacy already carries. */
  restock(pharmacyCode: string, medicineCode: string, quantity: number): Promise<ChangeResult> {
    wholeNumber(quantity, "quantity", 1);
    return this.change("restock", pharmacyCode, medicineCode, this.restockPlan(pharmacyCode, medicineCode, quantity));
  }

  private restockPlan(pharmacyCode: string, medicineCode: string, quantity: number): Plan {
    return async (_tx, before) => {
      if (!before) throw this.notStocked(pharmacyCode, medicineCode);
      if (before.quantity + quantity > MAX) throw invalid(`stock cannot exceed ${MAX} units`);
      return { sql: "UPDATE inventory SET quantity = quantity + $2, updated_at = now() WHERE medicine_code = $1", params: [medicineCode, quantity] };
    };
  }

  // ---- Recorded operations: the same changes, plus a durable movement row written in the same transaction. ----

  /**
   * A sale that is also written to the movement history, atomically with the stock change and its outbox event. With an idempotency
   * key, repeating the same request returns the original movement instead of selling again.
   */
  async recordSale(pharmacyCode: string, medicineCode: string, quantity: number, ctx: MovementContext = {}): Promise<MovementResult> {
    wholeNumber(quantity, "quantity", 1);
    return this.recorded("sell", pharmacyCode, medicineCode, this.sellPlan(pharmacyCode, medicineCode, quantity), "TRANSACTION", ctx, requestHash("sale", medicineCode, quantity));
  }

  /** A restock that is also written to the movement history, atomically; idempotent like `recordSale`. */
  async recordRestock(pharmacyCode: string, medicineCode: string, quantity: number, ctx: MovementContext = {}): Promise<MovementResult> {
    wholeNumber(quantity, "quantity", 1);
    return this.recorded("restock", pharmacyCode, medicineCode, this.restockPlan(pharmacyCode, medicineCode, quantity), "TRANSACTION", ctx, requestHash("restock", medicineCode, quantity));
  }

  /** `setQuantity` that records the correction (as a SALE or RESTOCK by direction, source STOCK_COUNT). No idempotency key: a count is absolute. */
  async recordCount(pharmacyCode: string, medicineCode: string, quantity: number, ctx: Pick<MovementContext, "actorUserId"> = {}): Promise<MovementResult> {
    wholeNumber(quantity, "quantity", 0);
    return this.recorded("set", pharmacyCode, medicineCode, this.countPlan(pharmacyCode, medicineCode, quantity), "STOCK_COUNT", ctx, "");
  }

  /** The pharmacy's movement history, newest first (ties broken by id, so the order is always the same). `total` is every movement it has. */
  async history(pharmacyCode: string, page: { limit: number; offset: number }): Promise<{ items: Movement[]; total: number }> {
    const db = this.db(pharmacyCode);
    const [{ rows }, { rows: count }] = await Promise.all([
      db.query<MovementRow>(`SELECT ${MOVEMENT_COLUMNS} FROM inventory_movements ORDER BY occurred_at DESC, id DESC LIMIT $1 OFFSET $2`, [page.limit, page.offset]),
      db.query<{ n: string }>("SELECT count(*) AS n FROM inventory_movements"),
    ]);
    return { items: rows.map((r) => toMovement(pharmacyCode, r)), total: Number(count[0]!.n) };
  }

  /**
   * Counts the shelf and sets the quantity to what was counted. The pharmacy database's trigger records the
   * difference as a SALE (fewer) or a RESTOCK (more); a count equal to the current quantity records nothing.
   */
  setQuantity(pharmacyCode: string, medicineCode: string, quantity: number): Promise<ChangeResult> {
    wholeNumber(quantity, "quantity", 0);
    return this.change("set", pharmacyCode, medicineCode, this.countPlan(pharmacyCode, medicineCode, quantity));
  }

  private countPlan(pharmacyCode: string, medicineCode: string, quantity: number): Plan {
    return async (_tx, before) => {
      if (!before) throw this.notStocked(pharmacyCode, medicineCode);
      return { sql: "UPDATE inventory SET quantity = $2, updated_at = now() WHERE medicine_code = $1", params: [medicineCode, quantity] };
    };
  }

  /** Sets a new price. A price equal to the current one is not a change and records no event. */
  changePrice(pharmacyCode: string, medicineCode: string, price: number): Promise<ChangeResult> {
    const p = money(price);
    return this.change("price", pharmacyCode, medicineCode, async (_tx, before) => {
      if (!before) throw this.notStocked(pharmacyCode, medicineCode);
      return { sql: "UPDATE inventory SET price = $2, updated_at = now() WHERE medicine_code = $1", params: [medicineCode, p] };
    });
  }

  /** Starts stocking a medicine from the MedLink catalogue that the pharmacy does not carry yet. */
  addMedicine(pharmacyCode: string, medicineCode: string, quantity: number, price: number): Promise<ChangeResult> {
    wholeNumber(quantity, "quantity", 0);
    const p = money(price);
    if (!catalogueEntryByCode(medicineCode)) throw new SimulatorError("UNKNOWN_MEDICINE", `${medicineCode} is not in the MedLink catalogue`);
    return this.change("add", pharmacyCode, medicineCode, async (_tx, before) => {
      if (before) {
        throw new SimulatorError("ALREADY_STOCKED", `${pharmacyCode} already carries ${medicineLabel(medicineCode)} (${before.quantity} in stock); use restock`);
      }
      return { sql: "INSERT INTO inventory (medicine_code, quantity, price) VALUES ($1, $2, $3)", params: [medicineCode, quantity, p] };
    });
  }

  /** Stops stocking a medicine (whatever is left on the shelf goes with it). */
  removeMedicine(pharmacyCode: string, medicineCode: string): Promise<ChangeResult> {
    return this.change("remove", pharmacyCode, medicineCode, async (_tx, before) => {
      if (!before) throw this.notStocked(pharmacyCode, medicineCode);
      return { sql: "DELETE FROM inventory WHERE medicine_code = $1", params: [medicineCode] };
    });
  }

  /** The pharmacy's own stock, as its database has it now. */
  async stock(pharmacyCode: string): Promise<Map<string, StockLine>> {
    const { rows } = await this.db(pharmacyCode).query<{ medicine_code: string; quantity: number; price: string }>(
      "SELECT medicine_code, quantity, price FROM inventory ORDER BY medicine_code",
    );
    return new Map(rows.map((r) => [r.medicine_code, { quantity: r.quantity, price: Number(r.price) }]));
  }

  /**
   * Makes the pharmacy's alerts match its stock now (see `evaluateAlerts`). Safe to repeat and to run at the same time as anything else. Unlike the
   * automatic check after a change, a failure is thrown: the caller asked for it. It also catches stock changed some other way (plain SQL) and a
   * changed threshold.
   */
  reconcileAlerts(pharmacyCode: string): Promise<AlertChanges> {
    if (!this.alerts) throw new SimulatorError("INVALID", "low-stock alerts are not switched on for this simulator");
    return evaluateAlerts(this.db(pharmacyCode), this.alerts.lowStockThreshold);
  }

  /** The pharmacy's low-stock alerts, newest first. */
  alertHistory(pharmacyCode: string, filter: { state: AlertState | "ALL"; limit: number; offset: number }): Promise<{ items: StockAlert[]; total: number }> {
    return listAlerts(this.db(pharmacyCode), pharmacyCode, filter);
  }

  /** Each medicine the pharmacy stocks with its risk assessment against the configured threshold and its active alert, riskiest first (ties by code). */
  async stockRisk(pharmacyCode: string): Promise<{ medicineCode: string; quantity: number; assessment: RiskAssessment; alert: { alertId: string; createdAt: Date } | null }[]> {
    if (!this.alerts) throw new SimulatorError("INVALID", "low-stock alerts are not switched on for this simulator");
    const threshold = this.alerts.lowStockThreshold;
    const stock = await stockWithAlerts(this.db(pharmacyCode));
    return stock
      .map((s) => ({ ...s, assessment: assessStockRisk({ quantity: s.quantity, threshold }) }))
      .sort((a, b) => (b.assessment.score ?? -1) - (a.assessment.score ?? -1) || a.medicineCode.localeCompare(b.medicineCode));
  }

  private db(pharmacyCode: string): Db {
    pharmacyByCode(pharmacyCode); // a clear error for an unknown code
    const db = this.pharmacies[pharmacyCode];
    if (!db) throw new SimulatorError("UNKNOWN_PHARMACY", `No database is configured for ${pharmacyCode}`);
    return db;
  }

  private notStocked(pharmacyCode: string, medicineCode: string) {
    return new SimulatorError("NOT_STOCKED", `${pharmacyCode} does not carry ${medicineLabel(medicineCode)}; use add first`);
  }

  private async change(action: ChangeResult["action"], pharmacyCode: string, medicineCode: string, plan: Plan): Promise<ChangeResult> {
    const out = await this.run(action, pharmacyCode, medicineCode, plan);
    return (out as { result: ChangeResult }).result; // without a recording there is nothing to replay
  }

  /** A recorded operation: applies the change and writes its movement, or (same key, same request) returns the movement written before. */
  private async recorded(
    action: ChangeResult["action"],
    pharmacyCode: string,
    medicineCode: string,
    plan: Plan,
    source: Movement["source"],
    ctx: MovementContext,
    hash: string,
  ): Promise<MovementResult> {
    if (ctx.idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(ctx.idempotencyKey)) {
      throw invalid("idempotency key must be 8 to 100 characters: letters, digits and _ . : -");
    }
    const out = await this.run(action, pharmacyCode, medicineCode, plan, { source, ctx, requestHash: hash });
    return "replay" in out ? { movement: out.replay, replayed: true, change: null } : { movement: out.movement, replayed: false, change: out.result };
  }

  /** The movement already recorded for a key: the original when the request is the same, an error when the key is being reused for another. */
  private replayOf(prior: MovementRow, pharmacyCode: string, record: Recording): Movement {
    if (prior.request_hash !== record.requestHash) {
      throw new SimulatorError("IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different request. Use a new key for a new request.");
    }
    return toMovement(pharmacyCode, prior);
  }

  /** `apply`, then (if alerts are switched on) bring the alerts in line with the new stock. A replay changed nothing, so it needs no check. */
  private async run(
    action: ChangeResult["action"],
    pharmacyCode: string,
    medicineCode: string,
    plan: Plan,
    record?: Recording,
  ): Promise<{ result: ChangeResult; movement: Movement | null } | { replay: Movement }> {
    const out = await this.apply(action, pharmacyCode, medicineCode, plan, record);
    if (!("replay" in out) && action !== "price") await this.syncAlerts(pharmacyCode, medicineCode);
    return out;
  }

  /** After a COMMITTED change. Never throws: the change already happened, and the next evaluation (any change, or the next read of the alerts) repairs a miss. */
  private async syncAlerts(pharmacyCode: string, medicineCode: string): Promise<void> {
    if (!this.alerts) return;
    try {
      await evaluateAlerts(this.db(pharmacyCode), this.alerts.lowStockThreshold, medicineCode);
    } catch (err) {
      this.alerts.onAlertError?.(err);
    }
  }

  private async apply(
    action: ChangeResult["action"],
    pharmacyCode: string,
    medicineCode: string,
    plan: Plan,
    record?: Recording,
  ): Promise<{ result: ChangeResult; movement: Movement | null } | { replay: Movement }> {
    const pharmacy = pharmacyByCode(pharmacyCode);
    const key = record?.ctx.idempotencyKey;
    const client = await this.db(pharmacyCode).connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE: two sales at the same moment queue up, so the second sees what the first left. No overselling.
      const { rows: current } = await client.query<{ quantity: number; price: string }>(
        "SELECT quantity, price FROM inventory WHERE medicine_code = $1 FOR UPDATE",
        [medicineCode],
      );
      const before = current[0] ? { quantity: current[0].quantity, price: Number(current[0].price) } : null;

      // Looked up only AFTER the row lock: a duplicate of a request that is still running waits here for it to commit, then finds it.
      if (record && key) {
        const { rows } = await client.query<MovementRow>(`SELECT ${MOVEMENT_COLUMNS} FROM inventory_movements WHERE idempotency_key = $1`, [key]);
        if (rows[0]) {
          const original = this.replayOf(rows[0], pharmacyCode, record);
          await client.query("ROLLBACK");
          return { replay: original };
        }
      }

      const { sql, params } = await plan(client, before);
      await client.query(sql, params);

      const { rows: after } = await client.query<{ quantity: number; price: string }>(
        "SELECT quantity, price FROM inventory WHERE medicine_code = $1",
        [medicineCode],
      );
      // The trigger wrote its outbox rows inside this transaction: they are the ones stamped with its id.
      const { rows: events } = await client.query<{ event_id: string; event_type: string; occurred_at: Date }>(
        "SELECT event_id, event_type, occurred_at FROM outbox WHERE xmin = pg_current_xact_id()::xid ORDER BY id",
      );

      // The movement goes in the same transaction as the stock change and its outbox row: all of them commit, or none does.
      let movement: Movement | null = null;
      if (record && before && after[0] && after[0].quantity !== before.quantity) {
        const delta = after[0].quantity - before.quantity;
        const operation = delta < 0 ? "SALE" : "RESTOCK";
        const { rows } = await client.query<MovementRow>(
          `INSERT INTO inventory_movements (medicine_code, operation, source, quantity_delta, quantity_before, quantity_after, actor_user_id, idempotency_key, request_hash, event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${MOVEMENT_COLUMNS}`,
          [medicineCode, operation, record.source, delta, before.quantity, after[0].quantity, record.ctx.actorUserId ?? null, key ?? null, key ? record.requestHash : null, events.find((e) => e.event_type === operation)?.event_id ?? null],
        );
        movement = toMovement(pharmacyCode, rows[0]!);
      }
      await client.query("COMMIT");

      return {
        movement,
        result: {
          action,
          pharmacyCode,
          pharmacyName: pharmacy.name,
          medicineCode,
          medicineName: medicineLabel(medicineCode),
          before,
          after: after[0] ? { quantity: after[0].quantity, price: Number(after[0].price) } : null,
          events: events.map((e) => ({ eventId: e.event_id, eventType: e.event_type, occurredAt: e.occurred_at })),
        },
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Two requests with the same key for DIFFERENT medicines do not queue on one row lock: the second one to insert loses here.
      // Nothing of it was kept, so look at what the winner recorded and answer as for any other reuse of the key.
      const e = err as { code?: string; constraint?: string };
      if (record && key && e.code === "23505" && e.constraint === IDEMPOTENCY_INDEX) {
        const { rows } = await this.db(pharmacyCode).query<MovementRow>(`SELECT ${MOVEMENT_COLUMNS} FROM inventory_movements WHERE idempotency_key = $1`, [key]);
        if (rows[0]) return { replay: this.replayOf(rows[0], pharmacyCode, record) };
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
