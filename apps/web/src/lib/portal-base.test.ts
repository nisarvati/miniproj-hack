import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, "");
    else vi.stubEnv(k, v);
  }
  if (env.NEXT_PUBLIC_PORTAL_URL === undefined) delete process.env.NEXT_PUBLIC_PORTAL_URL;
  return import("./portal");
}

describe("where the browser calls the portal", () => {
  it("in production: the web site's own origin, under /portal-api (so the session cookie stays first-party), never a localhost address", async () => {
    const { PORTAL_URL, getSession } = await load({ NODE_ENV: "production" });
    expect(PORTAL_URL).toBe("/portal-api");
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: { email: "a@b.c", role: "STAFF", pharmacy: null }, meta: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    await getSession({ fetchImpl });
    expect(seen[0]!.url).toBe("/portal-api/portal/me");
    expect(seen[0]!.url).not.toMatch(/localhost|127\.0\.0\.1/);
    expect(seen[0]!.init?.credentials).toBe("include");
  });
  it("in development and tests: the local portal directly, as before", async () => {
    expect((await load({ NODE_ENV: "development" })).PORTAL_URL).toBe("http://localhost:4200");
    expect((await load({ NODE_ENV: "test" })).PORTAL_URL).toBe("http://localhost:4200");
  });
  it("an explicit NEXT_PUBLIC_PORTAL_URL wins in every mode, and a trailing slash is dropped", async () => {
    expect((await load({ NODE_ENV: "production", NEXT_PUBLIC_PORTAL_URL: "https://portal.example.com/" })).PORTAL_URL).toBe("https://portal.example.com");
    expect((await load({ NODE_ENV: "development", NEXT_PUBLIC_PORTAL_URL: "/portal-api" })).PORTAL_URL).toBe("/portal-api");
  });
  it("a relative base builds the CSV download address on the same origin too", async () => {
    const { downloadPlansCsv } = await load({ NODE_ENV: "production" });
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response("plan_id\n", { status: 200, headers: { "content-disposition": 'attachment; filename="plans.csv"' } });
    }) as unknown as typeof fetch;
    // The download itself needs a browser (it saves a file); only the address it asks for matters here.
    await downloadPlansCsv("OPEN", { fetchImpl }).catch(() => undefined);
    expect(urls[0]).toBe("/portal-api/portal/restock-plans/export.csv?status=OPEN");
  });
});
