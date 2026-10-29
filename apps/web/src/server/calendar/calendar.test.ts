/**
 * The calendar against a real PostgreSQL (the isolated `<db>_test` database; it is reset first, so nothing here can touch
 * development data): the migration, patient identity, every endpoint, validation, authorization and per-user isolation.
 * These are integration tests of the API layer and the database. They do not run Next.js or a browser, and they cannot mint a
 * Google session: who is "signed in" is supplied as the identity the real route files would get from Auth.js.
 */
import type { Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCalendarApi } from "./api";
import { isCalendarDate, LIMITS, type CalendarEntry } from "./model";
import { resolvePatientId, type PatientIdentity, type Queryable } from "./repo";

let db: Db;
beforeAll(async () => {
  db = await freshSeededDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await db.query("TRUNCATE medicine_calendar_entries, patients RESTART IDENTITY CASCADE");
});

const person = (subject: string, email = `${subject}@example.com`): PatientIdentity => ({ provider: "google", subject, email, name: subject });
const apiFor = (who: PatientIdentity | null, database: Queryable | null = db) => createCalendarApi({ identity: async () => who, db: () => database });

const BASE = "http://localhost:3000/calendar-api/entries";
const req = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.json !== undefined && { "content-type": "application/json" }), ...(init.headers as Record<string, string>) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });

type Api = ReturnType<typeof apiFor>;
const create = (api: Api, body: unknown) => api.create(req("", { method: "POST", json: body }));
const created = async (api: Api, body: Record<string, unknown>): Promise<CalendarEntry> => {
  const res = await create(api, { medicineName: "Paracetamol 500mg", type: "WANT_TO_GET", date: "2026-11-05", ...body });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: CalendarEntry }).data;
};
const list = async (api: Api, from = "2026-11-01", to = "2026-11-30") => {
  const res = await api.list(req(`?from=${from}&to=${to}`));
  return { res, body: (await res.json()) as { data: CalendarEntry[]; meta: Record<string, unknown>; error?: { code: string; details?: unknown } } };
};
const count = async (table: string) => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

describe("the migration", () => {
  it("creates patients and entries with the constraints and the index the calendar relies on", async () => {
    const { rows: idx } = await db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename IN ('patients','medicine_calendar_entries')");
    const names = idx.map((r) => r.indexname);
    expect(names).toEqual(expect.arrayContaining(["patients_identity_unique", "medicine_calendar_entries_patient_date"]));
    const { rows: cols } = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'medicine_calendar_entries_patient_date'");
    expect(cols[0]!.indexdef).toMatch(/\(patient_id, entry_date, created_at, id\)/);
    await db.query("INSERT INTO patients (provider, provider_subject) VALUES ('google', 'x')");
    await expect(db.query("INSERT INTO patients (provider, provider_subject) VALUES ('google', 'x')")).rejects.toThrow(/patients_identity_unique/);
    await expect(db.query("INSERT INTO patients (provider, provider_subject) VALUES ('github', 'y')")).rejects.toThrow();
    const bad = (sql: string) => expect(db.query(sql)).rejects.toThrow();
    const base = "INSERT INTO medicine_calendar_entries (patient_id, medicine_name, entry_type, entry_date, status, completed_at) SELECT id, 'x',";
    await bad(`${base} 'SOLD', '2026-01-01', 'OPEN', NULL FROM patients`);
    await bad(`${base} 'REMINDER', '2026-01-01', 'DONE', NULL FROM patients`);
    await bad(`${base} 'REMINDER', '2026-01-01', 'OPEN', now() FROM patients`);
    await bad(`INSERT INTO medicine_calendar_entries (patient_id, medicine_name, entry_type, entry_date) VALUES (999, 'x', 'REMINDER', '2026-01-01')`);
  });

  it("is already applied by the normal migration runner (idempotent)", async () => {
    const { migrate } = await import("@medlink/db");
    expect(await migrate(db)).toEqual([]);
  });
});

