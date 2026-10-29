/**
 * A person's calendar belongs to their Google account and lives in PostgreSQL, not in a session. These tests play whole sessions:
 * every "sign-in" mints a brand new session cookie (a different token each time, as Google sign-ins are), and every request has its
 * identity read back through Auth.js's own session route, the same verified-session step the real route files rely on. The database
 * is the isolated `<db>_test` one with made-up accounts; nothing here touches development data or a real Google account.
 *
 * Not covered, because it needs a browser and real Google: the OAuth redirect itself, and Next.js reading the cookie off a real
 * request (the identity step is Auth.js's, the rest is the API layer and PostgreSQL).
 */
import type { Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCalendarApi } from "./api";
import type { CalendarEntry } from "./model";
import type { PatientIdentity } from "./repo";

const AUTH = { AUTH_SECRET: "test-only-secret-test-only-secret-1234", AUTH_GOOGLE_ID: "test-client-id.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "test-client-secret" };
let db: Db;
let sessionRoute: typeof import("../../app/auth/[...nextauth]/route");
let encode: typeof import("@auth/core/jwt").encode;

beforeAll(async () => {
  for (const [k, v] of Object.entries(AUTH)) vi.stubEnv(k, v);
  delete process.env.AUTH_URL;
  db = await freshSeededDb();
  sessionRoute = await import("../../app/auth/[...nextauth]/route");
  ({ encode } = await import("@auth/core/jwt"));
});
afterAll(async () => {
  await db.end();
  vi.unstubAllEnvs();
});
beforeEach(async () => {
  await db.query("TRUNCATE medicine_calendar_entries, patients RESTART IDENTITY CASCADE");
});

/** A new session cookie for a Google account, as one sign-in would issue it. */
let serial = 0;
async function signIn(sub: string, email = `${sub}@example.com`, name = sub, maxAge = 600): Promise<string> {
  // As Auth.js really issues it without a database adapter: `sub` is a new random id at every sign-in; the stable Google id is `googleId`.
  const token = { sub: crypto.randomUUID(), googleId: sub, email, name, picture: null, jti: `login-${++serial}` };
  return `authjs.session-token=${await encode({ token, secret: AUTH.AUTH_SECRET, salt: "authjs.session-token", maxAge })}`;
}

/** What the real route files do: ask Auth.js who the verified session is, then use only that. */
async function identityFrom(cookie: string | null): Promise<PatientIdentity | null> {
  if (!cookie) return null;
  const res = await sessionRoute.GET(new Request("http://localhost:3000/auth/session", { headers: { cookie } }) as never);
  const body = (await res.json()) as { user?: { id?: string; email?: string | null; name?: string | null } } | null;
  return body?.user?.id ? { provider: "google", subject: body.user.id, email: body.user.email ?? null, name: body.user.name ?? null } : null;
}
/** The calendar API as one browser (one cookie, or none) sees it. A new call is a new server-side instance: nothing is remembered between them. */
const browser = (cookie: string | null) => createCalendarApi({ identity: () => identityFrom(cookie), db: () => db });
type Api = ReturnType<typeof browser>;

const url = (path = "") => `http://localhost:3000/calendar-api/entries${path}`;
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const add = async (api: Api, body: Record<string, unknown>) => {
  const res = await api.create(new Request(url(), json("POST", { type: "WANT_TO_GET", date: "2026-11-05", ...body })));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: CalendarEntry }).data;
};
const entries = async (api: Api) => {
  const res = await api.list(new Request(url("?from=2026-11-01&to=2026-12-31")));
  return { status: res.status, data: ((await res.json()) as { data?: CalendarEntry[] }).data ?? [] };
};
const n = async (table: string) => Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

