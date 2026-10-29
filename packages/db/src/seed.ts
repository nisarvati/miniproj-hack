import type { Db } from "./pool.js";
import { inventoryFor, MEDICINES, PHARMACIES } from "./seed-data.js";

/** Idempotent: re-running resets seeded inventory rows to their seed values. */
export async function seed(db: Db): Promise<{ medicines: number; pharmacies: number; inventory: number }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const medicineIds: number[] = [];
    for (const m of MEDICINES) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO medicines (code, brand_name, generic_name, dosage, form)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (brand_name, dosage, form) DO UPDATE SET generic_name = EXCLUDED.generic_name, code = EXCLUDED.code
         RETURNING id`,
        [m.code, m.brand, m.generic, m.dosage, m.form],
      );
      medicineIds.push(Number(rows[0]!.id));
    }

    const pharmacyIds: number[] = [];
    for (const p of PHARMACIES) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO pharmacies (code, name, address, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name, address) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude, code = EXCLUDED.code
         RETURNING id`,
        [p.code, p.name, p.address, p.latitude, p.longitude],
      );
      pharmacyIds.push(Number(rows[0]!.id));
    }

    let inventory = 0;
    for (const [pi] of PHARMACIES.entries()) {
      for (const row of inventoryFor(pi)) {
        await client.query(
          `INSERT INTO inventory (pharmacy_id, medicine_id, quantity, price)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (pharmacy_id, medicine_id)
           DO UPDATE SET quantity = EXCLUDED.quantity, price = EXCLUDED.price, updated_at = now()`,
          [pharmacyIds[pi], medicineIds[MEDICINES.indexOf(row.medicine)], row.quantity, row.price],
        );
        inventory++;
      }
    }

    await client.query("COMMIT");
    return { medicines: medicineIds.length, pharmacies: pharmacyIds.length, inventory };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
