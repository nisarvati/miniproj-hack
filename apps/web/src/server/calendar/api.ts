import { CalendarError, LIMITS, parseCreate, parseRange, parseUpdate } from "./model";
import { createEntry, deleteEntry, getEntry, listEntries, resolvePatientId, updateEntry, type PatientIdentity, type Queryable } from "./repo";

/**
 * The calendar's HTTP behaviour, free of Next.js so it can be tested without a server. The route files hand it the two things that
 * must come from the server side: who the verified session says is calling, and the database.
 *
 * Every request goes through the same gate, in this order: a verified session (else 401), a configured database (else 503), a
 * same-origin JSON request when it changes data, then validation, then a query scoped to the caller's own patient row. A client
 * never says who it is: there is no user id in any request, and fields such as `userId` in a body are never read.
 */
export interface CalendarDeps {
  /** The signed-in patient from the verified Auth.js session, or null. */
  identity: () => Promise<PatientIdentity | null>;
  /** The database, or null when this server has none configured. */
  db: () => Queryable | null;
}

const HEADERS = {
  // Private data: no shared cache may keep it, and the answer depends on whose cookie came with the request.
  "cache-control": "private, no-store",
  vary: "Cookie",
  "x-content-type-options": "nosniff",
};

const json = (status: number, body: unknown) => Response.json(body, { status, headers: HEADERS });
const failure = (e: CalendarError) => json(e.status, { error: { code: e.code, message: e.message, ...(e.details && { details: e.details }) } });

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "57P01", "57P03"]);
const dbUnavailable = (err: unknown): boolean => {
  const e = err as { code?: string; message?: string; errors?: unknown[] };
  if (e.code && (CONNECTION_CODES.has(e.code) || e.code.startsWith("08"))) return true;
  if (Array.isArray(e.errors) && e.errors.some(dbUnavailable)) return true;
  return /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED/i.test(e.message ?? "");
};

/** A browser says where a request came from; only this site may change a patient's calendar, whatever the cookie rules do. */
const crossSite = (req: Request) => {
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
};

async function readJson(req: Request): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new CalendarError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as application/json");
  const text = await req.text();
  if (text.length > LIMITS.bodyBytes) throw new CalendarError(413, "PAYLOAD_TOO_LARGE", "Request is too large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CalendarError(400, "VALIDATION_ERROR", "Invalid request", [{ field: "body", message: "The body is not valid JSON" }]);
  }
}

export function createCalendarApi(deps: CalendarDeps) {
  async function guarded(req: Request, mutates: boolean, run: (db: Queryable, patientId: number) => Promise<Response>): Promise<Response> {
    try {
      const who = await deps.identity();
      if (!who) throw new CalendarError(401, "UNAUTHENTICATED", "Please sign in to use your calendar");
      if (mutates && crossSite(req)) throw new CalendarError(403, "FORBIDDEN", "This request must come from MedLink");
      const db = deps.db();
      if (!db) throw new CalendarError(503, "CALENDAR_NOT_CONFIGURED", "The calendar is not set up on this server yet");
      const patientId = await resolvePatientId(db, who);
      return await run(db, patientId);
    } catch (err) {
      if (err instanceof CalendarError) return failure(err);
      if (dbUnavailable(err)) return failure(new CalendarError(503, "SERVICE_UNAVAILABLE", "The calendar is temporarily unavailable"));
      // Only the error's own message and code are logged: never a request body, a note or a query's parameters.
      console.error("calendar: unexpected error", (err as { code?: string }).code ?? "", (err as Error).message);
      return failure(new CalendarError(500, "INTERNAL_ERROR", "Something went wrong"));
    }
  }

  return {
    list: (req: Request) =>
      guarded(req, false, async (db, patientId) => {
        const range = parseRange(new URL(req.url).searchParams);
        const entries = await listEntries(db, patientId, range);
        return json(200, { data: entries, meta: { from: range.from, to: range.to, count: entries.length, truncated: entries.length === range.limit } });
      }),
    create: (req: Request) =>
      guarded(req, true, async (db, patientId) => {
        const input = parseCreate(await readJson(req));
        return json(201, { data: await createEntry(db, patientId, input) });
      }),
    get: (req: Request, id: string) => guarded(req, false, async (db, patientId) => json(200, { data: await getEntry(db, patientId, id) })),
    update: (req: Request, id: string) =>
      guarded(req, true, async (db, patientId) => {
        const patch = parseUpdate(await readJson(req));
        return json(200, { data: await updateEntry(db, patientId, id, patch) });
      }),
    remove: (req: Request, id: string) =>
      guarded(req, true, async (db, patientId) => {
        await deleteEntry(db, patientId, id);
        return new Response(null, { status: 204, headers: HEADERS });
      }),
  };
}

export type CalendarApi = ReturnType<typeof createCalendarApi>;
