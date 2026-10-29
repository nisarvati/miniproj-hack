import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { decide, listUsers } from "../src/admin.js";
import { createSessionToken, hashPassword, readSessionToken, verifyPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let admin: Db;
let pharmacies: Record<string, Db>;
let app: FastifyInstance;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" });

beforeAll(async () => {
  admin = await freshSeededDb();
  const urls = await freshPharmacyDbs(admin);
  pharmacies = Object.fromEntries(Object.entries(urls).map(([code, url]) => [code, createPool(url)]));
  await admin.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('a@pharmacy.test', $1, 'P001'), ('b@pharmacy.test', $2, 'P002')", [
    await hashPassword("pw-a"),
    await hashPassword("pw-b"),
  ]);
  app = await buildApp({ db: admin, pharmacies }, config, { logger: false });
});
afterAll(async () => {
  await app.close();
  await Promise.all(Object.values(pharmacies).map((p) => p.end()));
  await admin.end();
});
beforeEach(async () => {
  await pharmacies.P001!.query("TRUNCATE outbox");
  await pharmacies.P002!.query("TRUNCATE outbox");
});

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;
async function login(email = "a@pharmacy.test", password = "pw-a") {
  const res = await app.inject({ method: "POST", url: "/portal/login", payload: { email, password } });
  return { res, cookie: res.statusCode === 200 ? cookieOf(res) : "" };
}
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined && { payload: payload as object }) });
const outbox = async (code = "P001") => (await pharmacies[code]!.query("SELECT event_type, medicine_code, quantity_after, price FROM outbox ORDER BY id")).rows;
const stockRow = async (code: string, med: string) => (await pharmacies[code]!.query("SELECT quantity, price FROM inventory WHERE medicine_code = $1", [med])).rows[0];

describe("passwords and sessions", () => {
  it("hashes with a salt and verifies only the right password", async () => {
    const a = await hashPassword("secret");
    expect(a).not.toContain("secret");
    expect(a).not.toBe(await hashPassword("secret"));
    expect(await verifyPassword("secret", a)).toBe(true);
    expect(await verifyPassword("Secret", a)).toBe(false);
    expect(await verifyPassword("secret", "garbage")).toBe(false);
  });

  it("rejects tampered, foreign-signed and expired sessions", () => {
    const s = { userId: 1, pharmacyCode: "P001", exp: Date.now() + 60_000 };
    const token = createSessionToken(s, "secret-one-secret-one");
    expect(readSessionToken(token, "secret-one-secret-one")).toEqual(s);
    expect(readSessionToken(token, "secret-two-secret-two")).toBeNull();
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...s, pharmacyCode: "P002" })).toString("base64url");
    expect(readSessionToken(`${forged}.${sig}`, "secret-one-secret-one")).toBeNull();
    expect(readSessionToken(`${payload}`, "secret-one-secret-one")).toBeNull();
    expect(readSessionToken(createSessionToken({ ...s, exp: Date.now() - 1 }, "secret-one-secret-one"), "secret-one-secret-one")).toBeNull();
    expect(readSessionToken(undefined, "secret-one-secret-one")).toBeNull();
  });
});

describe("root", () => {
  it("sends a browser that opens the API's address to the portal page of the web app", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/portal");
  });
});

describe("login", () => {
  it("signs in with a httpOnly cookie and says which pharmacy the account belongs to", async () => {
    const { res } = await login();
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly.*SameSite=Lax|SameSite=Lax.*HttpOnly/);
    expect(res.json().data).toMatchObject({ email: "a@pharmacy.test", pharmacy: { code: "P001", name: "Pharmacy A - Andheri West" } });
    expect(JSON.stringify(res.json())).not.toContain("scrypt");
  });

  it("is case-insensitive on the email, and gives one message for a wrong password and an unknown email", async () => {
    expect((await login("A@Pharmacy.TEST")).res.statusCode).toBe(200);
    const wrong = await login("a@pharmacy.test", "nope");
    const unknown = await login("nobody@pharmacy.test", "pw-a");
    expect(wrong.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    expect(wrong.res.json().error.message).toBe(unknown.res.json().error.message);
    expect(wrong.res.headers["set-cookie"]).toBeUndefined();
  });

  it("requires a session everywhere else, and logout clears it", async () => {
    for (const [m, u] of [["GET", "/portal/me"], ["GET", "/portal/stock"], ["GET", "/portal/catalogue"], ["PATCH", "/portal/stock/M001"], ["POST", "/portal/stock"], ["DELETE", "/portal/stock/M001"]] as const) {
      const res = await app.inject({ method: m, url: u, payload: m === "GET" || m === "DELETE" ? undefined : {} });
      expect(res.statusCode, `${m} ${u}`).toBe(401);
    }
    const { cookie } = await login();
    expect((await call("GET", "/portal/me", cookie)).statusCode).toBe(200);
    const out = await app.inject({ method: "POST", url: "/portal/logout" });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
  });
});