async function fiveEntries(api: Api) {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM medicines ORDER BY id LIMIT 1");
  const made = [
    await add(api, { medicineName: "Metformin 500mg", type: "REMINDER", date: "2026-11-03", notes: "with breakfast" }),
    await add(api, { medicineName: "Insulin", type: "ORDERED", date: "2026-11-10" }),
    await add(api, { medicineName: "Vitamin D3", type: "PURCHASED", date: "2026-11-10", notes: "one a day" }),
    await add(api, { medicineId: Number(rows[0]!.id), type: "WANT_TO_GET", date: "2026-12-01" }),
    await add(api, { medicineName: "Aspirin", type: "WANT_TO_GET", date: "2026-11-20" }),
  ];
  // one of them completed, so the status and its timestamp must survive too
  const done = await api.update(new Request(url(`/${made[1]!.id}`), json("PATCH", { status: "DONE" })), made[1]!.id);
  expect(done.status).toBe(200);
  return (await entries(api)).data;
}

describe("a calendar belongs to the account, not to the session", () => {
  it("five entries survive signing out and signing in again, complete and unchanged", async () => {
    const first = await fiveEntries(browser(await signIn("alice-sub", "alice@example.com")));
    expect(first).toHaveLength(5);
    expect(first.find((e) => e.status === "DONE")?.completedAt).toBeTruthy();
    expect(first.find((e) => e.medicineId !== null)).toBeTruthy();
    const patientId = (await db.query<{ id: string }>("SELECT id FROM patients")).rows[0]!.id;
    expect(await n("medicine_calendar_entries")).toBe(5);

    // sign out: the cookie is gone. Nothing is deleted, and nothing is readable.
    const signedOut = browser(null);
    expect((await entries(signedOut)).status).toBe(401);
    expect((await signedOut.create(new Request(url(), json("POST", { medicineName: "x", type: "REMINDER", date: "2026-11-05" })))).status).toBe(401);
    expect(await n("medicine_calendar_entries")).toBe(5);
    expect(await n("patients")).toBe(1);

    // sign in again: a different token, the same Google account
    const again = await entries(browser(await signIn("alice-sub", "alice@example.com")));
    expect(again.status).toBe(200);
    expect(again.data).toEqual(first); // same ids, dates, notes, statuses, completion times and medicine links
    expect(await n("patients")).toBe(1);
    expect((await db.query<{ id: string }>("SELECT id FROM patients")).rows[0]!.id).toBe(patientId);
  });

  it("an expired session reads nothing and deletes nothing, and a fresh sign-in brings everything back", async () => {
    await add(browser(await signIn("alice-sub")), { medicineName: "Kept" });
    expect((await entries(browser(await signIn("alice-sub", undefined, undefined, -60)))).status).toBe(401);
    expect(await n("medicine_calendar_entries")).toBe(1);
    expect((await entries(browser(await signIn("alice-sub")))).data.map((e) => e.medicineName)).toEqual(["Kept"]);
  });

  it("the account is the Google subject: a changed email or name is still the same calendar, and signing in does not overwrite entries", async () => {
    const alice = browser(await signIn("alice-sub", "old@example.com", "Alice"));
    const before = await add(alice, { medicineName: "Original", notes: "mine" });
    const later = browser(await signIn("alice-sub", "new@example.com", "Alice Renamed"));
    expect((await entries(later)).data).toEqual([before]);
    await add(later, { medicineName: "Second" });
    expect((await entries(browser(await signIn("alice-sub")))).data.map((e) => e.medicineName).sort()).toEqual(["Original", "Second"]);
    expect(await n("patients")).toBe(1);
    expect((await db.query<{ email: string; name: string }>("SELECT email, name FROM patients")).rows[0]).toEqual({ email: "alice-sub@example.com", name: "alice-sub" }); // display details follow the latest sign-in (the last one above used the defaults)
  });

  it("a page reload (a brand new server-side instance, same cookie) shows the same entries", async () => {
    const cookie = await signIn("alice-sub");
    const saved = await add(browser(cookie), { medicineName: "Persisted", notes: "n" });
    expect((await entries(browser(cookie))).data).toEqual([saved]);
    expect((await entries(browser(cookie))).data).toEqual([saved]);
  });
});

