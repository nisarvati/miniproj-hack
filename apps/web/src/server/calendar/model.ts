/**
 * The calendar's vocabulary and its input rules, with no database and no framework in them: what an entry is, and what a request
 * may contain. Every request body and query string is checked here before anything touches the database. Fields a client has no
 * business sending (an owner, an id, timestamps, a status on creation) are not read at all.
 */

export const ENTRY_TYPES = ["WANT_TO_GET", "ORDERED", "PURCHASED", "REMINDER"] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
export const ENTRY_STATUSES = ["OPEN", "DONE"] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const LIMITS = {
  medicineName: 200,
  notes: 1000,
  /** Entries a person may keep. A guard against runaway use, far above real use. */
  entriesPerPatient: 2000,
  /** The widest date range one request may ask for, in days. */
  rangeDays: 372,
  listLimit: 1000,
  firstDate: "2000-01-01",
  lastDate: "2100-12-31",
  bodyBytes: 16_384,
} as const;

/** One entry as the API returns it. `date` is a calendar day, "YYYY-MM-DD", exactly as the person picked it. */
export interface CalendarEntry {
  id: string;
  medicineId: number | null;
  medicineName: string;
  type: EntryType;
  date: string;
  notes: string | null;
  status: EntryStatus;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An error whose status and message are safe to send to the client. */
export class CalendarError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { field: string; message: string }[],
  ) {
    super(message);
  }
}

type Issue = { field: string; message: string };
const invalid = (issues: Issue[]): never => {
  throw new CalendarError(400, "VALIDATION_ERROR", "Invalid request", issues);
};

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day in the supported years (so "2026-02-30" and "2026-13-01" are rejected, not rolled over). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return false;
  return value >= LIMITS.firstDate && value <= LIMITS.lastDate;
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readType(raw: unknown, issues: Issue[]): EntryType | undefined {
  if (!ENTRY_TYPES.includes(raw as EntryType)) {
    issues.push({ field: "type", message: `type must be one of ${ENTRY_TYPES.join(", ")}` });
    return undefined;
  }
  return raw as EntryType;
}
function readDate(raw: unknown, field: string, issues: Issue[]): string | undefined {
  if (!isCalendarDate(raw)) {
    issues.push({ field, message: `${field} must be a real date as YYYY-MM-DD, between ${LIMITS.firstDate} and ${LIMITS.lastDate}` });
    return undefined;
  }
  return raw;
}
function readNotes(raw: unknown, issues: Issue[]): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length > LIMITS.notes) {
    issues.push({ field: "notes", message: `notes must be text of at most ${LIMITS.notes} characters` });
    return undefined;
  }
  return raw.trim() === "" ? null : raw.trim();
}
function readMedicineId(raw: unknown, issues: Issue[]): number | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    issues.push({ field: "medicineId", message: "medicineId must be a positive whole number" });
    return undefined;
  }
  return raw;
}
function readName(raw: unknown, issues: Issue[]): string | undefined {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > LIMITS.medicineName) {
    issues.push({ field: "medicineName", message: `medicineName must be 1 to ${LIMITS.medicineName} characters` });
    return undefined;
  }
  return name;
}

export interface CreateInput {
  medicineId: number | null;
  /** Used only when there is no medicineId; for a catalogue medicine the server takes the name from the catalogue. */
  medicineName: string | null;
  type: EntryType;
  date: string;
  notes: string | null;
}

export function parseCreate(body: unknown): CreateInput {
  if (!isPlainObject(body)) return invalid([{ field: "body", message: "Expected a JSON object" }]);
  const issues: Issue[] = [];
  const type = readType(body.type, issues);
  const date = readDate(body.date, "date", issues);
  const notes = body.notes === undefined ? null : readNotes(body.notes, issues);
  const medicineId = body.medicineId === undefined ? null : readMedicineId(body.medicineId, issues);
  // A free-text name is required when there is no catalogue medicine to take it from.
  const medicineName = medicineId === null ? readName(body.medicineName, issues) : null;
  if (issues.length) return invalid(issues);
  return { medicineId: medicineId ?? null, medicineName: medicineName ?? null, type: type!, date: date!, notes: notes ?? null };
}

export interface UpdateInput {
  /** undefined: leave as it is. null: detach from the catalogue (keeps the name). number: attach to this catalogue medicine. */
  medicineId?: number | null;
  medicineName?: string;
  type?: EntryType;
  date?: string;
  notes?: string | null;
  status?: EntryStatus;
}

export function parseUpdate(body: unknown): UpdateInput {
  if (!isPlainObject(body)) return invalid([{ field: "body", message: "Expected a JSON object" }]);
  const issues: Issue[] = [];
  const out: UpdateInput = {};
  if (body.type !== undefined) out.type = readType(body.type, issues);
  if (body.date !== undefined) out.date = readDate(body.date, "date", issues);
  if (body.notes !== undefined) out.notes = readNotes(body.notes, issues);
  if (body.medicineId !== undefined) out.medicineId = readMedicineId(body.medicineId, issues);
  if (body.medicineName !== undefined) out.medicineName = readName(body.medicineName, issues);
  if (body.status !== undefined) {
    if (!ENTRY_STATUSES.includes(body.status as EntryStatus)) issues.push({ field: "status", message: `status must be one of ${ENTRY_STATUSES.join(", ")}` });
    else out.status = body.status as EntryStatus;
  }
  if (issues.length) return invalid(issues);
  if (Object.values(out).every((v) => v === undefined)) return invalid([{ field: "body", message: "Nothing to change" }]);
  return out;
}

export interface RangeQuery {
  from: string;
  to: string;
  limit: number;
}

export function parseRange(params: URLSearchParams): RangeQuery {
  const issues: Issue[] = [];
  const from = readDate(params.get("from"), "from", issues);
  const to = readDate(params.get("to"), "to", issues);
  let limit: number = LIMITS.listLimit;
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    const n = Number(rawLimit);
    if (!/^\d+$/.test(rawLimit) || n < 1 || n > LIMITS.listLimit) issues.push({ field: "limit", message: `limit must be a whole number from 1 to ${LIMITS.listLimit}` });
    else limit = n;
  }
  if (from && to) {
    if (to < from) issues.push({ field: "to", message: "to must not be before from" });
    else if (dayNumber(to) - dayNumber(from) > LIMITS.rangeDays) issues.push({ field: "to", message: `The range may span at most ${LIMITS.rangeDays} days` });
  }
  if (issues.length) return invalid(issues);
  return { from: from!, to: to!, limit };
}