describe("patient identity", () => {
  it("creates a patient on first sight and finds the same one afterwards", async () => {
    const a = await resolvePatientId(db, person("g-1"));
    expect(await resolvePatientId(db, person("g-1"))).toBe(a);
    expect(await count("patients")).toBe(1);
  });

  it("many simultaneous first sign-ins of one account make exactly one patient", async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, () => resolvePatientId(db, person("racer"))));
    expect(new Set(ids).size).toBe(1);
    expect(await count("patients")).toBe(1);
  });

  it("never merges accounts by email: the same email under another Google account is another patient", async () => {
    const a = await resolvePatientId(db, person("g-a", "same@example.com"));
    const b = await resolvePatientId(db, person("g-b", "same@example.com"));
    expect(a).not.toBe(b);
    expect(await count("patients")).toBe(2);
  });

  it("keeps the display email and name current without changing who the patient is", async () => {
    const id = await resolvePatientId(db, { ...person("g-c"), email: "old@example.com" });
    expect(await resolvePatientId(db, { ...person("g-c"), email: "new@example.com", name: "New Name" })).toBe(id);
    const { rows } = await db.query<{ email: string; name: string }>("SELECT email, name FROM patients WHERE id = $1", [id]);
    expect(rows[0]).toEqual({ email: "new@example.com", name: "New Name" });
  });
});

