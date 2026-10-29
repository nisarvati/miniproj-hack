/**
 * Pure pieces of sign-in that need no auth library: whether it is configured, which redirect targets are safe, and the wording
 * of sign-in errors. Server and client code both use them. Nothing here reads a secret's value: `authConfigured` only asks
 * whether the three private settings are present.
 */

/** Where Auth.js is mounted. Not under /api: in development /api/* is proxied to the search service (see next.config.ts). */
export const AUTH_BASE_PATH = "/auth";

/** True only when the three private settings exist. Without them the site works as before and sign-in says it is not set up. */
export function authConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.AUTH_SECRET?.trim() && env.AUTH_GOOGLE_ID?.trim() && env.AUTH_GOOGLE_SECRET?.trim());
}

/**
 * A redirect target is accepted only if it is a path on this site. Anything else (another origin, protocol-relative `//host`,
 * backslash tricks, control characters, javascript: URLs, very long values) becomes `fallback`. This is what stops an
 * attacker-supplied `callbackUrl` from bouncing a signed-in user to another site.
 */
export function safeRedirect(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback;
  try {
    const resolved = new URL(raw, "http://medlink.invalid");
    if (resolved.origin !== "http://medlink.invalid") return fallback;
    const out = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    // Dot segments can normalise to a protocol-relative path ("/a/..//host"): that would leave the site.
    return out.startsWith("//") ? fallback : out;
  } catch {
    return fallback;
  }
}

/** What to tell the visitor for an Auth.js error code. The code itself is never shown, so a crafted URL cannot put text on the page. */
export function signInErrorMessage(code: unknown): string | null {
  if (typeof code !== "string" || !code) return null;
  switch (code) {
    case "AccessDenied":
      return "Google did not let this sign-in through. You may have cancelled, or the Google account's email is not verified.";
    case "OAuthCallbackError":
    case "OAuthSignin":
    case "OAuthAccountNotLinked":
    case "Callback":
      return "Signing in with Google did not finish. Please try again.";
    case "Configuration":
    case "NotConfigured":
      return "Google sign-in is not set up on this server yet.";
    case "SessionRequired":
      return "Please sign in to see that page.";
    default:
      return "Something went wrong while signing in. Please try again.";
  }
}
