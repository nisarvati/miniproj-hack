/**
 * The same-origin portal proxy. The browser only ever calls `/portal-api/portal/...` on the web app's own origin; the web host forwards exactly that to the pharmacy
 * portal. Because the browser talks to ONE origin, the portal's session cookie (HttpOnly, SameSite=Lax, Secure in production) stays first-party and needs no
 * loosening, and no CORS is involved. This module only decides WHAT is forwarded and WHERE:
 *   - where: one fixed upstream origin from the server-side variable PORTAL_UPSTREAM_URL (never NEXT_PUBLIC_*, so it is not in the browser bundle). Nothing the
 *     browser sends can change it: the host is fixed in the rule, and only a path is substituted.
 *   - what: only paths under /portal-api/portal/, forwarded to /portal/ on the upstream. Any other path is not proxied, so this is not an open proxy.
 * Next.js evaluates rewrites when the app is BUILT, so PORTAL_UPSTREAM_URL must be present at build time (and a change needs a new build).
 */
export interface Rewrite {
  source: string;
  destination: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The upstream's origin ("https://host[:port]", no trailing slash), or null when none is set. Throws on anything that is not a bare origin, so a typo fails the
 * build instead of quietly proxying somewhere else. Plain http is accepted only for a local address (development and local testing).
 */
export function portalUpstreamOrigin(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error("PORTAL_UPSTREAM_URL is not a valid URL (expected something like https://your-portal.onrender.com)");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    throw new Error("PORTAL_UPSTREAM_URL must be an https URL (plain http is only allowed for localhost)");
  }
  if (!u.hostname) throw new Error("PORTAL_UPSTREAM_URL has no host");
  if (u.username || u.password) throw new Error("PORTAL_UPSTREAM_URL must not contain credentials");
  if (u.search || u.hash) throw new Error("PORTAL_UPSTREAM_URL must not contain a query or fragment");
  if (u.pathname !== "/" && u.pathname !== "") throw new Error("PORTAL_UPSTREAM_URL must be an origin only, with no path");
  return u.origin;
}

/** The rewrites for the web app. In development the search API and the portal default to their local ports, as before. */
export function webRewrites(env: { NODE_ENV?: string; PORTAL_UPSTREAM_URL?: string }, log: (message: string) => void = console.warn): Rewrite[] {
  const development = env.NODE_ENV === "development";
  const upstream = portalUpstreamOrigin(env.PORTAL_UPSTREAM_URL) ?? (development ? "http://localhost:4200" : null);
  const rules: Rewrite[] = [];
  if (development) rules.push({ source: "/api/:path*", destination: "http://localhost:4000/api/:path*" });
  if (upstream) rules.push({ source: "/portal-api/portal/:path*", destination: `${upstream}/portal/:path*` });
  else log("PORTAL_UPSTREAM_URL is not set: /portal-api is not proxied, so the pharmacy portal will not work on this deployment");
  return rules;
}
