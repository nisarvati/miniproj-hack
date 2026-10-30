/**
 * Email-and-password accounts in PostgreSQL: they persist, are shared by every server instance, store only a salted slow hash, and are rate limited in the
 * database. Uses the isolated `<db>_test` database with made-up accounts; nothing here touches development data.
 */
import type { Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateCredentials, clientAddress, createCredentialUser, credentialsAvailable, findCredentialUser, getCredentialStore, looksLikeEmail, setCredentialStoreForTesting,
  SIGN_IN_LIMITS, SIGN_UP_LIMIT, signInKeys, signInThrottled, signUpAllowed, verifyCredentialUser,
} from "./service";
import { MemoryCredentialStore, PgCredentialStore, type CredentialStore } from "./store";

let db: Db;
beforeAll(async () => {
  db = await freshSeededDb();
  expect((await db.query("SELECT current_database() AS d")).rows[0].d).toMatch(/_test$/); // never the development database
});
afterAll(async () => {
  setCredentialStoreForTesting(undefined);
  await db.end();
});
beforeEach(async () => {
  await db.query("TRUNCATE credential_accounts, auth_throttle");
  setCredentialStoreForTesting(new PgCredentialStore(db));
});
afterEach(() => vi.unstubAllEnvs());

const PW = "a-long-enough-password";

describe("accounts in PostgreSQL", () => {
  it("are stored with a salted scrypt hash and never the password, with the email lower-cased", async () => {
    const a = await createCredentialUser("  Asha.Rao@Example.COM ", PW);
    expect(a).toMatchObject({ email: "asha.rao@example.com", name: "asha.rao" });
    const row = (await db.query("SELECT * FROM credential_accounts")).rows[0];
    expect(row.password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(JSON.stringify(row)).not.toContain(PW);
    expect(row.email).toBe("asha.rao@example.com");
  });

  it("persist: another server instance (a fresh store on the same database) sees the account and can sign in, with no shared memory", async () => {
    await createCredentialUser("shared@example.com", PW);
    setCredentialStoreForTesting(new PgCredentialStore(db)); // "a different instance"
    expect(await findCredentialUser("SHARED@example.com")).toMatchObject({ email: "shared@example.com" });
    expect(await verifyCredentialUser("shared@example.com", PW)).toMatchObject({ email: "shared@example.com" });
  });

  it("never hand the hash out: the public lookups return id, email and name only", async () => {
    await createCredentialUser("who@example.com", PW);
    for (const user of [await findCredentialUser("who@example.com"), await verifyCredentialUser("who@example.com", PW)]) {
      expect(Object.keys(user!).sort()).toEqual(["email", "id", "name"]);
    }
  });

  it("refuse a second account for the same email whatever its case, and two simultaneous sign-ups cannot both win", async () => {
    await createCredentialUser("dup@example.com", PW);
    await expect(createCredentialUser("DUP@example.com", PW)).rejects.toThrow("EmailTaken");
    const race = await Promise.allSettled([createCredentialUser("race@example.com", PW), createCredentialUser("race@example.com", PW), createCredentialUser("race@example.com", PW)]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.message === "EmailTaken")).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM credential_accounts WHERE email = 'race@example.com'")).rows[0].n).toBe(1);
  });

  it("refuse a bad email or password with a code and store nothing", async () => {
    for (const [email, password] of [["not-an-email", PW], ["a@b", PW], ["ok@example.com", "short"], ["ok@example.com", "x".repeat(129)], ["", PW]]) {
      await expect(createCredentialUser(email!, password!), `${email} / ${password!.length}`).rejects.toThrow("InvalidCredentials");
    }
    expect((await db.query("SELECT count(*)::int AS n FROM credential_accounts")).rows[0].n).toBe(0);
  });

  it("check the password: right gives the account; wrong, unknown email and wrong case of the password give nothing", async () => {
    await createCredentialUser("check@example.com", PW);
    expect(await verifyCredentialUser("check@example.com", PW)).not.toBeNull();
    expect(await verifyCredentialUser("check@example.com", PW.toUpperCase())).toBeNull();
    expect(await verifyCredentialUser("check@example.com", "wrong-password-1")).toBeNull();
    expect(await verifyCredentialUser("nobody@example.com", PW)).toBeNull();
  });

  it("are checked by the database itself, so no writer can store a plain password, a fast hash or a mixed-case email", async () => {
    const insert = (email: string, hash: string) => db.query("INSERT INTO credential_accounts (email, name, password_hash) VALUES ($1, 'n', $2)", [email, hash]);
    await expect(insert("x@example.com", "plaintext-password")).rejects.toThrow(/check/i);
    await expect(insert("x@example.com", "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8")).rejects.toThrow(/check/i);
    await expect(insert("Mixed@Example.com", "scrypt$1$2$3$a$b")).rejects.toThrow(/check/i);
    await expect(insert("x@example.com", "scrypt$32768$8$1$c2FsdA$aGFzaA")).resolves.toBeDefined();
  });

  it("are not patients: signing up creates no calendar identity and touches no other table", async () => {
    const before = (await db.query("SELECT (SELECT count(*) FROM patients)::int AS p, (SELECT count(*) FROM users)::int AS u")).rows[0];
    await createCredentialUser("nopatient@example.com", PW);
    expect((await db.query("SELECT (SELECT count(*) FROM patients)::int AS p, (SELECT count(*) FROM users)::int AS u")).rows[0]).toEqual(before);
  });
});

