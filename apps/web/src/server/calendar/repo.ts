import type { Pool } from "pg";
import { CalendarError, LIMITS, UUID_RE, type CalendarEntry, type CreateInput, type EntryStatus, type EntryType, type RangeQuery, type UpdateInput } from "./model";

/** All the calendar needs from a database client; a `pg` Pool satisfies it. */
export type Queryable = Pick<Pool, "query">;

/** Who the server has established the signed-in person to be. Built only from the verified session, never from a request body. */
export interface PatientIdentity {
  provider: "google";
  /** The provider's stable account identifier (Google's `sub`). */
  subject: string;
  email: string | null;
  name: string | null;
}

/**
 * Finds the patient for a verified identity, creating the row the first time. Keyed by the provider's own identifier: never by
 * email, so two accounts can never be merged because an email address matched. Concurrent first sign-ins converge on one row:
 * the unique (provider, subject) constraint decides, and the loser's insert becomes an update.
 */
export async function resolvePatientId(db: Queryable, who: PatientIdentity): Promise<number> {
  const found = await db.query<{ id: string; email: string | null; name: string | null }>(
    "SELECT id, email, name FROM patients WHERE provider = $1 AND provider_subject = $2",
    [who.provider, who.subject],
  );
  const row = found.rows[0];
  if (row) {
    // Keep the display details current, but only write when they changed.
    if (row.email !== who.email || row.name !== who.name) {
      await db.query("UPDATE patients SET email = $3, name = $4 WHERE provider = $1 AND provider_subject = $2", [who.provider, who.subject, who.email, who.name]);
    }
    return Number(row.id);
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO patients (provider, provider_subject, email, name) VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider, provider_subject) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
     RETURNING id`,
    [who.provider, who.subject, who.email, who.name],
  );
  return Number(rows[0]!.id);
}

interface EntryRow {
  id: string;
  medicine_id: string | null;
  medicine_name: string;
  entry_type: EntryType;
  entry_date: string;
  notes: string | null;
  status: EntryStatus;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// to_char: a DATE column is sent as text, because the driver would turn it into a Date at local midnight and shift the day.
const COLUMNS = `e.id, e.medicine_id, e.medicine_name, e.entry_type, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
  e.notes, e.status, e.completed_at, e.created_at, e.updated_at`;

const toEntry = (r: EntryRow): CalendarEntry => ({
  id: r.id,
  medicineId: r.medicine_id === null ? null : Number(r.medicine_id),
  medicineName: r.medicine_name,
  type: r.entry_type,
  date: r.entry_date,
  notes: r.notes,
  status: r.status,
  completedAt: r.completed_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const unknownMedicine = () => new CalendarError(400, "VALIDATION_ERROR", "Invalid request", [{ field: "medicineId", message: "That medicine is not in the MedLink catalogue" }]);
const notFound = () => new CalendarError(404, "NOT_FOUND", "Entry not found");

/** The name a catalogue medicine is saved under, taken from the catalogue itself so the client cannot choose it. */
async function catalogueName(db: Queryable, medicineId: number): Promise<string> {
  const { rows } = await db.query<{ name: string }>("SELECT brand_name || ' ' || dosage || ' ' || form AS name FROM medicines WHERE id = $1", [medicineId]);
  if (!rows[0]) throw unknownMedicine();
  return rows[0].name;
}
const isForeignKeyViolation = (err: unknown) => (err as { code?: string }).code === "23503";

export async function listEntries(db: Queryable, patientId: number, range: RangeQuery): Promise<CalendarEntry[]> {
  const { rows } = await db.query<EntryRow>(
    `SELECT ${COLUMNS} FROM medicine_calendar_entries e
     WHERE e.patient_id = $1 AND e.entry_date BETWEEN $2::date AND $3::date
     ORDER BY e.entry_date, e.created_at, e.id LIMIT $4`,
    [patientId, range.from, range.to, range.limit],
  );
  return rows.map(toEntry);
}

export async function getEntry(db: Queryable, patientId: number, id: string): Promise<CalendarEntry> {
  if (!UUID_RE.test(id)) throw notFound();
  const { rows } = await db.query<EntryRow>(`SELECT ${COLUMNS} FROM medicine_calendar_entries e WHERE e.id = $1 AND e.patient_id = $2`, [id, patientId]);
  if (!rows[0]) throw notFound();
  return toEntry(rows[0]);
}

export async function createEntry(db: Queryable, patientId: number, input: CreateInput): Promise<CalendarEntry> {
  const name = input.medicineId === null ? input.medicineName! : await catalogueName(db, input.medicineId);
  try {
    // The cap is part of the insert, so two racing requests cannot both slip under it by much.
    const { rows } = await db.query<EntryRow>(
      `WITH inserted AS (
         INSERT INTO medicine_calendar_entries (patient_id, medicine_id, medicine_name, entry_type, entry_date, notes)
         SELECT $1::bigint, $2::bigint, $3::text, $4::text, $5::date, $6::text
         WHERE (SELECT count(*) FROM medicine_calendar_entries WHERE patient_id = $1::bigint) < $7::int
         RETURNING *
       )
       SELECT ${COLUMNS} FROM inserted e`,
      [patientId, input.medicineId, name, input.type, input.date, input.notes, LIMITS.entriesPerPatient],
    );
    if (!rows[0]) throw new CalendarError(409, "LIMIT_REACHED", `You can keep up to ${LIMITS.entriesPerPatient} entries. Delete some to add more.`);
    return toEntry(rows[0]);
  } catch (err) {
    if (isForeignKeyViolation(err)) throw unknownMedicine();
    throw err;
  }
}

export async function updateEntry(db: Queryable, patientId: number, id: string, patch: UpdateInput): Promise<CalendarEntry> {
  if (!UUID_RE.test(id)) throw notFound();
  const sets: string[] = [];
  const params: unknown[] = [id, patientId];
  const set = (column: string, value: unknown, cast = "") => sets.push(`${column} = $${params.push(value)}${cast}`);

  if (typeof patch.medicineId === "number") {
    set("medicine_id", patch.medicineId);
    set("medicine_name", await catalogueName(db, patch.medicineId));
  } else {
    if (patch.medicineId === null) sets.push("medicine_id = NULL");
    if (patch.medicineName !== undefined) set("medicine_name", patch.medicineName);
  }
  if (patch.type !== undefined) set("entry_type", patch.type);
  if (patch.date !== undefined) set("entry_date", patch.date, "::date");
  if (patch.notes !== undefined) set("notes", patch.notes);
  if (patch.status !== undefined) {
    const p = params.push(patch.status);
    sets.push(`status = $${p}`, `completed_at = CASE WHEN $${p} = 'DONE' THEN COALESCE(e.completed_at, now()) ELSE NULL END`);
  }
  sets.push("updated_at = now()");
  try {
    // One statement scoped to both the entry and its owner: someone else's entry is simply not found.
    const { rows } = await db.query<EntryRow>(
      `UPDATE medicine_calendar_entries e SET ${sets.join(", ")} WHERE e.id = $1 AND e.patient_id = $2 RETURNING ${COLUMNS}`,
      params,
    );
    if (!rows[0]) throw notFound();
    return toEntry(rows[0]);
  } catch (err) {
    if (isForeignKeyViolation(err)) throw unknownMedicine();
    throw err;
  }
}

export async function deleteEntry(db: Queryable, patientId: number, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw notFound();
  const { rowCount } = await db.query("DELETE FROM medicine_calendar_entries WHERE id = $1 AND patient_id = $2", [id, patientId]);
  if (!rowCount) throw notFound();
}
