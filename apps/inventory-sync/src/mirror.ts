import type { Db } from "@medlink/db";
import type { Logger } from "./logger.js";
import type { InventoryItem } from "./state.js";

/**
 * Keeps MedLink's central `inventory` table in step with the live state in Redis.
 *
 * Search prefers live stock, but falls back to this table when Redis is down or has never heard of a medicine, so
 * without the mirror that fallback would show whatever the table was seeded with, however much has changed since.
 *
 * It copies the item as Redis now has it (already ordered and de-duplicated by the state handler), not the raw
 * event, so applying it twice, or out of order, is harmless:
 *  - a row is only written if it is not newer than what we are writing (`updated_at <= asOf`), so a slow writer
 *    can never put an older value over a newer one;
 *  - a removed medicine is deleted; one Redis knows no price for yet only gets its quantity updated, because the
 *    table requires a price.
 *
 * Best effort: a failure is logged and counted, not thrown. The state change is already committed in Redis along
 * with the dedup marker, so retrying the event would be skipped as a duplicate anyway. The next event for the same
 * medicine writes the then-current state, which heals it.
 */
export class CatalogueMirror {
  /** written: copied to (or confirmed in) the central table. unmatched: the central table has no such pharmacy or medicine, so nothing was copied. failed: the database errored. */
  readonly stats = { written: 0, failed: 0, unmatched: 0 };

  constructor(
    private readonly db: Db,
    private readonly log?: Pick<Logger, "warn">,
  ) {}

  async mirror(item: InventoryItem): Promise<void> {
    const asOf = [item.quantityAsOf, item.priceAsOf].filter((t): t is string => t !== null).sort().at(-1);
    if (!asOf) return;
    try {
      let rowCount: number | null;
      if (item.removed) {
        ({ rowCount } = await this.db.query(
          `DELETE FROM inventory
           WHERE pharmacy_id = (SELECT id FROM pharmacies WHERE code = $1)
             AND medicine_id = (SELECT id FROM medicines WHERE code = $2)
             AND updated_at <= $3`,
          [item.pharmacyId, item.medicineId, asOf],
        ));
      } else if (item.price === null) {
        ({ rowCount } = await this.db.query(
          `UPDATE inventory SET quantity = $3, updated_at = $4
           WHERE pharmacy_id = (SELECT id FROM pharmacies WHERE code = $1)
             AND medicine_id = (SELECT id FROM medicines WHERE code = $2)
             AND updated_at <= $4`,
          [item.pharmacyId, item.medicineId, item.quantity, asOf],
        ));
      } else {
        ({ rowCount } = await this.db.query(
          `INSERT INTO inventory (pharmacy_id, medicine_id, quantity, price, updated_at)
           SELECT p.id, m.id, $3, $4, $5 FROM pharmacies p, medicines m WHERE p.code = $1 AND m.code = $2
           ON CONFLICT (pharmacy_id, medicine_id) DO UPDATE
             SET quantity = EXCLUDED.quantity, price = EXCLUDED.price, updated_at = EXCLUDED.updated_at
             WHERE inventory.updated_at <= EXCLUDED.updated_at`,
          [item.pharmacyId, item.medicineId, item.quantity, item.price, asOf],
        ));
      }
      // Nothing changed. That is fine when the row is already newer or already gone, but not when the central table
      // has never heard of the pharmacy or the medicine: then the item was NOT mirrored and must not be counted as such.
      if (!rowCount && !(await this.known(item))) {
        this.stats.unmatched++;
        this.log?.warn({ pharmacyId: item.pharmacyId, medicineId: item.medicineId }, "not mirrored to the catalogue database: no such pharmacy or medicine there");
        return;
      }
      this.stats.written++;
    } catch (err) {
      this.stats.failed++;
      this.log?.warn({ pharmacyId: item.pharmacyId, medicineId: item.medicineId, error: (err as Error).message }, "could not mirror stock to the catalogue database");
    }
  }

  /** Whether both the pharmacy and the medicine exist in the central database. */
  private async known(item: InventoryItem): Promise<boolean> {
    const { rows } = await this.db.query<{ ok: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pharmacies WHERE code = $1) AND EXISTS (SELECT 1 FROM medicines WHERE code = $2) AS ok",
      [item.pharmacyId, item.medicineId],
    );
    return rows[0]?.ok === true;
  }
}
