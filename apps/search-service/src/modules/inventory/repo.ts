import type { Db } from "@medlink/db";

export interface InventoryItem {
  id: number;
  pharmacyId: number;
  pharmacyName: string;
  medicineId: number;
  brandName: string;
  dosage: string;
  quantity: number;
  price: number;
  updatedAt: string;
}

interface Row {
  id: string;
  pharmacy_id: string;
  pharmacy_name: string;
  medicine_id: string;
  brand_name: string;
  dosage: string;
  quantity: number;
  price: string;
  updated_at: Date;
}

const SELECT = `
  SELECT i.id, i.pharmacy_id, p.name AS pharmacy_name, i.medicine_id, m.brand_name, m.dosage,
         i.quantity, i.price, i.updated_at
  FROM inventory i
  JOIN pharmacies p ON p.id = i.pharmacy_id
  JOIN medicines m ON m.id = i.medicine_id`;

const toItem = (r: Row): InventoryItem => ({
  id: Number(r.id),
  pharmacyId: Number(r.pharmacy_id),
  pharmacyName: r.pharmacy_name,
  medicineId: Number(r.medicine_id),
  brandName: r.brand_name,
  dosage: r.dosage,
  quantity: r.quantity,
  price: Number(r.price),
  updatedAt: r.updated_at.toISOString(),
});

export interface InventoryFilter {
  pharmacyId?: number;
  medicineId?: number;
  limit: number;
  offset: number;
}

export async function listInventory(db: Db, f: InventoryFilter): Promise<InventoryItem[]> {
  const { rows } = await db.query<Row>(
    `${SELECT}
     WHERE ($1::bigint IS NULL OR i.pharmacy_id = $1) AND ($2::bigint IS NULL OR i.medicine_id = $2)
     ORDER BY i.id LIMIT $3 OFFSET $4`,
    [f.pharmacyId ?? null, f.medicineId ?? null, f.limit, f.offset],
  );
  return rows.map(toItem);
}

export async function getInventory(db: Db, id: number): Promise<InventoryItem | null> {
  const { rows } = await db.query<Row>(`${SELECT} WHERE i.id = $1`, [id]);
  return rows[0] ? toItem(rows[0]) : null;
}