describe("creating, reading, updating, completing and deleting entries", () => {
  it("creates an entry that is really in the database and comes back on a list", async () => {
    const api = apiFor(person("alice"));
    const res = await create(api, { medicineName: "  Vitamin   D3 ", type: "REMINDER", date: "2026-11-12", notes: "  after breakfast " });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: CalendarEntry };
    expect(data).toMatchObject({ medicineId: null, medicineName: "Vitamin D3", type: "REMINDER", date: "2026-11-12", notes: "after breakfast", status: "OPEN", completedAt: null });
    expect(data.id).toMatch(/^[0-9a-f-]{36}$/);
    const row = (await db.query<{ medicine_name: string; entry_date: string; patient_id: string }>("SELECT medicine_name, to_char(entry_date,'YYYY-MM-DD') AS entry_date, patient_id FROM medicine_calendar_entries WHERE id = $1", [data.id])).rows[0]!;
    expect(row).toMatchObject({ medicine_name: "Vitamin D3", entry_date: "2026-11-12" });
    expect((await list(api)).body.data.map((e) => e.id)).toEqual([data.id]);
    expect((await (await api.get(req(`/${data.id}`), data.id)).json() as { data: CalendarEntry }).data).toEqual(data);
  });

  it("entries persist: a brand new API instance for the same Google account (a later sign-in) sees them", async () => {
    const first = await created(apiFor(person("alice")), { medicineName: "Metformin" });
    const later = apiFor(person("alice"));
    expect((await list(later)).body.data.map((e) => e.id)).toEqual([first.id]);
  });

  it("takes a catalogue medicine's name from the catalogue, and ignores the name the client sent", async () => {
    const { rows } = await db.query<{ id: string; name: string }>("SELECT id, brand_name || ' ' || dosage || ' ' || form AS name FROM medicines ORDER BY id LIMIT 1");
    const entry = await created(apiFor(person("alice")), { medicineId: Number(rows[0]!.id), medicineName: "Something I made up" });
    expect(entry.medicineId).toBe(Number(rows[0]!.id));
    expect(entry.medicineName).toBe(rows[0]!.name);
  });

  it("rejects a medicine that is not in the catalogue, writing nothing", async () => {
    const res = await create(apiFor(person("alice")), { medicineId: 99999999, type: "WANT_TO_GET", date: "2026-11-05" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { details: { field: string }[] } }).error.details[0]!.field).toBe("medicineId");
    expect(await count("medicine_calendar_entries")).toBe(0);
  });

  it("filters by date range, inclusive at both ends, ordered by day", async () => {
    const api = apiFor(person("alice"));
    for (const date of ["2026-10-31", "2026-11-01", "2026-11-15", "2026-11-30", "2026-12-01"]) await created(api, { date, medicineName: `m ${date}` });
    expect((await list(api)).body.data.map((e) => e.date)).toEqual(["2026-11-01", "2026-11-15", "2026-11-30"]);
    expect((await list(api, "2026-11-15", "2026-11-15")).body.data.map((e) => e.date)).toEqual(["2026-11-15"]);
    expect((await list(api, "2026-12-02", "2026-12-31")).body.data).toEqual([]);
  });

  it("keeps a day a day, whatever the server's timezone (including the leap day)", async () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        await db.query("TRUNCATE medicine_calendar_entries CASCADE");
        const api = apiFor(person("alice"));
        for (const date of ["2028-02-29", "2026-03-29", "2026-11-01"]) expect((await created(api, { date })).date).toBe(date);
        expect((await list(api, "2026-01-01", "2026-12-31")).body.data.map((e) => e.date)).toEqual(["2026-03-29", "2026-11-01"]);
        expect((await list(api, "2028-02-01", "2028-03-31")).body.data.map((e) => e.date)).toEqual(["2028-02-29"]);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("updates fields, and completing records when, and reopening clears it", async () => {
    const api = apiFor(person("alice"));
    const e = await created(api, {});
    const patch = (body: unknown) => api.update(req(`/${e.id}`, { method: "PATCH", json: body }), e.id);
    const edited = ((await (await patch({ type: "ORDERED", date: "2026-11-09", notes: "ordered by phone" })).json()) as { data: CalendarEntry }).data;
    expect(edited).toMatchObject({ type: "ORDERED", date: "2026-11-09", notes: "ordered by phone", status: "OPEN", medicineName: "Paracetamol 500mg" });
    expect(Date.parse(edited.updatedAt)).toBeGreaterThanOrEqual(Date.parse(e.updatedAt));
    const done = ((await (await patch({ status: "DONE" })).json()) as { data: CalendarEntry }).data;
    expect(done.status).toBe("DONE");
    expect(Date.parse(done.completedAt!)).toBeGreaterThan(0);
    const again = ((await (await patch({ status: "DONE" })).json()) as { data: CalendarEntry }).data;
    expect(again.completedAt).toBe(done.completedAt); // completing twice does not move the time
    const reopened = ((await (await patch({ status: "OPEN", notes: null })).json()) as { data: CalendarEntry }).data;
    expect(reopened).toMatchObject({ status: "OPEN", completedAt: null, notes: null });
  });

  it("can attach an entry to a catalogue medicine, and detach it while keeping the name", async () => {
    const api = apiFor(person("alice"));
    const e = await created(api, {});
    const { rows } = await db.query<{ id: string; name: string }>("SELECT id, brand_name || ' ' || dosage || ' ' || form AS name FROM medicines ORDER BY id LIMIT 1");
    const attached = ((await (await api.update(req(`/${e.id}`, { method: "PATCH", json: { medicineId: Number(rows[0]!.id) } }), e.id)).json()) as { data: CalendarEntry }).data;
    expect(attached).toMatchObject({ medicineId: Number(rows[0]!.id), medicineName: rows[0]!.name });
    const detached = ((await (await api.update(req(`/${e.id}`, { method: "PATCH", json: { medicineId: null } }), e.id)).json()) as { data: CalendarEntry }).data;
    expect(detached).toMatchObject({ medicineId: null, medicineName: rows[0]!.name });
  });

  it("deleting removes the row for good; deleting again is a 404", async () => {
    const api = apiFor(person("alice"));
    const e = await created(api, {});
    const res = await api.remove(req(`/${e.id}`, { method: "DELETE" }), e.id);
    expect(res.status).toBe(204);
    expect(await count("medicine_calendar_entries")).toBe(0);
    expect((await api.remove(req(`/${e.id}`, { method: "DELETE" }), e.id)).status).toBe(404);
    expect((await api.get(req(`/${e.id}`), e.id)).status).toBe(404);
  });

  it("a catalogue medicine being removed leaves the entry, with its name, detached; removing a patient removes their entries", async () => {
    const api = apiFor(person("alice"));
    const { rows } = await db.query<{ id: string }>("INSERT INTO medicines (brand_name, generic_name, dosage, form, code) VALUES ('Temp', 'temp', '1mg', 'tablet', 'M9999') RETURNING id");
    const e = await created(api, { medicineId: Number(rows[0]!.id) });
    await db.query("DELETE FROM medicines WHERE id = $1", [rows[0]!.id]);
    expect(((await (await api.get(req(`/${e.id}`), e.id)).json()) as { data: CalendarEntry }).data).toMatchObject({ medicineId: null, medicineName: "Temp 1mg tablet" });
    await db.query("DELETE FROM patients");
    expect(await count("medicine_calendar_entries")).toBe(0);
  });

  it("an unknown or malformed id is a 404, never a database error", async () => {
    const api = apiFor(person("alice"));
    for (const id of ["not-a-uuid", "00000000-0000-0000-0000-000000000000", "1; DROP TABLE patients"]) {
      expect((await api.get(req(`/x`), id)).status).toBe(404);
      expect((await api.update(req(`/x`, { method: "PATCH", json: { notes: "a" } }), id)).status).toBe(404);
      expect((await api.remove(req(`/x`, { method: "DELETE" }), id)).status).toBe(404);
    }
  });

  it("stops at the per-patient limit with a clear 409", async () => {
    const api = apiFor(person("alice"));
    await created(api, {});
    await db.query(
      `INSERT INTO medicine_calendar_entries (patient_id, medicine_name, entry_type, entry_date)
       SELECT p.id, 'filler', 'REMINDER', DATE '2026-01-01' + g FROM patients p, generate_series(1, $1::int - 1) g`,
      [LIMITS.entriesPerPatient],
    );
    const res = await create(api, { medicineName: "one too many", type: "REMINDER", date: "2026-11-05" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("LIMIT_REACHED");
    expect(await count("medicine_calendar_entries")).toBe(LIMITS.entriesPerPatient);
  });

  it("answers are private and never cacheable", async () => {
    const api = apiFor(person("alice"));
    for (const res of [await list(api).then((r) => r.res), await create(api, { medicineName: "x", type: "REMINDER", date: "2026-11-05" })]) {
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("vary")).toBe("Cookie");
    }
  });
});