describe("the attempt limit, kept in the database", () => {
  const W = { limit: 3, windowMs: 60_000 };

  it("counts attempts, refuses past the limit with a time to wait, and peek does not count", async () => {
    const store = new PgCredentialStore(db);
    expect((await store.peek("k", W)).allowed).toBe(true);
    const verdicts = [];
    for (let i = 0; i < 5; i++) verdicts.push(await new PgCredentialStore(db).consume("k2", W)); // a different store object each time: the count is not in memory
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false, false]);
    expect(verdicts[3]!.retryAfterMs).toBeGreaterThan(50_000);
    expect(verdicts[0]!.retryAfterMs).toBe(0);
    const before = (await db.query("SELECT count FROM auth_throttle WHERE key = 'k2'")).rows[0].count;
    expect((await store.peek("k2", W)).allowed).toBe(false);
    expect((await db.query("SELECT count FROM auth_throttle WHERE key = 'k2'")).rows[0].count).toBe(before);
  });

  it("counts simultaneous attempts exactly once each", async () => {
    const store = new PgCredentialStore(db);
    const results = await Promise.all(Array.from({ length: 12 }, () => store.consume("race", { limit: 5, windowMs: 60_000 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect((await db.query("SELECT count FROM auth_throttle WHERE key = 'race'")).rows[0].count).toBe(12);
  });

  it("starts a new window once the old one has ended, and clear forgets a key", async () => {
    const store = new PgCredentialStore(db);
    for (let i = 0; i < 4; i++) await store.consume("w", W);
    expect((await store.peek("w", W)).allowed).toBe(false);
    await db.query("UPDATE auth_throttle SET window_start = now() - interval '2 minutes' WHERE key = 'w'");
    expect((await store.peek("w", W)).allowed).toBe(true);
    expect((await store.consume("w", W)).allowed).toBe(true);
    expect((await db.query("SELECT count FROM auth_throttle WHERE key = 'w'")).rows[0].count).toBe(1);
    await store.clear("w");
    expect((await db.query("SELECT count(*)::int AS n FROM auth_throttle WHERE key = 'w'")).rows[0].n).toBe(0);
  });

  it("stores only hashed keys: no address and no email is written to the table", async () => {
    await authenticateCredentials("private.person@example.com", "x".repeat(10), "203.0.113.77");
    const keys = (await db.query("SELECT key FROM auth_throttle")).rows.map((r) => r.key as string);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const k of keys) {
      expect(k).not.toContain("203.0.113.77");
      expect(k).not.toContain("private");
      expect(k.length).toBeLessThanOrEqual(60);
    }
  });
});

describe("authenticateCredentials: the one door a sign-in goes through", () => {
  const ADDR = "198.51.100.10";
  it("signs in with the right password and refuses a wrong one", async () => {
    await createCredentialUser("door@example.com", PW);
    expect(await authenticateCredentials("door@example.com", PW, ADDR)).toMatchObject({ email: "door@example.com" });
    expect(await authenticateCredentials("door@example.com", "wrong-password-1", ADDR)).toBeNull();
    expect(await authenticateCredentials("nobody@example.com", PW, ADDR)).toBeNull();
  });

  it("locks an account for an address after too many attempts, and then refuses even the right password", async () => {
    await createCredentialUser("locked@example.com", PW);
    for (let i = 0; i < SIGN_IN_LIMITS.perAccount.limit; i++) expect(await authenticateCredentials("locked@example.com", "wrong-password-1", ADDR)).toBeNull();
    expect(await signInThrottled("locked@example.com", ADDR)).toBe(true);
    expect(await authenticateCredentials("locked@example.com", PW, ADDR)).toBeNull(); // the right password is refused while locked
  });

  it("does not let one visitor lock another out: the limit is per address and email", async () => {
    await createCredentialUser("victim@example.com", PW);
    for (let i = 0; i < 12; i++) await authenticateCredentials("victim@example.com", "wrong-password-1", "203.0.113.200");
    expect(await signInThrottled("victim@example.com", "203.0.113.200")).toBe(true);
    expect(await signInThrottled("victim@example.com", "198.51.100.99")).toBe(false);
    expect(await authenticateCredentials("victim@example.com", PW, "198.51.100.99")).toMatchObject({ email: "victim@example.com" });
  });

  it("limits an address across many emails too", async () => {
    for (let i = 0; i < SIGN_IN_LIMITS.perAddress.limit; i++) await authenticateCredentials(`spray${i}@example.com`, "wrong-password-1", "203.0.113.50");
    await createCredentialUser("real@example.com", PW);
    expect(await authenticateCredentials("real@example.com", PW, "203.0.113.50")).toBeNull();
    expect(await authenticateCredentials("real@example.com", PW, "203.0.113.51")).not.toBeNull();
  });

  it("a successful sign-in clears that account's counter", async () => {
    await createCredentialUser("clear@example.com", PW);
    for (let i = 0; i < SIGN_IN_LIMITS.perAccount.limit - 2; i++) await authenticateCredentials("clear@example.com", "wrong-password-1", ADDR);
    expect(await authenticateCredentials("clear@example.com", PW, ADDR)).not.toBeNull();
    const k = signInKeys("clear@example.com", ADDR).account;
    expect((await db.query("SELECT count(*)::int AS n FROM auth_throttle WHERE key = $1", [k])).rows[0].n).toBe(0);
  });

  it("limits sign-ups per address", async () => {
    const results = [];
    for (let i = 0; i < SIGN_UP_LIMIT.limit + 2; i++) results.push(await signUpAllowed("203.0.113.9"));
    expect(results.filter(Boolean)).toHaveLength(SIGN_UP_LIMIT.limit);
    expect(await signUpAllowed("203.0.113.10")).toBe(true);
  });

  it("says no, and does not throw, when the store fails or there is none", async () => {
    const broken: CredentialStore = { create: async () => { throw new Error("postgres://user:secret@host/db is down"); }, find: async () => { throw new Error("down"); }, consume: async () => { throw new Error("down"); }, peek: async () => { throw new Error("down"); }, clear: async () => undefined };
    setCredentialStoreForTesting(broken);
    expect(await authenticateCredentials("a@example.com", PW, ADDR)).toBeNull();
    expect(await signInThrottled("a@example.com", ADDR)).toBe(false);
    expect(await signUpAllowed(ADDR)).toBe(true);
    await expect(createCredentialUser("a@example.com", PW)).rejects.toThrow(/^Unavailable$/); // a code, never the database's message
    setCredentialStoreForTesting(null);
    expect(await authenticateCredentials("a@example.com", PW, ADDR)).toBeNull();
    await expect(createCredentialUser("a@example.com", PW)).rejects.toThrow("Unavailable");
  });
});

describe("where the store comes from", () => {
  it("is the database when one is configured", () => {
    setCredentialStoreForTesting(undefined);
    vi.stubEnv("DATABASE_URL", process.env.DATABASE_URL ?? "postgres://u:p@localhost:5433/x");
    expect(getCredentialStore({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBeInstanceOf(PgCredentialStore);
    expect(credentialsAvailable()).toBe(true);
  });
  it("in production without a database there is NO email sign-in (never a memory store that would lose accounts)", () => {
    setCredentialStoreForTesting(undefined);
    vi.stubEnv("DATABASE_URL", "");
    expect(getCredentialStore({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBeNull();
  });
  it("outside production without a database a throwaway in-memory store is used for a quick local run", () => {
    setCredentialStoreForTesting(undefined);
    vi.stubEnv("DATABASE_URL", "");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(getCredentialStore({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBeInstanceOf(MemoryCredentialStore);
  });
});

describe("small helpers", () => {
  it("looksLikeEmail", () => {
    for (const ok of ["a@b.co", "first.last+tag@sub.example.com"]) expect(looksLikeEmail(ok)).toBe(true);
    for (const bad of ["", "a", "a@b", "a b@c.d", "@b.c", `${"x".repeat(250)}@b.co`]) expect(looksLikeEmail(bad), bad).toBe(false);
  });
  it("clientAddress takes the first forwarded address, then the real-ip header, and otherwise says unknown", () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(clientAddress(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientAddress(h({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientAddress(h({}))).toBe("unknown");
    expect(clientAddress(undefined)).toBe("unknown");
  });
});

describe("the memory store behaves like the database one", () => {
  it("counts, refuses and forgets the same way, with an injected clock", async () => {
    let now = 1_000_000;
    const m = new MemoryCredentialStore(() => now);
    const W = { limit: 2, windowMs: 1000 };
    expect([await m.consume("k", W), await m.consume("k", W), await m.consume("k", W)].map((v) => v.allowed)).toEqual([true, true, false]);
    expect((await m.peek("k", W)).allowed).toBe(false);
    now += 1001;
    expect((await m.peek("k", W)).allowed).toBe(true);
    expect((await m.consume("k", W)).allowed).toBe(true);
    await m.clear("k");
    expect((await m.peek("k", W)).allowed).toBe(true);
    expect(await m.create({ email: "a@b.co", name: "a", passwordHash: "scrypt$x" })).toMatchObject({ email: "a@b.co" });
    expect(await m.create({ email: "a@b.co", name: "a", passwordHash: "scrypt$x" })).toBe("EMAIL_TAKEN");
  });
});
