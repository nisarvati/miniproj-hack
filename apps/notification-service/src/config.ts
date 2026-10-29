/**
 * Email delivery settings, read from the environment (the repository's root `.env`, loaded by `--env-file-if-exists` in the
 * start script). Nothing here ever returns, logs or echoes the password: callers get `hasPassword`, not the value.
 *
 *   EMAIL_DELIVERY_ENABLED  "true" to send real email. Anything else, or unset, keeps delivery off (the simulated notifier).
 *   SMTP_USER               the Gmail account that sends (it must own the App Password).
 *   SMTP_PASS               a Google App Password for that account. Never a normal account password.
 *   EMAIL_FROM              the From header. Defaults to "MedLink <SMTP_USER>". Gmail only sends as the account itself.
 *   NEXT_PUBLIC_SITE_URL    the public address of the web app (already used by the web app); the link in the email.
 */
export interface EmailConfig {
  /** Real delivery was asked for. Off unless EMAIL_DELIVERY_ENABLED is exactly true/1/yes/on. */
  enabled: boolean;
  user: string | null;
  from: string | null;
  hasPassword: boolean;
  /** Public address of the web app, no trailing slash. */
  appUrl: string;
  /** Why real delivery cannot work yet. Empty when disabled or fully configured. Names settings, never values. */
  problems: string[];
}

const TRUE = /^(1|true|yes|on)$/i;
const DEFAULT_APP_URL = "http://localhost:3000";
const looksLikeEmail = (s: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

/** "Name <a@b.c>" or "a@b.c": the address part, or null if there is none. */
export function addressOf(from: string): string | null {
  const m = /<([^<>]+)>\s*$/.exec(from.trim());
  const addr = (m ? m[1]! : from).trim();
  return looksLikeEmail(addr) ? addr : null;
}

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const enabled = TRUE.test((env.EMAIL_DELIVERY_ENABLED ?? "").trim());
  const user = env.SMTP_USER?.trim() || null;
  const pass = env.SMTP_PASS ?? "";
  const configuredFrom = env.EMAIL_FROM?.trim() || null;
  const from = configuredFrom ?? (user ? `MedLink <${user}>` : null);

  let appUrl = DEFAULT_APP_URL;
  const site = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) {
    try {
      const u = new URL(site);
      if (u.protocol === "http:" || u.protocol === "https:") appUrl = u.toString().replace(/\/+$/, "");
    } catch {
      /* an unusable address falls back to the local default rather than putting a broken link in an email */
    }
  }

  const problems: string[] = [];
  if (enabled) {
    if (!user) problems.push("SMTP_USER is not set");
    else if (!looksLikeEmail(user)) problems.push("SMTP_USER is not an email address");
    if (!pass.trim()) problems.push("SMTP_PASS is not set");
    if (configuredFrom && !addressOf(configuredFrom)) problems.push("EMAIL_FROM is not an email address");
  }
  return { enabled, user, from, hasPassword: pass.trim().length > 0, appUrl, problems };
}
