import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { createAdmin, decide } from "../src/admin.js";
import { buildApp } from "../src/app.js";
import { COOKIE_NAME, createSessionToken, hashPassword } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { LOGIN_LIMITS } from "../src/rate-limit.js";

let admin: Db;
let pharmacies: Record<string, Db>;
let urls: Record<string, string>;
let app: FastifyInstance;
let clock = Date.now();
const base = { DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" };
const config = loadConfig(base);
const ADMIN_PASSWORD = "admin-password-123";

// Cookies for: staff of P001 (a), staff of P002 (b), an administrator (root).
let a: string;
let b: string;
let root: string;

beforeAll(async () => {
  admin = await freshSeededDb();
  urls = await freshPharmacyDbs(admin);
  pharmacies = Object.fromEntries(Object.entries(urls).map(([code, url]) => [code, createPool(url)]));
  app = await buildApp({ db: admin, pharmacies }, config, { logger: false, now: () => clock });
});
afterAll(async () => {
  await app.close();
  await Promise.all(Object.values(pharmacies).map((p) => p.end()));
  await admin.end();
});
beforeEach(async () => {
  // One app is shared by every test, and so is the login limiter's memory: jump past its window so each test starts with a clean slate (the clock only moves forward).
  clock = Math.max(clock, Date.now()) + LOGIN_LIMITS.windowMs + 1000;
  await admin.query("DELETE FROM pharmacy_users");
  await admin.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('a@pharmacy.test', $1, 'P001'), ('b@pharmacy.test', $2, 'P002')", [await hashPassword("pw-a"), await hashPassword("pw-b")]);
  await createAdmin(admin, "root@medlink.test", ADMIN_PASSWORD);
  for (const code of ["P001", "P002"]) {
    await pharmacies[code]!.query("DELETE FROM inventory");
    await setupPharmacyDatabase(code, urls[code]!);
    await pharmacies[code]!.query("UPDATE inventory SET quantity = 12");
    await pharmacies[code]!.query("TRUNCATE outbox, inventory_movements, stock_alerts, restock_plans");
  }
  a = await login("a@pharmacy.test", "pw-a");
  b = await login("b@pharmacy.test", "pw-b");
  root = await login("root@medlink.test", ADMIN_PASSWORD);
});

async function login(email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/portal/login", payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`test setup: sign-in as ${email} answered ${res.statusCode} ${res.body}`);
  return String(res.headers["set-cookie"]).split(";")[0]!;
}
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string | null, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...extra }, ...(payload !== undefined && { payload: payload as object }) });
const code = (res: { json: () => { error?: { code: string } } }) => res.json().error?.code;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const NOPE = "00000000-0000-4000-8000-000000000000";

/** Every route that belongs to pharmacy staff, with a body that would be valid for it, so a refusal can only be about who is asking. */
const STAFF_ROUTES: [method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown][] = [
  ["GET", "/portal/stock"],
  ["GET", "/portal/catalogue"],
  ["PATCH", "/portal/stock/M001", { quantity: 5 }],
  ["POST", "/portal/stock", { medicineCode: "M008", quantity: 5, price: 10 }],
  ["DELETE", "/portal/stock/M002"],
  ["POST", "/portal/sales", { medicineCode: "M001", quantity: 1 }],
  ["POST", "/portal/restocks", { medicineCode: "M001", quantity: 1 }],
  ["GET", "/portal/history"],
  ["GET", "/portal/risk"],
  ["GET", "/portal/risk/M001"],
  ["GET", "/portal/alerts"],
  ["POST", "/portal/restock-plans", { medicineCode: "M001", quantity: 5, targetDate: inDays(3) }],
  ["GET", "/portal/restock-plans"],
  ["GET", `/portal/restock-plans/${NOPE}`],
  ["PATCH", `/portal/restock-plans/${NOPE}`, { status: "COMPLETED" }],
  ["GET", "/portal/restock-plans/export.csv"],
];
const ADMIN_ROUTES: [method: "GET" | "POST", url: string, body?: unknown][] = [
  ["GET", "/portal/admin/staff-requests"],
  ["POST", "/portal/admin/staff-requests/1/decision", { decision: "approve" }],
];
const stockState = async () => JSON.stringify({ inv: (await pharmacies.P001!.query("SELECT medicine_code, quantity FROM inventory ORDER BY 1")).rows, mv: (await pharmacies.P001!.query("SELECT count(*) FROM inventory_movements")).rows[0], ob: (await pharmacies.P001!.query("SELECT count(*) FROM outbox")).rows[0], pl: (await pharmacies.P001!.query("SELECT count(*) FROM restock_plans")).rows[0] });

