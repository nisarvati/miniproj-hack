import type { PoolClient } from "pg";
import type { Db } from "@medlink/db";
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

/**
 * What pharmacy software does: it changes the pharmacy's OWN database with plain SQL and knows nothing about MedLink.
 * The pharmacy schema's trigger records an event for every change in the same transaction (the outbox), and the
 * connector, sync service and notification service take it from there. This class never talks to Redis.
 *
 * Every operation locks the row, checks, changes and returns the events the database recorded, in one transaction.
 * A refused operation (selling more than is on the shelf, say) changes nothing and records nothing.
 */
export class PharmacySimulator {
  constructor(private readonly pharmacies: Record<string, Db>) {}

  /** Sells `quantity` units. Cannot sell more than is on the shelf. */
  sell(pharmacyCode: string, medicineCode: string, quantity: number): Promise<ChangeResult> {
    wholeNumber(quantity, "quantity", 1);
    return this.change("sell", pharmacyCode, medicineCode, async (_tx, before) => {
      if (!before) throw this.notStocked(pharmacyCode, medicineCode);
      if (before.quantity < quantity) {
        throw new SimulatorError("INSUFFICIENT_STOCK", `${pharmacyCode} has only ${before.quantity} of ${medicineLabel(medicineCode)}, cannot sell ${quantity}`);
      }
      return { sql: "UPDATE inventory SET quantity = quantity - $2, updated_at = now() WHERE medicine_code = $1", params: [medicineCode, quantity] };
    });
  }

  /** Receives `quantity` more units of a medicine the pharmacy already carries. */
  restock(pharmacyCode: string, medicineCode: string, quantity: number): Promise<ChangeResult> {
    wholeNumber(quantity, "quantity", 1);
    return this.change("restock", pharmacyCode, medicineCode, async (_tx, before) => {
      if (!before) throw this.notStocked(pharmacyCode, medicineCode);
      if (before.quantity + quantity > MAX) throw invalid(`stock cannot exceed ${MAX} units`);
      return { sql: "UPDATE inventory SET quantity = quantity + $2, updated_at = now() WHERE medicine_code = $1", params: [medicineCode, quantity] };
    });
  }

  /**
   * Counts the shelf and sets the quantity to what was counted. The pharmacy database's trigger records the
   * difference as a SALE (fewer) or a RESTOCK (more); a count equal to the current quantity records nothing.
   */
  setQuantity(pharmacyCode: string, medicineCode: string, quantity: number): Promise<ChangeResult> {
    wholeNumber(quantity, "quantity", 0);
    return this.change("set", pharmacyCode, medicineCode, async (_tx, before) => {
      if (!before) throw this.notStocked(pharmacyCode, medicineCode);
      return { sql: "UPDATE inventory SET quantity = $2, updated_at = now() WHERE medicine_code = $1", params: [medicineCode, quantity] };
    });
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

  private db(pharmacyCode: string): Db {
    pharmacyByCode(pharmacyCode); // a clear error for an unknown code
    const db = this.pharmacies[pharmacyCode];
    if (!db) throw new SimulatorError("UNKNOWN_PHARMACY", `No database is configured for ${pharmacyCode}`);
    return db;
  }

  private notStocked(pharmacyCode: string, medicineCode: string) {
    return new SimulatorError("NOT_STOCKED", `${pharmacyCode} does not carry ${medicineLabel(medicineCode)}; use add first`);
  }

  private async change(
    action: ChangeResult["action"],
    pharmacyCode: string,
    medicineCode: string,
    plan: (tx: PoolClient, before: StockLine | null) => Promise<{ sql: string; params: unknown[] }>,
  ): Promise<ChangeResult> {
    const pharmacy = pharmacyByCode(pharmacyCode);
    const client = await this.db(pharmacyCode).connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE: two sales at the same moment queue up, so the second sees what the first left. No overselling.
      const { rows: current } = await client.query<{ quantity: number; price: string }>(
        "SELECT quantity, price FROM inventory WHERE medicine_code = $1 FOR UPDATE",
        [medicineCode],
      );
      const before = current[0] ? { quantity: current[0].quantity, price: Number(current[0].price) } : null;

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
      await client.query("COMMIT");

      return {
        action,
        pharmacyCode,
        pharmacyName: pharmacy.name,
        medicineCode,
        medicineName: medicineLabel(medicineCode),
        before,
        after: after[0] ? { quantity: after[0].quantity, price: Number(after[0].price) } : null,
        events: events.map((e) => ({ eventId: e.event_id, eventType: e.event_type, occurredAt: e.occurred_at })),
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
