/**
 * The server side of Google sign-in with no Google involved: the Auth.js endpoints answer under /auth, the sign-in rules reject
 * what they must, protected pages redirect without a session, and redirect targets are checked. Real Google sign-in needs real
 * provider configuration and a real account, and is not tested here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REAL = { AUTH_SECRET: "test-only-secret-test-only-secret-1234", AUTH_GOOGLE_ID: "test-client-id.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "test-client-secret" };
const configure = (on: boolean) => {
  for (const [k, v] of Object.entries(REAL)) vi.stubEnv(k, on ? v : "");
  delete process.env.AUTH_URL; // an empty AUTH_URL is not "unset" for Auth.js
};
beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const req = (path: string, init?: RequestInit) => new Request(`http://localhost:3000${path}`, init) as unknown as import("next/server").NextRequest;

describe("the Auth.js endpoints at /auth", () => {
  it("not configured: the session route says so, everything else is 503, and nothing throws", async () => {
    configure(false);
    const { GET, POST } = await import("./app/auth/[...nextauth]/route");
    expect(await (await GET(req("/auth/session"))).json()).toEqual({ configured: false });
    const signin = await POST(req("/auth/signin/google", { method: "POST" }));
    expect(signin.status).toBe(503);
    expect((await GET(req("/auth/callback/google?code=x&state=y"))).status).toBe(503);
  });

  it("configured: lists Google and email/password as providers, with the exact callback URL to register, and no secrets", async () => {
    configure(true);
    const { GET } = await import("./app/auth/[...nextauth]/route");
    const res = await GET(req("/auth/providers"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, { id: string; callbackUrl: string; signinUrl: string }>;
    expect(Object.keys(body)).toEqual(["google", "credentials"]);
    expect(body.google).toMatchObject({ id: "google", callbackUrl: "http://localhost:3000/auth/callback/google", signinUrl: "http://localhost:3000/auth/signin/google" });
    expect(body.credentials).toMatchObject({ id: "credentials", signinUrl: "http://localhost:3000/auth/signin/credentials" });
    expect(JSON.stringify(body)).not.toContain(REAL.AUTH_GOOGLE_SECRET);
  });

  it("configured: no cookie means no session, and a forged session cookie is not accepted", async () => {
    configure(true);
    const { GET } = await import("./app/auth/[...nextauth]/route");
    expect(await (await GET(req("/auth/session"))).json()).toBeNull();
    const forged = await GET(req("/auth/session", { headers: { cookie: "authjs.session-token=eyJhbGciOiJub25lIn0.eyJlbWFpbCI6ImV2aWxAZXhhbXBsZS5jb20ifQ." } }));
    expect(await forged.json()).toBeNull();
  });

  it("configured: the CSRF token route works, and the sign-in POST is refused without it", async () => {
    configure(true);
    const { GET, POST } = await import("./app/auth/[...nextauth]/route");
    expect(((await (await GET(req("/auth/csrf"))).json()) as { csrfToken: string }).csrfToken).toMatch(/\w{16,}/);
    const res = await POST(req("/auth/signin/google", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "callbackUrl=%2F" }));
    expect(res.headers.get("location") ?? "").toMatch(/error=MissingCSRF/);
  });
});

describe("the stable identity the calendar is keyed by", () => {
  const mint = async (token: Record<string, unknown>) => {
    const { encode } = await import("@auth/core/jwt");
    const jwt = await encode({ token, secret: REAL.AUTH_SECRET, salt: "authjs.session-token", maxAge: 600 });
    return { cookie: `authjs.session-token=${jwt}` };
  };

  it("a genuine session cookie yields the Google account id through Auth.js's own session route", async () => {
    configure(true);
    const { GET } = await import("./app/auth/[...nextauth]/route");
    const headers = await mint({ sub: "random-per-login-id", googleId: "google-sub-123", name: "Asha", email: "asha@example.com", picture: null });
    const body = (await (await GET(req("/auth/session", { headers }))).json()) as { user: { id: string; email: string } };
    expect(body.user).toMatchObject({ id: "google-sub-123", email: "asha@example.com" }); // not the token's own random sub
  });

  it("the id is Google's account id, never the random per-sign-in `sub`: a session that has only that carries no id", async () => {
    configure(true);
    const { GET } = await import("./app/auth/[...nextauth]/route");
    const headers = await mint({ sub: "9f1c0f6e-6f7e-4f43-9d52-3c4bd1a0e111", name: "Old", email: "old@example.com", picture: null });
    const body = (await (await GET(req("/auth/session", { headers }))).json()) as { user: { id?: string } };
    expect(body.user.id).toBeUndefined();
  });

  it("at sign-in the Google account id is kept from the account, once, and later calls leave it alone", async () => {
    configure(true);
    const { authCallbacks } = await import("./auth");
    const first = authCallbacks.jwt({ token: { sub: "random-1" } as never, account: { provider: "google", providerAccountId: "118273645501234567890", type: "oidc" } as never });
    expect((first as { googleId?: string }).googleId).toBe("118273645501234567890");
    const later = authCallbacks.jwt({ token: first, account: undefined });
    expect((later as { googleId?: string }).googleId).toBe("118273645501234567890");
    // a second sign-in of the same account gets another random sub, and the same Google id
    const again = authCallbacks.jwt({ token: { sub: "random-2" } as never, account: { provider: "google", providerAccountId: "118273645501234567890", type: "oidc" } as never });
    expect((again as { googleId?: string }).googleId).toBe((first as { googleId?: string }).googleId);
    expect(authCallbacks.jwt({ token: { sub: "x" } as never, account: { provider: "github", providerAccountId: "1", type: "oauth" } as never })).not.toHaveProperty("googleId");
  });

  it("a session with no subject carries no id, so it can never become a patient", async () => {
    configure(true);
    const { authCallbacks } = await import("./auth");
    const out = authCallbacks.session({ session: { user: { name: "x" }, expires: "" } as never, token: {} });
    expect((out.user as { id?: string }).id).toBeUndefined();
  });

  it("the calendar's real route files answer 401 without a session, and when sign-in is not configured", async () => {
    for (const on of [true, false]) {
      configure(on);
      vi.resetModules();
      const list = await import("./app/calendar-api/entries/route");
      const one = await import("./app/calendar-api/entries/[id]/route");
      const id = "00000000-0000-4000-8000-000000000000";
      const ctx = { params: Promise.resolve({ id }) };
      const bodies = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
      const statuses = [
        (await list.GET(req("/calendar-api/entries?from=2026-11-01&to=2026-11-30"))).status,
        (await list.POST(req("/calendar-api/entries", bodies))).status,
        (await one.GET(req(`/calendar-api/entries/${id}`), ctx)).status,
        (await one.PATCH(req(`/calendar-api/entries/${id}`, { ...bodies, method: "PATCH" }), ctx)).status,
        (await one.DELETE(req(`/calendar-api/entries/${id}`, { method: "DELETE" }), ctx)).status,
      ];
      expect(statuses, `configured=${on}`).toEqual([401, 401, 401, 401, 401]);
    }
  });
});

describe("who may sign in, and where they may land", () => {
  it("accepts Google accounts whose email Google verified and credentials sign-ins", async () => {
    configure(true);
    const { authCallbacks } = await import("./auth");
    const google = { provider: "google" } as never;
    expect(authCallbacks.signIn({ account: google, profile: { email: "a@example.com", email_verified: true } })).toBe(true);
    expect(authCallbacks.signIn({ account: google, profile: { email: "a@example.com", email_verified: false } })).toBe(false);
    expect(authCallbacks.signIn({ account: google, profile: { email: "a@example.com" } })).toBe(false);
    expect(authCallbacks.signIn({ account: google, profile: { email_verified: true } })).toBe(false);
    expect(authCallbacks.signIn({ account: { provider: "github" } as never, profile: { email: "a@example.com", email_verified: true } })).toBe(false);
    expect(authCallbacks.signIn({ account: { provider: "credentials" } as never, profile: undefined })).toBe(true);
    expect(authCallbacks.signIn({ account: null, profile: undefined })).toBe(false);
  });

  it("only lets Auth.js redirect to this site", async () => {
    configure(true);
    const { authCallbacks } = await import("./auth");
    const base = "http://localhost:3000";
    expect(authCallbacks.redirect({ url: "/account", baseUrl: base })).toBe("http://localhost:3000/account");
    expect(authCallbacks.redirect({ url: "http://localhost:3000/search?q=x", baseUrl: base })).toBe("http://localhost:3000/search?q=x");
    expect(authCallbacks.redirect({ url: "https://evil.example/phish", baseUrl: base })).toBe(base);
    expect(authCallbacks.redirect({ url: "//evil.example", baseUrl: base })).toBe("http://localhost:3000/");
    expect(authCallbacks.redirect({ url: "javascript:alert(1)", baseUrl: base })).toBe(base);
  });
});

describe("getSession", () => {
  it("is null without configuration, and without ever asking Auth.js", async () => {
    configure(false);
    const mod = await import("./auth");
    expect(await mod.getSession()).toBeNull();
  });
});

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  },
}));

describe("the protected page and the sign-in page", () => {
  const redirected = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return (e as { redirectTo?: string }).redirectTo;
    }
    return undefined;
  };

  it("/account without a session redirects to sign-in, remembering where to come back to", async () => {
    vi.doMock("./auth", () => ({ getSession: async () => null }));
    vi.doMock("./auth-actions", () => ({ signOutAction: async () => undefined }));
    const { default: Account } = await import("./app/account/page");
    expect(await redirected(() => Account())).toBe("/signin?callbackUrl=%2Faccount");
  });

  it("/account with a session shows the account page for that user", async () => {
    vi.doMock("./auth", () => ({ getSession: async () => ({ user: { name: "Asha", email: "a@example.com", image: null } }) }));
    vi.doMock("./auth-actions", () => ({ signOutAction: async () => undefined }));
    const { default: Account } = await import("./app/account/page");
    const element = (await Account()) as { props: { user: { email: string } } };
    expect(element.props.user.email).toBe("a@example.com");
  });

  it("/calendar without a session redirects to sign-in and brings the person back; with one it shows their own page", async () => {
    vi.doMock("./auth", () => ({ getSession: async () => null }));
    const { default: Calendar } = await import("./app/calendar/page");
    expect(await redirected(() => Calendar())).toBe("/signin?callbackUrl=%2Fcalendar");
    vi.resetModules();
    vi.doMock("./auth", () => ({ getSession: async () => ({ user: { name: "A", email: "a@example.com", image: null } }) }));
    const { default: Calendar2 } = await import("./app/calendar/page");
    const element = (await Calendar2()) as { key: string };
    expect(element.key).toBe("a@example.com");
  });

  it("/signin bounces an already signed-in visitor to a checked destination, never an external one", async () => {
    vi.doMock("./auth", () => ({ getSession: async () => ({ user: { name: "A", email: "a@example.com", image: null } }) }));
    vi.doMock("./auth-actions", () => ({ signInWithGoogle: async () => undefined, signInWithEmail: async () => undefined, signUpWithEmail: async () => undefined }));
    const { default: SignIn } = await import("./app/signin/page");
    expect(await redirected(() => SignIn({ searchParams: Promise.resolve({ callbackUrl: "/pharmacies" }) }))).toBe("/pharmacies");
    expect(await redirected(() => SignIn({ searchParams: Promise.resolve({ callbackUrl: "https://evil.example/" }) }))).toBe("/");
  });

  it("/signin for a signed-in visitor with no destination goes to the homepage", async () => {
    vi.doMock("./auth", () => ({ getSession: async () => ({ user: { name: "A", email: "a@example.com", image: null } }) }));
    vi.doMock("./auth-actions", () => ({ signInWithGoogle: async () => undefined, signInWithEmail: async () => undefined, signUpWithEmail: async () => undefined }));
    const { default: SignIn } = await import("./app/signin/page");
    expect(await redirected(() => SignIn({ searchParams: Promise.resolve({}) }))).toBe("/");
  });

  it("/signin for a visitor shows the form, with the error worded for people and the destination checked", async () => {
    vi.doMock("./auth", () => ({ getSession: async () => null }));
    vi.doMock("./auth-actions", () => ({ signInWithGoogle: async () => undefined, signInWithEmail: async () => undefined, signUpWithEmail: async () => undefined }));
    configure(true);
    const { default: SignIn } = await import("./app/signin/page");
    const element = (await SignIn({ searchParams: Promise.resolve({ error: "AccessDenied", callbackUrl: "//evil.example" }) })) as { props: { error: string; callbackUrl: string; configured: boolean } };
    expect(element.props).toMatchObject({ callbackUrl: "/", configured: true });
    expect(element.props.error).toMatch(/Google did not let this sign-in through/);
  });
});

describe("the sign-in and sign-out actions", () => {
  const setup = async (opts: { configured: boolean }) => {
    vi.doUnmock("./auth-actions");
    configure(opts.configured);
    const signIn = vi.fn(async () => undefined);
    const signOut = vi.fn(async () => undefined);
    vi.doMock("./auth", async (importOriginal) => {
      const auth = await importOriginal<typeof import("./auth")>();
      return {
        ...auth,
        looksLikeEmail: auth.looksLikeEmail,
        createCredentialUser: auth.createCredentialUser,
        findCredentialUser: auth.findCredentialUser,
        signIn,
        signOut,
      };
    });
    const mod = await import("./auth-actions");
    return { mod, signIn, signOut };
  };
  const form = (callbackUrl: string) => {
    const f = new FormData();
    f.set("callbackUrl", callbackUrl);
    return f;
  };
  const redirected = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return (e as { redirectTo?: string }).redirectTo;
    }
    return undefined;
  };

  it("starts the Google flow to a checked destination, whatever the form said", async () => {
    const { mod, signIn } = await setup({ configured: true });
    await mod.signInWithGoogle(form("/account"));
    expect(signIn).toHaveBeenLastCalledWith("google", { redirectTo: "/account" });
    await mod.signInWithGoogle(form("https://evil.example/"));
    expect(signIn).toHaveBeenLastCalledWith("google", { redirectTo: "/" });
  });

  it("when not configured it never starts a flow and sends the visitor back with a clear reason", async () => {
    const { mod, signIn } = await setup({ configured: false });
    expect(await redirected(() => mod.signInWithGoogle(form("/")))).toBe("/signin?error=NotConfigured");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("creates a local account and signs the visitor in with email and password", async () => {
    const { mod, signIn } = await setup({ configured: true });
    const email = `new-${Date.now()}@example.com`;
    const password = "super-secret";
    const signup = new FormData();
    signup.set("email", email);
    signup.set("password", password);
    signup.set("callbackUrl", "/search");
    await mod.signUpWithEmail(signup);
    expect(signIn).toHaveBeenLastCalledWith("credentials", { email, password, redirectTo: "/search" });
    const signin = new FormData();
    signin.set("email", email);
    signin.set("password", password);
    signin.set("callbackUrl", "/account");
    await mod.signInWithEmail(signin);
    expect(signIn).toHaveBeenLastCalledWith("credentials", { email, password, redirectTo: "/account" });
  });

  it("an Auth.js error becomes a sign-in error code; any other error is not swallowed", async () => {
    const { AuthError } = await import("next-auth");
    const { mod, signIn } = await setup({ configured: true });
    signIn.mockRejectedValueOnce(new AuthError("denied"));
    expect(await redirected(() => mod.signInWithGoogle(form("/")))).toMatch(/^\/signin\?error=/);
    signIn.mockRejectedValueOnce(new Error("NEXT_REDIRECT-like"));
    await expect(mod.signInWithGoogle(form("/"))).rejects.toThrow(/NEXT_REDIRECT-like/);
  });

  it("signs out to the sign-in page", async () => {
    const { mod, signOut } = await setup({ configured: true });
    await mod.signOutAction();
    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/signin" });
  });

  it("signing out when sign-in is not set up still ends at the sign-in page, without touching Auth.js", async () => {
    const { mod, signOut } = await setup({ configured: false });
    expect(await redirected(() => mod.signOutAction())).toBe("/signin");
    expect(signOut).not.toHaveBeenCalled();
  });
});