describe("stock", () => {
  it("lists the pharmacy's own stock with medicine details", async () => {
    const { cookie } = await login();
    const res = await call("GET", "/portal/stock", cookie);
    expect(res.statusCode).toBe(200);
    const items = res.json().data as { medicineCode: string; brandName: string; quantity: number }[];
    expect(items.length).toBeGreaterThan(5);
    expect(items.find((i) => i.medicineCode === "M001")).toMatchObject({ brandName: "Crocin", dosage: "500mg", form: "tablet" });
  });

  it("changes the quantity in the pharmacy's database, which records the event for the pipeline", async () => {
    const { cookie } = await login();
    const before = (await stockRow("P001", "M001")).quantity as number;
    const res = await call("PATCH", "/portal/stock/M001", cookie, { quantity: before + 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ medicineCode: "M001", before: { quantity: before }, after: { quantity: before + 10 }, events: ["RESTOCK"] });
    expect((await stockRow("P001", "M001")).quantity).toBe(before + 10);
    expect(await outbox()).toMatchObject([{ event_type: "RESTOCK", medicine_code: "M001", quantity_after: before + 10 }]);
  });

  it("records a SALE for a lower count and two events for quantity plus price", async () => {
    const { cookie } = await login();
    const res = await call("PATCH", "/portal/stock/M001", cookie, { quantity: 0, price: 99.5 });
    expect(res.json().data.events).toEqual(["SALE", "PRICE_UPDATED"]);
    expect(await stockRow("P001", "M001")).toMatchObject({ quantity: 0, price: "99.50" });
  });

  it("records nothing when nothing changed", async () => {
    const { cookie } = await login();
    const { quantity } = await stockRow("P001", "M001");
    const res = await call("PATCH", "/portal/stock/M001", cookie, { quantity });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.events).toEqual([]);
    expect(await outbox()).toHaveLength(0);
  });

  it("adds a catalogue medicine the pharmacy does not carry, then removes it", async () => {
    const { cookie } = await login();
    await pharmacies.P001!.query("DELETE FROM inventory WHERE medicine_code = 'M015'");
    const catalogue = (await call("GET", "/portal/catalogue", cookie)).json().data as { medicineCode: string }[];
    expect(catalogue.map((m) => m.medicineCode)).toContain("M015");
    await pharmacies.P001!.query("TRUNCATE outbox");

    const added = await call("POST", "/portal/stock", cookie, { medicineCode: "M015", quantity: 20, price: 140 });
    expect(added.statusCode).toBe(201);
    expect(await outbox()).toMatchObject([{ event_type: "MEDICINE_ADDED", medicine_code: "M015", quantity_after: 20 }]);
    expect((await call("POST", "/portal/stock", cookie, { medicineCode: "M015", quantity: 1, price: 1 })).statusCode).toBe(409);
    expect(((await call("GET", "/portal/catalogue", cookie)).json().data as { medicineCode: string }[]).map((m) => m.medicineCode)).not.toContain("M015");

    expect((await call("DELETE", "/portal/stock/M015", cookie)).statusCode).toBe(200);
    expect(await stockRow("P001", "M015")).toBeUndefined();
    expect((await outbox()).at(-1)).toMatchObject({ event_type: "MEDICINE_REMOVED", medicine_code: "M015" });
    expect((await call("DELETE", "/portal/stock/M015", cookie)).statusCode).toBe(404);
  });

  it("validates input and changes nothing when it is refused", async () => {
    const { cookie } = await login();
    for (const body of [{ quantity: -1 }, { quantity: 1.5 }, { price: 0 }, { price: 1.234 }, {}, { quantity: 1, pharmacy: "P002" }]) {
      expect((await call("PATCH", "/portal/stock/M001", cookie, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await call("PATCH", "/portal/stock/nope", cookie, { quantity: 1 })).statusCode).toBe(400);
    expect((await call("PATCH", "/portal/stock/M999", cookie, { quantity: 1 })).statusCode).toBe(404);
    expect(await outbox()).toHaveLength(0);
  });
});

describe("one pharmacy cannot touch another", () => {
  it("always acts on the pharmacy in the session, whatever the request says", async () => {
    const a = (await login("a@pharmacy.test", "pw-a")).cookie;
    const b = (await login("b@pharmacy.test", "pw-b")).cookie;
    const p2Before = await stockRow("P002", "M001");
    const p1Before = await stockRow("P001", "M001");

    // A tries to smuggle a pharmacy in: the schema is strict, so it is refused, and P002 is untouched.
    expect((await call("PATCH", "/portal/stock/M001", a, { quantity: 777, pharmacyCode: "P002" })).statusCode).toBe(400);
    expect((await call("PATCH", "/portal/stock/M001?pharmacyCode=P002", a, { quantity: 777 })).statusCode).toBe(200);
    expect(await stockRow("P002", "M001")).toEqual(p2Before);
    expect((await stockRow("P001", "M001")).quantity).toBe(777);

    expect((await call("PATCH", "/portal/stock/M001", b, { quantity: 5 })).statusCode).toBe(200);
    expect((await stockRow("P002", "M001")).quantity).toBe(5);
    expect((await stockRow("P001", "M001")).quantity).toBe(777);
    expect(p1Before).toBeDefined();
    expect(await outbox("P002")).toHaveLength(1);
  });

  it("ends the session when the account is removed", async () => {
    await admin.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('gone@pharmacy.test', $1, 'P003')", [await hashPassword("pw")]);
    const { cookie } = await login("gone@pharmacy.test", "pw");
    expect((await call("GET", "/portal/me", cookie)).statusCode).toBe(200);
    await admin.query("DELETE FROM pharmacy_users WHERE email = 'gone@pharmacy.test'");
    expect((await call("GET", "/portal/me", cookie)).statusCode).toBe(401);
    expect((await call("PATCH", "/portal/stock/M001", cookie, { quantity: 1 })).statusCode).toBe(401);
  });
});

describe("sign-up and approval", () => {
  const signup = (payload: unknown) => app.inject({ method: "POST", url: "/portal/signup", payload: payload as object });
  const statusOf = async (email: string) => (await admin.query("SELECT status FROM pharmacy_users WHERE lower(email) = lower($1)", [email])).rows[0]?.status;

  it("creates a pending request that cannot sign in, and says so only to someone who knows the password", async () => {
    const res = await signup({ email: "New.Staff@Pharmacy.test", password: "a-long-password", pharmacyCode: "p003" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ data: { status: "pending" } });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(await statusOf("new.staff@pharmacy.test")).toBe("pending");
    expect((await admin.query("SELECT pharmacy_code, password_hash FROM pharmacy_users WHERE lower(email) = 'new.staff@pharmacy.test'")).rows[0]).toMatchObject({ pharmacy_code: "P003" });
    expect(JSON.stringify(res.json())).not.toContain("scrypt");

    const right = await login("new.staff@pharmacy.test", "a-long-password");
    expect(right.res.statusCode).toBe(403);
    expect(right.res.json().error.code).toBe("ACCOUNT_PENDING");
    expect(right.res.headers["set-cookie"]).toBeUndefined();
    // A wrong password or an unknown email still gets the same answer as before, so pending status is not leaked.
    const wrong = await login("new.staff@pharmacy.test", "not-the-password");
    expect(wrong.res.statusCode).toBe(401);
    expect(wrong.res.json().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("lets an approved request sign in, for its own pharmacy only", async () => {
    await signup({ email: "approve.me@pharmacy.test", password: "a-long-password", pharmacyCode: "P003" });
    expect((await listUsers(admin)).map((u) => u.email)).toContain("approve.me@pharmacy.test");
    const approved = await decide(admin, "Approve.Me@pharmacy.test", "approve");
    expect(approved).toMatchObject({ pharmacyCode: "P003", status: "active" });
    const { res, cookie } = await login("approve.me@pharmacy.test", "a-long-password");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.pharmacy.code).toBe("P003");
    expect((await call("GET", "/portal/me", cookie)).json().data.pharmacy.code).toBe("P003");
    expect((await listUsers(admin)).map((u) => u.email)).not.toContain("approve.me@pharmacy.test");
  });

  it("keeps a rejected request out, and ends a session whose account is no longer active", async () => {
    await signup({ email: "reject.me@pharmacy.test", password: "a-long-password", pharmacyCode: "P002" });
    await decide(admin, "reject.me@pharmacy.test", "reject");
    const refused = await login("reject.me@pharmacy.test", "a-long-password");
    expect(refused.res.statusCode).toBe(403);
    expect(refused.res.json().error.code).toBe("ACCOUNT_NOT_APPROVED");

    const { cookie } = await login("b@pharmacy.test", "pw-b");
    expect((await call("GET", "/portal/stock", cookie)).statusCode).toBe(200);
    await admin.query("UPDATE pharmacy_users SET status = 'rejected' WHERE email = 'b@pharmacy.test'");
    expect((await call("GET", "/portal/stock", cookie)).statusCode).toBe(401);
    expect((await call("PATCH", "/portal/stock/M001", cookie, { quantity: 1 })).statusCode).toBe(401);
    await admin.query("UPDATE pharmacy_users SET status = 'active' WHERE email = 'b@pharmacy.test'");
    expect((await call("GET", "/portal/stock", cookie)).statusCode).toBe(200);
  });

  it("answers the same for an email that is already registered, and never changes that account", async () => {
    const taken = await signup({ email: "A@pharmacy.test", password: "another-long-password", pharmacyCode: "P002" });
    expect(taken.statusCode).toBe(202);
    expect(taken.json()).toEqual({ data: { status: "pending" } });
    const existing = (await admin.query("SELECT pharmacy_code, status FROM pharmacy_users WHERE email = 'a@pharmacy.test'")).rows;
    expect(existing).toEqual([{ pharmacy_code: "P001", status: "active" }]);
    expect((await login("a@pharmacy.test", "pw-a")).res.statusCode).toBe(200);
    expect((await login("a@pharmacy.test", "another-long-password")).res.statusCode).toBe(401);
  });

  it("validates the request and does not let the form choose its own status", async () => {
    const ok = { email: "valid@pharmacy.test", password: "a-long-password", pharmacyCode: "P001" };
    expect((await signup({ ...ok, password: "short" })).statusCode).toBe(400);
    expect((await signup({ ...ok, email: "not-an-email" })).statusCode).toBe(400);
    expect((await signup({ ...ok, pharmacyCode: "../etc" })).statusCode).toBe(400);
    expect((await signup({ ...ok, status: "active" })).statusCode).toBe(400);
    expect((await signup({ ...ok, pharmacyCode: "P999" })).statusCode).toBe(404);
    expect(await statusOf("valid@pharmacy.test")).toBeUndefined();
  });

  it("caps the open requests for one pharmacy", async () => {
    for (let i = 0; i < 20; i++) {
      await admin.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code, status) VALUES ($1, 'x', 'P004', 'pending')", [`bulk${i}@pharmacy.test`]);
    }
    const res = await signup({ email: "one.more@pharmacy.test", password: "a-long-password", pharmacyCode: "P004" });
    expect(res.statusCode).toBe(429);
    expect(await statusOf("one.more@pharmacy.test")).toBeUndefined();
    expect((await signup({ email: "other.pharmacy@pharmacy.test", password: "a-long-password", pharmacyCode: "P005" })).statusCode).toBe(202);
  });

  it("only decides requests that are pending, and tells the administrator when there is none", async () => {
    await expect(decide(admin, "nobody@pharmacy.test", "approve")).rejects.toThrow(/No pending request/);
    await expect(decide(admin, "a@pharmacy.test", "reject")).rejects.toThrow(/No pending request/); // an active account is not demoted
    expect(await statusOf("a@pharmacy.test")).toBe("active");
    expect((await listUsers(admin, "all")).map((u) => u.email)).toContain("a@pharmacy.test");
    expect(JSON.stringify(await listUsers(admin, "all"))).not.toContain("scrypt");
  });
});