describe("signed out: every protected route says 401", () => {
  it.each([...STAFF_ROUTES, ...ADMIN_ROUTES] as [string, string, unknown?][])("%s %s", async (method, url, body) => {
    const res = await call(method as "GET", url, null, body);
    expect([res.statusCode, code(res)]).toEqual([401, "UNAUTHENTICATED"]);
  });

  it("and /portal/me", async () => {
    expect((await call("GET", "/portal/me", null)).statusCode).toBe(401);
  });
});

describe("credentials that are not a valid portal session are refused (401), and change nothing", () => {
  const sample: [string, string, unknown?][] = [["GET", "/portal/stock"], ["POST", "/portal/sales", { medicineCode: "M001", quantity: 1 }], ["GET", "/portal/risk"], ["GET", "/portal/restock-plans/export.csv"], ["GET", "/portal/admin/staff-requests"]];
  const refused = async (cookie: string | null, extra: Record<string, string> = {}) => {
    const before = await stockState();
    for (const [method, url, body] of sample) {
      const res = await call(method as "GET", url, cookie, body, extra);
      expect([res.statusCode, code(res)], `${method} ${url}`).toEqual([401, "UNAUTHENTICATED"]);
    }
    expect(await stockState()).toBe(before);
  };
  const tokenFor = (claims: { userId: number; pharmacyCode: string | null; exp?: number }, secret = config.sessionSecret) => `${COOKIE_NAME}=${createSessionToken({ exp: Date.now() + 60_000, ...claims }, secret)}`;
  const idOf = async (email: string) => Number((await admin.query("SELECT id FROM pharmacy_users WHERE email = $1", [email])).rows[0].id);

  it("a patient's web session (a different cookie, and a bearer token) is not a portal session", async () => {
    await refused("authjs.session-token=eyJhbGciOiJkaXIifQ.patient.session");
    await refused(null, { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.patient.token" });
    await refused("__Secure-authjs.session-token=abc; next-auth.session-token=def");
  });

  it("a cookie signed with another secret, a garbled one, or an expired one", async () => {
    await refused(tokenFor({ userId: await idOf("a@pharmacy.test"), pharmacyCode: "P001" }, "some-other-secret-0000"));
    await refused(`${COOKIE_NAME}=not.a.token`);
    await refused(`${COOKIE_NAME}=`);
    await refused(tokenFor({ userId: await idOf("a@pharmacy.test"), pharmacyCode: "P001", exp: Date.now() - 1000 }));
  });

  it("a correctly signed cookie whose account does not exist, or whose claims no longer match the account", async () => {
    await refused(tokenFor({ userId: 987654321, pharmacyCode: "P001" }));
    await refused(tokenFor({ userId: await idOf("a@pharmacy.test"), pharmacyCode: "P002" })); // A's id, B's pharmacy
    await refused(tokenFor({ userId: await idOf("a@pharmacy.test"), pharmacyCode: null })); // staff presented as an administrator
    await refused(tokenFor({ userId: await idOf("root@medlink.test"), pharmacyCode: "P001" })); // an administrator presented as staff of P001
  });

  it("an account that is pending, rejected or revoked, even with a valid cookie from when it was active", async () => {
    await admin.query("UPDATE pharmacy_users SET status = 'pending' WHERE email = 'a@pharmacy.test'");
    await refused(a);
    await admin.query("UPDATE pharmacy_users SET status = 'rejected' WHERE email = 'a@pharmacy.test'");
    await refused(a);
    await admin.query("UPDATE pharmacy_users SET status = 'active' WHERE email = 'a@pharmacy.test'");
    expect((await call("GET", "/portal/stock", a)).statusCode).toBe(200); // active again: the same cookie works
    await admin.query("DELETE FROM pharmacy_users WHERE email = 'a@pharmacy.test'");
    await refused(a);
  });
});

describe("an administrator is not pharmacy staff: every staff route is 403", () => {
  it.each(STAFF_ROUTES)("%s %s", async (method, url, body) => {
    const before = await stockState();
    const res = await call(method, url, root, body);
    expect([res.statusCode, code(res)]).toEqual([403, "FORBIDDEN"]);
    expect(await stockState()).toBe(before); // and nothing was changed
  });

  it("not even by naming a pharmacy", async () => {
    for (const url of ["/portal/stock?pharmacyCode=P001", "/portal/history?pharmacyCode=P001", "/portal/restock-plans/export.csv?pharmacyCode=P001"]) {
      expect((await call("GET", url, root)).statusCode, url).toBe(403);
    }
    expect((await call("POST", "/portal/sales?pharmacyCode=P001", root, { medicineCode: "M001", quantity: 1 })).statusCode).toBe(403);
  });
});

describe("pharmacy staff are not administrators: every admin route is 403", () => {
  it.each(ADMIN_ROUTES)("%s %s", async (method, url, body) => {
    for (const cookie of [a, b]) {
      const res = await call(method, url, cookie, body);
      expect([res.statusCode, code(res)]).toEqual([403, "FORBIDDEN"]);
    }
  });
});

describe("who am I", () => {
  it("says the role, and an administrator has no pharmacy", async () => {
    const staff = (await call("GET", "/portal/me", a)).json().data;
    expect(staff).toMatchObject({ email: "a@pharmacy.test", role: "STAFF", pharmacy: { code: "P001" } });
    const adminMe = (await call("GET", "/portal/me", root)).json().data;
    expect(adminMe).toEqual({ email: "root@medlink.test", role: "ADMIN", pharmacy: null });
    const loginRes = await call("POST", "/portal/login", null, { email: "root@medlink.test", password: ADMIN_PASSWORD });
    expect(loginRes.json().data).toEqual({ email: "root@medlink.test", role: "ADMIN", pharmacy: null });
    expect(JSON.stringify([staff, adminMe, loginRes.json()])).not.toMatch(/scrypt|password_hash/);
  });
});

describe("pharmacy staff reach only their own pharmacy, across every data family", () => {
  it("B cannot read, change or export A's plans, history, alerts or stock, and names in the request change nothing", async () => {
    // A makes a plan, a sale (and so a movement and an alert), all in P001.
    const plan = (await call("POST", "/portal/restock-plans", a, { medicineCode: "M001", quantity: 20, targetDate: inDays(4), notes: "A's secret note" })).json().data;
    await call("POST", "/portal/sales", a, { medicineCode: "M002", quantity: 9 });
    const mine = await stockState();
    for (const url of ["/portal/history", "/portal/alerts?state=ALL", "/portal/restock-plans", "/portal/restock-plans/export.csv"]) {
      const res = await call("GET", `${url}${url.includes("?") ? "&" : "?"}pharmacyCode=P001`, b);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toMatch(/A's secret note|M002.*-9/);
      expect(res.body, url).not.toContain(plan.planId);
    }
    expect((await call("GET", `/portal/restock-plans/${plan.planId}`, b)).statusCode).toBe(404);
    expect((await call("PATCH", `/portal/restock-plans/${plan.planId}`, b, { status: "CANCELLED" })).statusCode).toBe(404);
    // B's own sale of the same medicine touches B's pharmacy only.
    expect((await call("POST", "/portal/sales?pharmacyCode=P001", b, { medicineCode: "M001", quantity: 1 })).json().data.pharmacyCode).toBe("P002");
    expect(await stockState()).toBe(mine);
    expect((await call("GET", `/portal/restock-plans/${plan.planId}`, a)).json().data.status).toBe("PLANNED");
  });
});

describe("the role comes from the database, never from the client", () => {
  it("sign-up cannot ask for a role, a status or a pharmacy-less account, and creates only a pending staff request", async () => {
    for (const extra of [{ role: "ADMIN" }, { status: "active" }, { admin: true }]) {
      const res = await call("POST", "/portal/signup", null, { email: "new@pharmacy.test", password: "a-long-password-1", pharmacyCode: "P001", ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect((await call("POST", "/portal/signup", null, { email: "new@pharmacy.test", password: "a-long-password-1", pharmacyCode: "P001" })).statusCode).toBe(202);
    expect((await admin.query("SELECT role, status, pharmacy_code FROM pharmacy_users WHERE email = 'new@pharmacy.test'")).rows[0]).toEqual({ role: "STAFF", status: "pending", pharmacy_code: "P001" });
    expect((await call("POST", "/portal/login", null, { email: "new@pharmacy.test", password: "a-long-password-1" })).json().error.code).toBe("ACCOUNT_PENDING");
  });

  it("login ignores a role in the request (it refuses unknown fields)", async () => {
    expect((await call("POST", "/portal/login", null, { email: "a@pharmacy.test", password: "pw-a", role: "ADMIN" })).statusCode).toBe(400);
  });

  it("the database refuses a role and pharmacy that do not go together", async () => {
    await expect(admin.query("INSERT INTO pharmacy_users (email, password_hash, role, pharmacy_code) VALUES ('x@y.test', 'h', 'STAFF', NULL)")).rejects.toThrow(/role_scope/);
    await expect(admin.query("INSERT INTO pharmacy_users (email, password_hash, role, pharmacy_code) VALUES ('x@y.test', 'h', 'ADMIN', 'P001')")).rejects.toThrow(/role_scope/);
    await expect(admin.query("INSERT INTO pharmacy_users (email, password_hash, role, pharmacy_code) VALUES ('x@y.test', 'h', 'OWNER', 'P001')")).rejects.toThrow(/role/);
  });

  it("every account that existed before roles stayed STAFF with its pharmacy", async () => {
    const rows = (await admin.query("SELECT email, role, pharmacy_code FROM pharmacy_users WHERE email IN ('a@pharmacy.test', 'b@pharmacy.test') ORDER BY email")).rows;
    expect(rows).toEqual([{ email: "a@pharmacy.test", role: "STAFF", pharmacy_code: "P001" }, { email: "b@pharmacy.test", role: "STAFF", pharmacy_code: "P002" }]);
  });
});

describe("administrator operations", () => {
  const requestsOf = async (qs = "", cookie = root) => (await call("GET", `/portal/admin/staff-requests${qs}`, cookie)).json();
  const signUp = (email: string, pharmacyCode = "P001") => call("POST", "/portal/signup", null, { email, password: "a-long-password-1", pharmacyCode });
  const idOfEmail = async (email: string) => String((await admin.query("SELECT id FROM pharmacy_users WHERE email = $1", [email])).rows[0].id);
  const decideOn = (id: string, decision: string, cookie = root) => call("POST", `/portal/admin/staff-requests/${id}/decision`, cookie, { decision });

  it("lists pending requests (by default) without password hashes, and filters and pages", async () => {
    await signUp("p1@pharmacy.test");
    await signUp("p2@pharmacy.test", "P002");
    const pending = await requestsOf();
    expect(pending.data.map((u: { email: string }) => u.email)).toEqual(["p1@pharmacy.test", "p2@pharmacy.test"]);
    expect(pending.data[0]).toMatchObject({ role: "STAFF", pharmacyCode: "P001", status: "pending", decidedAt: null });
    expect(pending.meta).toMatchObject({ total: 2, status: "pending", limit: 20, offset: 0, hasMore: false });
    expect(JSON.stringify(pending)).not.toMatch(/scrypt|password/);
    const all = await requestsOf("?status=all");
    expect(all.data.map((u: { role: string }) => u.role)).toContain("ADMIN");
    expect(all.data.find((u: { role: string }) => u.role === "ADMIN").pharmacyCode).toBeNull();
    expect((await requestsOf("?status=active")).meta.total).toBe(3); // a, b and the administrator
    const page = await requestsOf("?status=all&limit=2&offset=2");
    expect([page.data.length, page.meta.hasMore]).toEqual([2, true]);
    for (const qs of ["?limit=0", "?limit=101", "?offset=-1", "?status=everything", "?limit=abc"]) expect((await call("GET", `/portal/admin/staff-requests${qs}`, root)).statusCode, qs).toBe(400);
  });

  it("approves a request: the person can then sign in as staff of that pharmacy, and only that", async () => {
    await signUp("p1@pharmacy.test");
    const id = await idOfEmail("p1@pharmacy.test");
    const res = await decideOn(id, "approve");
    expect(res.json().data).toMatchObject({ status: "active", role: "STAFF", pharmacyCode: "P001" });
    expect(res.json().data.decidedAt).not.toBeNull();
    const cookie = await login("p1@pharmacy.test", "a-long-password-1");
    expect((await call("GET", "/portal/me", cookie)).json().data).toMatchObject({ role: "STAFF", pharmacy: { code: "P001" } });
    expect((await call("GET", "/portal/stock", cookie)).statusCode).toBe(200);
    expect((await call("GET", "/portal/admin/staff-requests", cookie)).statusCode).toBe(403);
  });

  it("rejects a request, and the person cannot sign in", async () => {
    await signUp("p1@pharmacy.test");
    expect((await decideOn(await idOfEmail("p1@pharmacy.test"), "reject")).json().data.status).toBe("rejected");
    expect((await call("POST", "/portal/login", null, { email: "p1@pharmacy.test", password: "a-long-password-1" })).json().error.code).toBe("ACCOUNT_NOT_APPROVED");
  });

  it("revokes access, which takes effect on the account's very next request", async () => {
    const id = await idOfEmail("a@pharmacy.test");
    expect((await call("GET", "/portal/stock", a)).statusCode).toBe(200);
    expect((await decideOn(id, "revoke")).json().data.status).toBe("rejected");
    const res = await call("GET", "/portal/stock", a);
    expect([res.statusCode, code(res)]).toEqual([401, "UNAUTHENTICATED"]); // the same cookie, now useless
    expect((await call("GET", "/portal/stock", b)).statusCode).toBe(200); // nobody else is affected
  });

  it("refuses decisions that do not apply, without changing anything", async () => {
    await signUp("p1@pharmacy.test");
    const pendingId = await idOfEmail("p1@pharmacy.test");
    const activeId = await idOfEmail("a@pharmacy.test");
    const adminId = await idOfEmail("root@medlink.test");
    const outcomes = [
      [await decideOn(activeId, "approve"), 409], // already active
      [await decideOn(pendingId, "revoke"), 409], // not active yet
      [await decideOn(adminId, "revoke"), 409], // an administrator cannot be revoked here, so nobody can lock everyone out
      [await decideOn(adminId, "reject"), 409],
      [await decideOn("999999999", "approve"), 404],
    ] as const;
    for (const [res, status] of outcomes) expect(res.statusCode).toBe(status);
    expect(code(outcomes[2][0])).toBe("ACCOUNT_STATE");
    expect(code(outcomes[4][0])).toBe("ACCOUNT_NOT_FOUND");
    expect((await admin.query("SELECT status FROM pharmacy_users WHERE id = $1", [adminId])).rows[0].status).toBe("active");
    expect((await decideOn(pendingId, "approve")).statusCode).toBe(200);
    expect((await decideOn(pendingId, "approve")).statusCode).toBe(409); // a second approval of the same request
  });

  it("validates the id and the body", async () => {
    expect((await call("POST", "/portal/admin/staff-requests/abc/decision", root, { decision: "approve" })).statusCode).toBe(400);
    expect((await call("POST", "/portal/admin/staff-requests/1/decision", root, { decision: "promote" })).statusCode).toBe(400);
    expect((await call("POST", "/portal/admin/staff-requests/1/decision", root, { decision: "approve", role: "ADMIN" })).statusCode).toBe(400);
    expect((await call("POST", "/portal/admin/staff-requests/1/decision", root, {})).statusCode).toBe(400);
  });

  it("creating an administrator needs a strong password, and never promotes an existing account", async () => {
    await expect(createAdmin(admin, "new-admin@medlink.test", "short")).rejects.toThrow(/at least 12/);
    await expect(createAdmin(admin, "not-an-email", ADMIN_PASSWORD)).rejects.toThrow(/email/);
    await expect(createAdmin(admin, "a@pharmacy.test", ADMIN_PASSWORD)).rejects.toThrow(/already exists.*never promoted/);
    expect((await admin.query("SELECT role, pharmacy_code FROM pharmacy_users WHERE email = 'a@pharmacy.test'")).rows[0]).toEqual({ role: "STAFF", pharmacy_code: "P001" });
    const created = await createAdmin(admin, "  New-Admin@MedLink.test ", ADMIN_PASSWORD);
    expect(created).toMatchObject({ email: "new-admin@medlink.test", role: "ADMIN", pharmacyCode: null, status: "active" });
    expect((await admin.query("SELECT password_hash FROM pharmacy_users WHERE email = 'new-admin@medlink.test'")).rows[0].password_hash).not.toContain(ADMIN_PASSWORD);
  });

  it("the operator CLI's approve and reject apply to staff requests only, never to an administrator", async () => {
    await expect(decide(admin, "root@medlink.test", "reject")).rejects.toThrow(/No pending request/);
    expect((await admin.query("SELECT status FROM pharmacy_users WHERE email = 'root@medlink.test'")).rows[0].status).toBe("active");
  });
});

describe("password guessing is slowed down", () => {
  const wrong = (email = "a@pharmacy.test") => call("POST", "/portal/login", null, { email, password: "definitely-wrong" });

  it(`after ${LOGIN_LIMITS.perAccount} wrong passwords the next attempt is 429 with a wait time, even with the right password`, async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAccount; i++) expect((await wrong()).statusCode).toBe(401);
    const blocked = await call("POST", "/portal/login", null, { email: "a@pharmacy.test", password: "pw-a" });
    expect([blocked.statusCode, code(blocked)]).toEqual([429, "TOO_MANY_ATTEMPTS"]);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(LOGIN_LIMITS.windowMs / 1000);
    expect((await wrong()).statusCode).toBe(429);
  });

  it("is per email: another account from the same address can still sign in", async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAccount; i++) await wrong();
    expect((await call("POST", "/portal/login", null, { email: "b@pharmacy.test", password: "pw-b" })).statusCode).toBe(200);
  });

  it("limits an email that has no account in exactly the same way, so it reveals nothing", async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAccount; i++) expect((await wrong("nobody@pharmacy.test")).statusCode).toBe(401);
    expect(code(await wrong("nobody@pharmacy.test"))).toBe("TOO_MANY_ATTEMPTS");
  });

  it("lets attempts through again once the window has passed", async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAccount; i++) await wrong();
    expect((await call("POST", "/portal/login", null, { email: "a@pharmacy.test", password: "pw-a" })).statusCode).toBe(429);
    clock += LOGIN_LIMITS.windowMs + 1000;
    expect((await call("POST", "/portal/login", null, { email: "a@pharmacy.test", password: "pw-a" })).statusCode).toBe(200);
  });

  it("does not count right passwords, and a right one starts the count again", async () => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < LOGIN_LIMITS.perAccount - 1; i++) await wrong();
      expect((await call("POST", "/portal/login", null, { email: "a@pharmacy.test", password: "pw-a" })).statusCode).toBe(200);
    }
  });

  it("a pending account's right password is not a guess", async () => {
    await call("POST", "/portal/signup", null, { email: "p@pharmacy.test", password: "a-long-password-1", pharmacyCode: "P001" });
    for (let i = 0; i < LOGIN_LIMITS.perAccount + 3; i++) expect((await call("POST", "/portal/login", null, { email: "p@pharmacy.test", password: "a-long-password-1" })).json().error.code).toBe("ACCOUNT_PENDING");
  });

  it("limits one address that tries many different emails", async () => {
    for (let i = 0; i < LOGIN_LIMITS.perAddress; i++) await wrong(`guess${i}@pharmacy.test`);
    expect(code(await wrong("guess-new@pharmacy.test"))).toBe("TOO_MANY_ATTEMPTS");
    expect((await call("POST", "/portal/login", null, { email: "b@pharmacy.test", password: "pw-b" })).statusCode).toBe(429); // even a real account, from this address
  });
});