describe("validation", () => {
  const api = () => apiFor(person("alice"));
  const bad = async (body: unknown, field: string) => {
    const res = await create(api(), body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; details: { field: string }[] } };
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details.map((d) => d.field)).toContain(field);
    expect(await count("medicine_calendar_entries")).toBe(0);
  };
  const ok = { medicineName: "X", type: "REMINDER", date: "2026-11-05" };

  it.each([
    [{ ...ok, type: "SOLD" }, "type"],
    [{ ...ok, type: undefined }, "type"],
    [{ ...ok, date: "2026-02-30" }, "date"],
    [{ ...ok, date: "2026-13-01" }, "date"],
    [{ ...ok, date: "05/11/2026" }, "date"],
    [{ ...ok, date: "1999-12-31" }, "date"],
    [{ ...ok, date: "2101-01-01" }, "date"],
    [{ ...ok, date: 20261105 }, "date"],
    [{ ...ok, medicineName: "   " }, "medicineName"],
    [{ ...ok, medicineName: "x".repeat(LIMITS.medicineName + 1) }, "medicineName"],
    [{ ...ok, medicineName: undefined }, "medicineName"],
    [{ ...ok, notes: "n".repeat(LIMITS.notes + 1) }, "notes"],
    [{ ...ok, notes: 5 }, "notes"],
    [{ ...ok, medicineId: "7" }, "medicineId"],
    [{ ...ok, medicineId: 1.5 }, "medicineId"],
    [{ ...ok, medicineId: 0 }, "medicineId"],
    [{ ...ok, medicineId: -3 }, "medicineId"],
  ])("rejects %j", async (body, field) => bad(body, field));

  it("rejects bodies that are not a JSON object, not JSON, or not declared as JSON", async () => {
    for (const json of [[], "text", 5, null]) expect((await create(api(), json)).status).toBe(400);
    expect((await api().create(req("", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }))).status).toBe(400);
    expect((await api().create(req("", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(ok) }))).status).toBe(415);
    expect((await api().create(req("", { method: "POST", json: { ...ok, notes: "x".repeat(LIMITS.bodyBytes) } }))).status).toBe(413);
    expect(await count("medicine_calendar_entries")).toBe(0);
  });

  it("leap day is valid only in a leap year", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
  });

  it("validates updates, and refuses an empty one", async () => {
    const a = api();
    const e = await created(a, {});
    for (const body of [{}, { type: "SOLD" }, { date: "2026-02-30" }, { status: "MAYBE" }, { notes: 3 }, { medicineName: "" }, { medicineId: -1 }]) {
      expect((await a.update(req(`/${e.id}`, { method: "PATCH", json: body }), e.id)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await a.update(req(`/${e.id}`, { method: "PATCH", json: { medicineId: 99999999 } }), e.id)).status).toBe(400);
    expect(((await (await a.get(req(`/${e.id}`), e.id)).json()) as { data: CalendarEntry }).data).toEqual(e);
  });

  it("validates the list's range", async () => {
    const a = api();
    for (const q of ["", "?from=2026-11-01", "?from=2026-11-30&to=2026-11-01", "?from=2026-02-30&to=2026-03-01", "?from=2026-01-01&to=2027-12-31", `?from=2026-11-01&to=2026-11-30&limit=0`, `?from=2026-11-01&to=2026-11-30&limit=abc`]) {
      expect((await a.list(req(q))).status, q).toBe(400);
    }
    expect((await a.list(req("?from=2026-01-01&to=2027-01-07"))).status).toBe(200); // 371 days: allowed
  });
});