describe("accounts are strangers to each other", () => {
  it("another account sees none of it, and cannot read, edit, complete or delete it", async () => {
    const aliceEntries = await fiveEntries(browser(await signIn("alice-sub", "alice@example.com")));
    const bob = browser(await signIn("bob-sub", "bob@example.com"));
    expect((await entries(bob)).data).toEqual([]);

    for (const e of aliceEntries) {
      expect((await bob.get(new Request(url(`/${e.id}`)), e.id)).status, "read").toBe(404);
      expect((await bob.update(new Request(url(`/${e.id}`), json("PATCH", { notes: "hacked" })), e.id)).status, "edit").toBe(404);
      expect((await bob.update(new Request(url(`/${e.id}`), json("PATCH", { status: "DONE" })), e.id)).status, "complete").toBe(404);
      expect((await bob.update(new Request(url(`/${e.id}`), json("PATCH", { status: "OPEN" })), e.id)).status, "reopen").toBe(404);
      expect((await bob.remove(new Request(url(`/${e.id}`), { method: "DELETE" }), e.id)).status, "delete").toBe(404);
    }
    expect((await entries(browser(await signIn("alice-sub")))).data).toEqual(aliceEntries); // untouched

    await add(bob, { medicineName: "Bob's own" });
    expect((await entries(browser(await signIn("alice-sub")))).data).toEqual(aliceEntries); // and Bob's addition is not Alice's
    expect((await entries(browser(await signIn("bob-sub")))).data.map((e) => e.medicineName)).toEqual(["Bob's own"]);
    expect(await n("patients")).toBe(2);
  });

  it("the same email under a different Google account is a different calendar", async () => {
    await add(browser(await signIn("alice-sub", "shared@example.com")), { medicineName: "Alice only" });
    const impostor = browser(await signIn("other-sub", "shared@example.com"));
    expect((await entries(impostor)).data).toEqual([]);
    expect(await n("patients")).toBe(2);
  });

  it("a different email on the same account is not another account, and an unknown provider identity gets an empty calendar", async () => {
    await add(browser(await signIn("alice-sub", "a@example.com")), { medicineName: "Hers" });
    expect((await entries(browser(await signIn("alice-sub", "b@example.com")))).data).toHaveLength(1);
    expect((await entries(browser(await signIn("nobody-sub", "a@example.com")))).data).toEqual([]);
  });

  it("a session that carries only Auth.js's random per-sign-in id (no Google account id) can neither read nor write, and creates no patient", async () => {
    const noSub = `authjs.session-token=${await encode({ token: { sub: crypto.randomUUID(), email: "x@example.com", name: "x" }, secret: AUTH.AUTH_SECRET, salt: "authjs.session-token", maxAge: 600 })}`;
    const api = browser(noSub);
    expect((await entries(api)).status).toBe(401);
    expect((await api.create(new Request(url(), json("POST", { medicineName: "x", type: "REMINDER", date: "2026-11-05" })))).status).toBe(401);
    expect(await n("patients")).toBe(0);
  });

  it("a forged or tampered cookie is no session at all", async () => {
    const real = await signIn("alice-sub");
    await add(browser(real), { medicineName: "Real" });
    const tampered = real.slice(0, -4) + (real.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await entries(browser(tampered))).status).toBe(401);
    expect((await entries(browser("authjs.session-token=eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbGljZS1zdWIifQ."))).status).toBe(401);
  });
});

describe("first sign-ins", () => {
  it("many simultaneous first sign-ins of one account make exactly one patient, and entries made at the same time all land in it", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => add(browser(await signIn("racer-sub")), { medicineName: `Parallel ${i}`, date: "2026-11-05" })),
    );
    expect(results).toHaveLength(20);
    expect(await n("patients")).toBe(1);
    expect(await n("medicine_calendar_entries")).toBe(20);
    expect((await db.query("SELECT DISTINCT patient_id FROM medicine_calendar_entries")).rows).toHaveLength(1);
    expect((await entries(browser(await signIn("racer-sub")))).data).toHaveLength(20);
  });

  it("signing in over and over never creates a second patient", async () => {
    for (let i = 0; i < 10; i++) await entries(browser(await signIn("steady-sub")));
    expect(await n("patients")).toBe(1);
  });
});
