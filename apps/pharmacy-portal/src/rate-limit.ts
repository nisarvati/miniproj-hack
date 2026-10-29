/**
 * Counts failures per key inside a fixed window, to slow down password guessing. It lives in this process's memory, so it resets when the portal restarts and is
 * not shared between several portal processes; behind a proxy every client shares the proxy's address unless the proxy is trusted (docs/security.md).
 * Memory is bounded: when `maxKeys` is reached, expired entries go first, then the oldest.
 */
export class AttemptLimiter {
  private readonly entries = new Map<string, { failures: number; since: number }>();

  constructor(
    private readonly opts: { max: number; windowMs: number; maxKeys?: number; now?: () => number },
  ) {}

  private now = () => (this.opts.now ?? Date.now)();

  /** Milliseconds until another attempt is allowed, or 0 when it is allowed now. */
  retryAfterMs(key: string): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    const left = e.since + this.opts.windowMs - this.now();
    if (left <= 0) {
      this.entries.delete(key);
      return 0;
    }
    return e.failures >= this.opts.max ? left : 0;
  }

  fail(key: string): void {
    const now = this.now();
    const e = this.entries.get(key);
    if (e && now < e.since + this.opts.windowMs) e.failures++;
    else {
      this.makeRoom(now);
      this.entries.set(key, { failures: 1, since: now });
    }
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private makeRoom(now: number): void {
    const cap = this.opts.maxKeys ?? 10_000;
    if (this.entries.size < cap) return;
    for (const [k, e] of this.entries) if (now >= e.since + this.opts.windowMs) this.entries.delete(k);
    while (this.entries.size >= cap) this.entries.delete(this.entries.keys().next().value as string); // the oldest (insertion order)
  }
}

/** Failures allowed per (client address, email) and per client address, in 15 minutes. Correct passwords are never counted. */
export const LOGIN_LIMITS = { perAccount: 8, perAddress: 40, windowMs: 15 * 60_000 } as const;