describe("authentication", () => {
  it("every endpoint answers 401 without a verified session, and does not touch the database", async () => {
    const spy = vi.fn();
    const api = createCalendarApi({ identity: async () => null, db: () => ({ query: spy }) as unknown as Queryable });
    const id = "00000000-0000-4000-8000-000000000000";
    const results = await Promise.all([
      api.list(req("?from=2026-11-01&to=2026-11-30")),
      api.create(req("", { method: "POST", json: { medicineName: "x", type: "REMINDER", date: "2026-11-05" } })),
      api.get(req(`/${id}`), id),
      api.update(req(`/${id}`, { method: "PATCH", json: { notes: "x" } }), id),
      api.remove(req(`/${id}`, { method: "DELETE" }), id),
    ]);
    expect(results.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect(((await results[0]!.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
    expect(spy).not.toHaveBeenCalled();
    expect(await count("medicine_calendar_entries")).toBe(0);
    expect(await count("patients")).toBe(0);
  });

  it("an unauthenticated caller learns nothing about entries that exist", async () => {
    const e = await created(apiFor(person("alice")), {});
    const anon = apiFor(null);
    const res = await anon.get(req(`/${e.id}`), e.id);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain(e.id);
  });

  it("refuses data-changing requests that a browser says came from another site, but not reads", async () => {
    const api = apiFor(person("alice"));
    const body = { medicineName: "x", type: "REMINDER", date: "2026-11-05" };
    const cross = { "sec-fetch-site": "cross-site" };
    expect((await api.create(req("", { method: "POST", json: body, headers: cross }))).status).toBe(403);
    expect((await api.create(req("", { method: "POST", json: body, headers: { "sec-fetch-site": "same-site" } }))).status).toBe(403);
    expect((await api.create(req("", { method: "POST", json: body, headers: { "sec-fetch-site": "same-origin" } }))).status).toBe(201);
    const e = await created(api, {});
    expect((await api.remove(req(`/${e.id}`, { method: "DELETE", headers: cross }), e.id)).status).toBe(403);
    expect((await api.update(req(`/${e.id}`, { method: "PATCH", json: { notes: "x" }, headers: cross }), e.id)).status).toBe(403);
    expect(await count("medicine_calendar_entries")).toBe(2);
  });
});

describe("one person can never reach another's entries", () => {
  it("cannot read, list, change or delete them, by id or by any other means", async () => {
    const alice = apiFor(person("alice"));
    const bob = apiFor(person("bob"));
    const secret = await created(alice, { medicineName: "Private medicine", notes: "private note" });

    expect((await bob.get(req(`/${secret.id}`), secret.id)).status).toBe(404);
    expect((await bob.update(req(`/${secret.id}`, { method: "PATCH", json: { notes: "hacked", status: "DONE", type: "PURCHASED" } }), secret.id)).status).toBe(404);
    expect((await bob.remove(req(`/${secret.id}`, { method: "DELETE" }), secret.id)).status).toBe(404);
    const { body } = await list(bob);
    expect(body.data).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/Private medicine|private note/);

    expect(((await (await alice.get(req(`/${secret.id}`), secret.id)).json()) as { data: CalendarEntry }).data).toEqual(secret); // untouched
  });

  it("a user id or patient id sent by the client is ignored: the entry belongs to whoever the session says", async () => {
    const alice = apiFor(person("alice"));
    const bob = apiFor(person("bob"));
    const aliceId = await resolvePatientId(db, person("alice"));
    const res = await create(bob, { medicineName: "Bob's", type: "REMINDER", date: "2026-11-05", userId: aliceId, patientId: aliceId, patient_id: aliceId });
    expect(res.status).toBe(201);
    const { id } = ((await res.json()) as { data: CalendarEntry }).data;
    const owner = (await db.query<{ subject: string }>("SELECT p.provider_subject AS subject FROM medicine_calendar_entries e JOIN patients p ON p.id = e.patient_id WHERE e.id = $1", [id])).rows[0]!;
    expect(owner.subject).toBe("bob");
    expect((await list(alice)).body.data).toEqual([]);
    // nor can a query string pick whose entries are listed
    const res2 = await alice.list(req(`?from=2026-11-01&to=2026-11-30&userId=${await resolvePatientId(db, person("bob"))}`));
    expect(((await res2.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("two Google accounts with the same email are still strangers to each other", async () => {
    const one = await created(apiFor(person("sub-1", "shared@example.com")), {});
    const other = apiFor(person("sub-2", "shared@example.com"));
    expect((await other.get(req(`/${one.id}`), one.id)).status).toBe(404);
    expect((await list(other)).body.data).toEqual([]);
  });

  it("authorisation is enforced in the database statement, not only before it", async () => {
    // Even if the ownership check were skipped, a mutation scoped to the wrong patient changes nothing.
    const alice = await created(apiFor(person("alice")), {});
    const bobId = await resolvePatientId(db, person("bob"));
    const { updateEntry, deleteEntry } = await import("./repo");
    await expect(updateEntry(db, bobId, alice.id, { notes: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteEntry(db, bobId, alice.id)).rejects.toMatchObject({ status: 404 });
    expect(await count("medicine_calendar_entries")).toBe(1);
  });
});

describe("failures", () => {
  it("says the calendar is not set up when the server has no database, rather than failing obscurely", async () => {
    const res = await apiFor(person("alice"), null).list(req("?from=2026-11-01&to=2026-11-30"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CALENDAR_NOT_CONFIGURED");
  });

  it("an unreachable database is a 503 that reveals nothing", async () => {
    const broken = { query: async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432"), { code: "ECONNREFUSED" }); } } as unknown as Queryable;
    const res = await apiFor(person("alice"), broken).list(req("?from=2026-11-01&to=2026-11-30"));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toMatch(/10\.1\.2\.3|ECONNREFUSED|5432/);
  });

  it("an unexpected error is a plain 500: no message, SQL or stack goes to the client, and the request body is not logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = { query: async () => { throw new Error('relation "secret_table" does not exist: SELECT password FROM x'); } } as unknown as Queryable;
    const res = await apiFor(person("alice"), boom).create(req("", { method: "POST", json: { medicineName: "my private medicine", type: "REMINDER", date: "2026-11-05", notes: "private" } }));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/secret_table|password|SELECT/);
    expect(text).toContain("INTERNAL_ERROR");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/my private medicine|private"/);
    log.mockRestore();
  });
});
