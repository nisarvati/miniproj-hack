import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../../next.config";
import { portalUpstreamOrigin, webRewrites } from "./portal-upstream";

afterEach(() => vi.unstubAllEnvs());

describe("portalUpstreamOrigin", () => {
  it("is nothing when unset or blank, and a bare origin otherwise (no trailing slash)", () => {
    expect(portalUpstreamOrigin(undefined)).toBeNull();
    expect(portalUpstreamOrigin("")).toBeNull();
    expect(portalUpstreamOrigin("   ")).toBeNull();
    expect(portalUpstreamOrigin("https://medlink-portal.onrender.com")).toBe("https://medlink-portal.onrender.com");
    expect(portalUpstreamOrigin("https://medlink-portal.onrender.com/")).toBe("https://medlink-portal.onrender.com");
    expect(portalUpstreamOrigin("  https://portal.example.com:8443  ")).toBe("https://portal.example.com:8443");
  });
  it("allows plain http only for this machine", () => {
    expect(portalUpstreamOrigin("http://localhost:4200")).toBe("http://localhost:4200");
    expect(portalUpstreamOrigin("http://127.0.0.1:4200")).toBe("http://127.0.0.1:4200");
    expect(() => portalUpstreamOrigin("http://portal.onrender.com")).toThrow(/https/);
    expect(() => portalUpstreamOrigin("http://10.0.0.5:4200")).toThrow(/https/);
  });
  it.each([
    ["not a url", /not a valid URL/],
    ["ftp://portal.example.com", /https/],
    ["javascript:alert(1)", /https/],
    ["https://user:secret@portal.example.com", /credentials/],
    ["https://portal.example.com/portal", /origin only/],
    ["https://portal.example.com/?x=1", /query/],
    ["https://portal.example.com/#frag", /query or fragment/],
  ])("refuses %s, so a typo fails the build instead of proxying somewhere else", (bad, message) => {
    expect(() => portalUpstreamOrigin(bad)).toThrow(message);
  });
  it("never echoes a secret in its error", () => {
    try {
      portalUpstreamOrigin("https://user:topsecret@portal.example.com");
    } catch (err) {
      expect((err as Error).message).not.toMatch(/topsecret/);
    }
  });
});

describe("webRewrites", () => {
  const PROD = { NODE_ENV: "production", PORTAL_UPSTREAM_URL: "https://medlink-portal.onrender.com" };

  it("in production forwards only /portal-api/portal/* to the one configured upstream, and nothing else", () => {
    expect(webRewrites(PROD)).toEqual([{ source: "/portal-api/portal/:path*", destination: "https://medlink-portal.onrender.com/portal/:path*" }]);
  });
  it("is not an open proxy: the host is fixed in the rule, only a path is substituted, and the rule covers only the portal's own paths", () => {
    const [rule] = webRewrites(PROD);
    expect(rule!.source.startsWith("/portal-api/portal/")).toBe(true);
    expect(rule!.destination.startsWith("https://medlink-portal.onrender.com/portal/")).toBe(true);
    expect(rule!.destination.match(/:/g)).toHaveLength(2); // the scheme's colon and the one parameter
    for (const hostile of ["//evil.example.com/x", "@evil.example.com/x", "../../admin", "..%2F..%2Fadmin", "a?b=//evil.example.com", "https://evil.example.com", "\\\\evil.example.com"]) {
      const target = new URL(rule!.destination.replace(":path*", hostile));
      expect(target.origin, hostile).toBe("https://medlink-portal.onrender.com");
      expect(target.pathname.startsWith("/portal/") || target.pathname.startsWith("/admin"), hostile).toBe(true);
    }
  });
  it("takes the upstream from a server-side variable only: NEXT_PUBLIC_PORTAL_URL changes nothing here", () => {
    vi.stubEnv("NEXT_PUBLIC_PORTAL_URL", "https://evil.example.com");
    expect(webRewrites(PROD)[0]!.destination).toBe("https://medlink-portal.onrender.com/portal/:path*");
  });
  it("does not proxy the search API in production (the browser calls it directly) and has no rule for any other path", () => {
    expect(webRewrites(PROD).map((r) => r.source)).toEqual(["/portal-api/portal/:path*"]);
  });
  it("with no upstream in production it adds no rule and says so, rather than guessing a localhost address", () => {
    const warned: string[] = [];
    expect(webRewrites({ NODE_ENV: "production" }, (m) => warned.push(m))).toEqual([]);
    expect(warned[0]).toMatch(/PORTAL_UPSTREAM_URL is not set/);
  });
  it("in development keeps the local search API and portal rewrites, and the portal address can be overridden", () => {
    expect(webRewrites({ NODE_ENV: "development" })).toEqual([
      { source: "/api/:path*", destination: "http://localhost:4000/api/:path*" },
      { source: "/portal-api/portal/:path*", destination: "http://localhost:4200/portal/:path*" },
    ]);
    expect(webRewrites({ NODE_ENV: "development", PORTAL_UPSTREAM_URL: "http://127.0.0.1:4999" })[1]!.destination).toBe("http://127.0.0.1:4999/portal/:path*");
  });
  it("fails the build on an invalid upstream", () => {
    expect(() => webRewrites({ NODE_ENV: "production", PORTAL_UPSTREAM_URL: "http://portal.onrender.com" })).toThrow(/https/);
  });
});

describe("next.config.ts", () => {
  it("builds its rewrites from the environment at the time it is evaluated", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PORTAL_UPSTREAM_URL", "https://medlink-portal.onrender.com");
    expect(await config.rewrites!()).toEqual([{ source: "/portal-api/portal/:path*", destination: "https://medlink-portal.onrender.com/portal/:path*" }]);
  });
  it("keeps the existing redirects and does not advertise the framework", async () => {
    expect(config.poweredByHeader).toBe(false);
    const redirects = await config.redirects!();
    expect(redirects.map((r) => r.source)).toEqual(["/landing", "/"]);
  });
});
