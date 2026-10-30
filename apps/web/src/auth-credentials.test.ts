/**
 * The email-and-password sign-in as a visitor meets it: the form's actions, the Auth.js door that checks the password, and the sign-in page's decision to offer
 * the form at all. Accounts and counters are in a throwaway in-memory store here (the PostgreSQL behaviour is tested in server/credentials), because the tests
 * load .env and must never write to the development database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REAL = { AUTH_SECRET: "test-only-secret-test-only-secret-1234", AUTH_GOOGLE_ID: "test-client-id.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "test-client-secret" };
const hdrs = vi.hoisted(() => ({ forwarded: "203.0.113.1" as string | null }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  },
}));
vi.mock("next/headers", () => ({ headers: async () => ({ get: (k: string) => (k === "x-forwarded-for" ? hdrs.forwarded : null) }) }));

beforeEach(() => {
  vi.resetModules();
  hdrs.forwarded = "203.0.113.1";
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const setup = async (opts: { secret?: boolean; store?: "memory" | "none" | import("./server/credentials/store").CredentialStore } = {}) => {
  for (const [k, v] of Object.entries(REAL)) vi.stubEnv(k, opts.secret === false ? "" : v);
  delete process.env.AUTH_URL;
  const signIn = vi.fn(async () => undefined);
  const signOut = vi.fn(async () => undefined);
  vi.doMock("./auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("./auth")>()), signIn, signOut }));
  const service = await import("./server/credentials/service");
  const { MemoryCredentialStore } = await import("./server/credentials/store");
  const store = opts.store === "none" ? null : opts.store && opts.store !== "memory" ? opts.store : new MemoryCredentialStore();
  service.setCredentialStoreForTesting(store);
  return { actions: await import("./auth-actions"), signIn, service, store };
};
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const redirectedTo = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await fn();
  } catch (e) {
    return (e as { redirectTo?: string }).redirectTo;
  }
  return undefined;
};
const PW = "a-long-enough-password";

describe("creating an account", () => {
  it("creates it and signs the visitor in to a checked destination", async () => {
    const { actions, signIn, service } = await setup();
    expect(await redirectedTo(() => actions.signUpWithEmail(form({ email: "New.Person@Example.com", password: PW, callbackUrl: "/account" })))).toBeUndefined();
    expect(signIn).toHaveBeenCalledWith("credentials", { email: "new.person@example.com", password: PW, redirectTo: "/account" });
    expect(await service.findCredentialUser("NEW.person@example.com")).toMatchObject({ email: "new.person@example.com" });
    await actions.signUpWithEmail(form({ email: "another@example.com", password: PW, callbackUrl: "https://evil.example/" }));
    expect(signIn).toHaveBeenLastCalledWith("credentials", { email: "another@example.com", password: PW, redirectTo: "/" });
  });

  it("lets the sign-in redirect through untouched (it is how a successful sign-in leaves the page), instead of turning it into an error", async () => {
    const { actions, signIn } = await setup();
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/account;307;" });
    signIn.mockRejectedValueOnce(redirect);
    await expect(actions.signUpWithEmail(form({ email: "ok@example.com", password: PW, callbackUrl: "/account" }))).rejects.toBe(redirect);
    signIn.mockRejectedValueOnce(redirect);
    await expect(actions.signInWithEmail(form({ email: "ok@example.com", password: PW, callbackUrl: "/account" }))).rejects.toBe(redirect);
  });

  it("an Auth.js error becomes a sign-in error code", async () => {
    const { AuthError } = await import("next-auth");
    const { actions, signIn } = await setup();
    signIn.mockRejectedValueOnce(new AuthError("denied"));
    expect(await redirectedTo(() => actions.signInWithEmail(form({ email: "x@example.com", password: PW })))).toMatch(/^\/signin\?error=/);
  });

  it("refuses a bad email or a password that is too short or too long, and creates nothing", async () => {
    const { actions, signIn, service } = await setup();
    for (const [email, password] of [["nope", PW], ["a@b", PW], ["ok@example.com", "short"], ["ok@example.com", "x".repeat(129)]] as const) {
      expect(await redirectedTo(() => actions.signUpWithEmail(form({ email, password }))), `${email}`).toBe("/signin?error=InvalidCredentials");
    }
    expect(signIn).not.toHaveBeenCalled();
    expect(await service.findCredentialUser("ok@example.com")).toBeNull();
  });

  it("says the email is taken, whatever its case", async () => {
    const { actions } = await setup();
    await actions.signUpWithEmail(form({ email: "taken@example.com", password: PW }));
    expect(await redirectedTo(() => actions.signUpWithEmail(form({ email: "TAKEN@example.com", password: PW })))).toBe("/signin?error=EmailTaken");
  });

  it("puts only a known code in the address when something fails, never a database or library message", async () => {
    const broken = { create: async () => { throw new Error("connect ECONNREFUSED postgres://web:hunter2@db.internal:5432/medlink"); }, find: async () => null, consume: async () => ({ allowed: true, retryAfterMs: 0 }), peek: async () => ({ allowed: true, retryAfterMs: 0 }), clear: async () => undefined };
    const { actions, signIn } = await setup({ store: broken });
    const to = await redirectedTo(() => actions.signUpWithEmail(form({ email: "a@example.com", password: PW })));
    expect(to).toBe("/signin?error=Unavailable");
    expect(to).not.toMatch(/hunter2|postgres|ECONNREFUSED/);
    expect(signIn).not.toHaveBeenCalled();
  });

  it("limits sign-ups per address, and another address is unaffected", async () => {
    const { actions } = await setup();
    const { SIGN_UP_LIMIT } = await import("./server/credentials/service");
    for (let i = 0; i < SIGN_UP_LIMIT.limit; i++) expect(await redirectedTo(() => actions.signUpWithEmail(form({ email: `u${i}@example.com`, password: PW })))).toBeUndefined();
    expect(await redirectedTo(() => actions.signUpWithEmail(form({ email: "one-too-many@example.com", password: PW })))).toBe("/signin?error=TooManyAttempts");
    hdrs.forwarded = "198.51.100.77";
    expect(await redirectedTo(() => actions.signUpWithEmail(form({ email: "elsewhere@example.com", password: PW })))).toBeUndefined();
  });
});

describe("signing in", () => {
  it("starts the sign-in with what was typed and a checked destination", async () => {
    const { actions, signIn } = await setup();
    await actions.signInWithEmail(form({ email: "a@example.com", password: PW, callbackUrl: "/search" }));
    expect(signIn).toHaveBeenCalledWith("credentials", { email: "a@example.com", password: PW, redirectTo: "/search" });
  });

  it("tells a visitor who has made too many attempts so, without starting a sign-in", async () => {
    const { actions, signIn, service } = await setup();
    await service.createCredentialUser("busy@example.com", PW);
    for (let i = 0; i < service.SIGN_IN_LIMITS.perAccount.limit; i++) await service.authenticateCredentials("busy@example.com", "wrong-password-1", "203.0.113.1");
    expect(await redirectedTo(() => actions.signInWithEmail(form({ email: "busy@example.com", password: PW })))).toBe("/signin?error=TooManyAttempts");
    expect(signIn).not.toHaveBeenCalled();
    hdrs.forwarded = "198.51.100.5"; // someone else, same email: not locked out by the first visitor's attempts
    expect(await redirectedTo(() => actions.signInWithEmail(form({ email: "busy@example.com", password: PW })))).toBeUndefined();
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("is not available without the auth secret, or without anywhere to keep accounts: it says not set up and starts nothing", async () => {
    for (const opts of [{ secret: false }, { store: "none" as const }]) {
      vi.resetModules();
      const { actions, signIn } = await setup(opts);
      expect(await redirectedTo(() => actions.signInWithEmail(form({ email: "a@example.com", password: PW })))).toBe("/signin?error=NotConfigured");
      expect(await redirectedTo(() => actions.signUpWithEmail(form({ email: "a@example.com", password: PW })))).toBe("/signin?error=NotConfigured");
      expect(signIn).not.toHaveBeenCalled();
    }
  });
});

describe("the Auth.js door (a request posted straight to /auth/callback/credentials)", () => {
  const authorize = async () => {
    const { credentialsProvider } = await import("./auth");
    const fn = (credentialsProvider as unknown as { options: { authorize: (c: unknown, r: Request) => Promise<{ id: string; email: string } | null> } }).options.authorize;
    return (credentials: unknown, from = "203.0.113.1") => fn(credentials, new Request("http://localhost:3000/auth/callback/credentials", { headers: { "x-forwarded-for": from } }));
  };

  it("checks the password and returns the account for the right one only", async () => {
    const { service } = await setup();
    await service.createCredentialUser("door@example.com", PW);
    const go = await authorize();
    expect(await go({ email: "door@example.com", password: PW })).toMatchObject({ email: "door@example.com" });
    expect(await go({ email: "door@example.com", password: "wrong-password-1" })).toBeNull();
    expect(await go({ email: "nobody@example.com", password: PW })).toBeNull();
  });

  it("enforces the attempt limit itself, so skipping the form does not skip the limit", async () => {
    const { service } = await setup();
    await service.createCredentialUser("guarded@example.com", PW);
    const go = await authorize();
    for (let i = 0; i < service.SIGN_IN_LIMITS.perAccount.limit; i++) await go({ email: "guarded@example.com", password: "wrong-password-1" });
    expect(await go({ email: "guarded@example.com", password: PW })).toBeNull(); // right password, but locked for this address
    expect(await go({ email: "guarded@example.com", password: PW }, "198.51.100.200")).toMatchObject({ email: "guarded@example.com" });
  });

  it("refuses malformed input without throwing", async () => {
    await setup();
    const go = await authorize();
    for (const bad of [undefined, null, {}, { email: "x" }, { email: "a@example.com", password: "short" }, { email: "a@example.com", password: "x".repeat(200) }, { email: 42, password: PW }]) expect(await go(bad)).toBeNull();
  });

  it("keeps the calendar for Google: a password account is never a patient identity", async () => {
    const { authCallbacks } = await import("./auth");
    const token = authCallbacks.jwt({ token: {} as never, account: { provider: "credentials" } as never, user: { id: "abc" } });
    const session = authCallbacks.session({ session: { user: {} } as never, token });
    expect((session.user as { provider?: string }).provider).toBe("credentials");
  });
});

describe("the sign-in page offers the email form only where it can work", () => {
  const page = async (store: "memory" | "none", secret = true) => {
    await setup({ store, secret });
    vi.doMock("./auth", () => ({ getSession: async () => null }));
    vi.doMock("./auth-actions", () => ({ signInWithGoogle: async () => undefined, signInWithEmail: async () => undefined, signUpWithEmail: async () => undefined }));
    const mod = await import("./app/signin/page");
    const el = (await mod.default({ searchParams: Promise.resolve({}) })) as { props: { emailEnabled: boolean; configured: boolean } };
    return el.props;
  };
  it("yes with the secret and a place for accounts", async () => {
    expect((await page("memory")).emailEnabled).toBe(true);
  });
  it("no without anywhere to keep accounts (production with no database), and no without the secret", async () => {
    expect((await page("none")).emailEnabled).toBe(false);
    vi.resetModules();
    expect((await page("memory", false)).emailEnabled).toBe(false);
  });
});
