/**
 * Whether the inventory sync service itself says it is running and ready (its own GET /health on 127.0.0.1, packages/db health.ts).
 * Redis cannot tell "caught up" from "nobody is consuming", so a node is only called healthy when this confirms the consumer. Best effort:
 * not reachable (stopped, or on another host) is "unreachable", which means no evidence, and the node is then reported unknown.
 */
export type SyncServiceState = "ready" | "not-ready" | "unreachable";

export interface SyncServiceHealthSource {
  read(): Promise<SyncServiceState>;
}

/** A health report is "ready" only when it says so explicitly; anything else that parses is "not-ready", anything that does not is "unreachable". */
export function parseServiceReport(body: unknown): SyncServiceState {
  if (typeof body !== "object" || body === null) return "unreachable";
  const ready = (body as { ready?: unknown }).ready;
  return ready === true ? "ready" : ready === false ? "not-ready" : "unreachable";
}

export class HttpSyncServiceHealth implements SyncServiceHealthSource {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 1000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async read(): Promise<SyncServiceState> {
    try {
      // 503 means "degraded" and still carries the report, so the status code is not checked.
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      return parseServiceReport(await res.json());
    } catch {
      return "unreachable";
    }
  }
}
