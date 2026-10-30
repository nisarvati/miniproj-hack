import { randomInt } from "node:crypto";
import type { Queryable } from "../calendar/repo";

/** What the rest of the app may know about an account. Never the password hash. */
export interface CredentialAccount {
  id: string;
  email: string;
  name: string;
}
export interface StoredCredential extends CredentialAccount {
  passwordHash: string;
}

/** `limit` attempts per `windowMs`. */
export interface Window {
  limit: number;
  windowMs: number;
}
export interface Verdict {
  allowed: boolean;
  /** When refused: how long until the window ends. */
  retryAfterMs: number;
}

/**
 * Where accounts and attempt counters are kept. The real one is PostgreSQL, because the web app may run as many short-lived server instances that share
 * nothing but the database: an account or a counter held in one instance's memory would not exist in the next.
 */
export interface CredentialStore {
  /** "EMAIL_TAKEN" when that email already has an account, decided by the database's unique index, so two simultaneous sign-ups cannot both win. */
  create(account: { email: string; name: string; passwordHash: string }): Promise<CredentialAccount | "EMAIL_TAKEN">;
  find(email: string): Promise<StoredCredential | null>;
  /** Counts one attempt against `key` and says whether it is still within the limit. */
  consume(key: string, w: Window): Promise<Verdict>;
  /** Says whether the NEXT attempt would be refused, without counting one. */
  peek(key: string, w: Window): Promise<Verdict>;
  clear(key: string): Promise<void>;
}

const verdict = (count: number, limit: number, retryAfterMs: number, counted: boolean): Verdict => {
  // consume: the attempt just counted is allowed while count <= limit. peek: the next one is allowed while count < limit.
  const allowed = counted ? count <= limit : count < limit;
  return { allowed, retryAfterMs: allowed ? 0 : Math.max(0, Math.round(retryAfterMs)) };
};

export class PgCredentialStore implements CredentialStore {
  constructor(private readonly db: Queryable) {}

  async create(a: { email: string; name: string; passwordHash: string }): Promise<CredentialAccount | "EMAIL_TAKEN"> {
    const { rows } = await this.db.query<{ id: string; email: string; name: string }>(
      "INSERT INTO credential_accounts (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, name",
      [a.email, a.name, a.passwordHash],
    );
    return rows[0] ?? "EMAIL_TAKEN";
  }

  async find(email: string): Promise<StoredCredential | null> {
    const { rows } = await this.db.query<{ id: string; email: string; name: string; password_hash: string }>("SELECT id, email, name, password_hash FROM credential_accounts WHERE email = $1", [email]);
    const r = rows[0];
    return r ? { id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash } : null;
  }

  async consume(key: string, w: Window): Promise<Verdict> {
    // One statement, so concurrent attempts are counted exactly once each: a window that has ended starts again at 1; otherwise the count goes up.
    const { rows } = await this.db.query<{ count: number; retry_ms: string }>(
      `INSERT INTO auth_throttle AS t (key, count, window_start) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN t.window_start <= now() - make_interval(secs => $2::double precision / 1000) THEN 1 ELSE t.count + 1 END,
         window_start = CASE WHEN t.window_start <= now() - make_interval(secs => $2::double precision / 1000) THEN now() ELSE t.window_start END
       RETURNING count, (extract(epoch FROM (t.window_start + make_interval(secs => $2::double precision / 1000) - now())) * 1000)::bigint AS retry_ms`,
      [key, w.windowMs],
    );
    // Old windows are tidied up now and then, on the way past, so the table cannot grow without bound.
    if (randomInt(0, 50) === 0) void this.db.query("DELETE FROM auth_throttle WHERE window_start < now() - interval '1 day'").catch(() => undefined);
    return verdict(rows[0]!.count, w.limit, Number(rows[0]!.retry_ms), true);
  }

  async peek(key: string, w: Window): Promise<Verdict> {
    const { rows } = await this.db.query<{ count: number; retry_ms: string }>(
      `SELECT count, (extract(epoch FROM (window_start + make_interval(secs => $2::double precision / 1000) - now())) * 1000)::bigint AS retry_ms
       FROM auth_throttle WHERE key = $1 AND window_start > now() - make_interval(secs => $2::double precision / 1000)`,
      [key, w.windowMs],
    );
    return rows[0] ? verdict(rows[0].count, w.limit, Number(rows[0].retry_ms), false) : { allowed: true, retryAfterMs: 0 };
  }

  async clear(key: string): Promise<void> {
    await this.db.query("DELETE FROM auth_throttle WHERE key = $1", [key]);
  }
}

/**
 * The same behaviour in memory. NOT for production: it is used only when no database is configured outside production (a quick local run) and in tests.
 * Accounts here disappear with the process.
 */
export class MemoryCredentialStore implements CredentialStore {
  private readonly accounts = new Map<string, StoredCredential>();
  private readonly windows = new Map<string, { count: number; start: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async create(a: { email: string; name: string; passwordHash: string }): Promise<CredentialAccount | "EMAIL_TAKEN"> {
    if (this.accounts.has(a.email)) return "EMAIL_TAKEN";
    const account = { id: crypto.randomUUID(), ...a };
    this.accounts.set(a.email, account);
    return { id: account.id, email: account.email, name: account.name };
  }
  async find(email: string): Promise<StoredCredential | null> {
    return this.accounts.get(email) ?? null;
  }
  async consume(key: string, w: Window): Promise<Verdict> {
    const now = this.now();
    const cur = this.windows.get(key);
    const next = !cur || cur.start <= now - w.windowMs ? { count: 1, start: now } : { count: cur.count + 1, start: cur.start };
    this.windows.set(key, next);
    return verdict(next.count, w.limit, next.start + w.windowMs - now, true);
  }
  async peek(key: string, w: Window): Promise<Verdict> {
    const now = this.now();
    const cur = this.windows.get(key);
    return cur && cur.start > now - w.windowMs ? verdict(cur.count, w.limit, cur.start + w.windowMs - now, false) : { allowed: true, retryAfterMs: 0 };
  }
  async clear(key: string): Promise<void> {
    this.windows.delete(key);
  }
}
