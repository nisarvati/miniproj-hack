import { presentPharmacy, type Db } from "@medlink/db";

export interface Pharmacy {
  id: number;
  /** Public code, e.g. "P001": how events and live stock refer to it. */
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  /** A demo directory listing. True for every pharmacy MedLink knows today. */
  demo: boolean;
  /** A real independent pharmacy shown as a demo directory listing. Never a confirmed MedLink partner. */
  independent: boolean;
  /** false when the map point is not verified: clients give directions by address and show no pin or distance. */
  locationVerified: boolean;
  /** true: stock shown for this pharmacy is synthetic demo data that the named pharmacy has not confirmed. */
  inventorySimulated: boolean;
}

interface Row {
  id: string;
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

/** The persisted row, presented through its directory identity when it has one (name, address, verified point, demo flags). */
export const toPharmacy = (r: Row): Pharmacy => ({ id: Number(r.id), code: r.code, ...presentPharmacy(r) });
const COLUMNS = "id, code, name, address, latitude, longitude";

export async function listPharmacies(db: Db): Promise<Pharmacy[]> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM pharmacies ORDER BY name`);
  return rows.map(toPharmacy).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getPharmacy(db: Db, id: number): Promise<Pharmacy | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM pharmacies WHERE id = $1`, [id]);
  return rows[0] ? toPharmacy(rows[0]) : null;
}

export async function pharmaciesByCodes(db: Db, codes: string[]): Promise<Pharmacy[]> {
  if (!codes.length) return [];
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM pharmacies WHERE code = ANY($1::text[])`, [codes]);
  return rows.map(toPharmacy);
}