describe("response headers and errors", () => {
  const HEADERS = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "cache-control": "no-store" };

  it("every kind of answer carries the security headers: success, refusal, not found, CSV", async () => {
    const answers = [
      await call("GET", "/portal/stock", a),
      await call("GET", "/portal/stock", null),
      await call("GET", "/portal/stock", root),
      await call("GET", "/portal/nothing-here", a),
      await call("GET", "/portal/restock-plans/export.csv", a),
      await call("POST", "/portal/login", null, { email: "a@pharmacy.test", password: "pw-a" }),
    ];
    expect(answers.map((r) => r.statusCode)).toEqual([200, 401, 403, 404, 200, 200]); // the kinds of answer really are the kinds named above
    for (const res of answers) for (const [name, value] of Object.entries(HEADERS)) expect(res.headers[name], `${res.statusCode} ${name}`).toBe(value);
  });

  it("errors never carry a stack, a file path, an SQL fragment or a secret", async () => {
    await pharmacies.P001!.query("ALTER TABLE restock_plans RENAME TO restock_plans_away");
    try {
      const bodies = [
        (await call("GET", "/portal/restock-plans", a)).body, // a database error
        (await call("POST", "/portal/sales", a, "not json")).body, // a malformed body
        (await call("GET", "/portal/risk/xyz", a)).body,
        (await call("PATCH", "/portal/stock/M001", a, { quantity: -1 })).body,
      ];
      for (const body of bodies) expect(body).not.toMatch(/\bat \S+ \(|node_modules|\/Users\/|SELECT |INSERT |relation "|password|secret|scrypt|stack/i);
    } finally {
      await pharmacies.P001!.query("ALTER TABLE restock_plans_away RENAME TO restock_plans");
    }
  });
});

describe("configuration: the built-in dev session secret never leaves this machine", () => {
  it("is refused when the portal listens beyond this machine without a secret of its own", () => {
    expect(() => loadConfig({ DATABASE_URL: "x", HOST: "0.0.0.0" })).toThrow(/PORTAL_SESSION_SECRET is required when HOST is 0\.0\.0\.0/);
    expect(() => loadConfig({ DATABASE_URL: "x", HOST: "192.168.1.20" })).toThrow(/PORTAL_SESSION_SECRET is required/);
    expect(() => loadConfig({ DATABASE_URL: "x", NODE_ENV: "production" })).toThrow(/required in production/);
  });

  it("is fine on this machine, or with a secret", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) expect(() => loadConfig({ DATABASE_URL: "x", HOST: host })).not.toThrow();
    expect(() => loadConfig({ DATABASE_URL: "x", HOST: "0.0.0.0", PORTAL_SESSION_SECRET: "a-secret-of-sixteen+" })).not.toThrow();
    expect(() => loadConfig({ DATABASE_URL: "x", HOST: "0.0.0.0", PORTAL_SESSION_SECRET: "too-short" })).toThrow(/at least 16/);
    expect(loadConfig({ DATABASE_URL: "x" }).secureCookies).toBe(false);
    expect(loadConfig({ DATABASE_URL: "x", NODE_ENV: "production", PORTAL_SESSION_SECRET: "a-secret-of-sixteen+" }).secureCookies).toBe(true);
  });
});
