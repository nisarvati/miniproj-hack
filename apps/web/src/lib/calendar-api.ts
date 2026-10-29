import type { CalendarEntry, EntryStatus, EntryType } from "../server/calendar/model";

export type { CalendarEntry, EntryStatus, EntryType };

/** What each entry type means, in the person's words. These are the person's own records: MedLink places and verifies nothing. */
export const ENTRY_TYPE_INFO: Record<EntryType, { label: string; hint: string }> = {
  WANT_TO_GET: { label: "Want to get", hint: "A medicine you plan to get." },
  ORDERED: { label: "Ordered", hint: "You noted that you ordered it. MedLink did not place or check any order." },
  PURCHASED: { label: "Purchased", hint: "You noted that you bought it. MedLink did not process or verify any purchase." },
  REMINDER: { label: "Reminder", hint: "A personal reminder for this day. MedLink sends no email or message." },
};
export const ENTRY_TYPE_ORDER: readonly EntryType[] = ["WANT_TO_GET", "ORDERED", "PURCHASED", "REMINDER"];

/** An error whose message is safe and useful to show. `unauthorized`: the session is gone, and nothing private should stay on screen. */
export class CalendarApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "unauthorized" | "validation" | "unavailable" | "network" | "notFound" | "conflict" | "unknown",
    public readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: { field: string; message: string }[] };
}

async function failure(res: Response): Promise<CalendarApiError> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  const code = body.error?.code;
  switch (res.status) {
    case 401:
      return new CalendarApiError("Your session has ended. Please sign in again.", "unauthorized");
    case 400: {
      const fields = body.error?.details ?? [];
      return new CalendarApiError(fields.map((d) => d.message).join(". ") || "Please check what you entered.", "validation", fields);
    }
    case 404:
      return new CalendarApiError("That entry no longer exists.", "notFound");
    case 409:
      return new CalendarApiError(body.error?.message ?? "That could not be saved.", "conflict");
    case 503:
      return new CalendarApiError(code === "CALENDAR_NOT_CONFIGURED" ? "The calendar is not set up on this server yet." : "The calendar is temporarily unavailable. Please try again in a moment.", "unavailable");
    default:
      return new CalendarApiError("Something went wrong on our side. Please try again.", "unknown");
  }
}

async function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, headers, ...rest } = init;
  try {
    return await fetch(`/calendar-api${path}`, {
      ...rest,
      // The answer is private to whoever's cookie this is: never from a cache, never stored.
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json", ...(json !== undefined && { "content-type": "application/json" }), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new CalendarApiError("Can't reach MedLink. Check your connection and try again.", "network");
  }
}

const isEntry = (v: unknown): v is CalendarEntry => typeof v === "object" && v !== null && typeof (v as CalendarEntry).id === "string" && typeof (v as CalendarEntry).date === "string";

async function entryFrom(res: Response): Promise<CalendarEntry> {
  if (!res.ok) throw await failure(res);
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!isEntry(body?.data)) throw new CalendarApiError("Unexpected response from MedLink.", "unknown");
  return body.data;
}

export async function listCalendarEntries(from: string, to: string, signal?: AbortSignal): Promise<{ entries: CalendarEntry[]; truncated: boolean }> {
  const res = await call(`/entries?from=${from}&to=${to}`, { signal });
  if (!res.ok) throw await failure(res);
  const body = (await res.json().catch(() => null)) as { data?: unknown; meta?: { truncated?: boolean } } | null;
  if (!Array.isArray(body?.data) || !body.data.every(isEntry)) throw new CalendarApiError("Unexpected response from MedLink.", "unknown");
  return { entries: body.data, truncated: body.meta?.truncated === true };
}

export interface NewEntry {
  medicineId?: number | null;
  medicineName?: string;
  type: EntryType;
  date: string;
  notes?: string | null;
}

export const createCalendarEntry = async (input: NewEntry): Promise<CalendarEntry> => entryFrom(await call("/entries", { method: "POST", json: input }));
export const updateCalendarEntry = async (id: string, patch: Partial<NewEntry> & { status?: EntryStatus }): Promise<CalendarEntry> => entryFrom(await call(`/entries/${id}`, { method: "PATCH", json: patch }));
export async function deleteCalendarEntry(id: string): Promise<void> {
  const res = await call(`/entries/${id}`, { method: "DELETE" });
  if (!res.ok) throw await failure(res);
}
