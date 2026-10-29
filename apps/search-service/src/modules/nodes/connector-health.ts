/**
 * What the inventory connector's own health endpoint (packages/db health.ts, GET /health on 127.0.0.1) says about each pharmacy.
 * It is the only place the unpublished outbox count and "is this pharmacy's database reachable" exist, because the outbox lives in
 * each pharmacy's own database and this service must not query those. Best effort: the connector may not be running, or may be on
 * another host, and then there is simply no evidence (null), never an invented value.
 */
export interface ConnectorPharmacy {
  /** null: the connector did not say. */
  databaseUp: boolean | null;
  /** null: the connector could not count. */
  unpublishedOutbox: number | null;
  /** The connector's last poll for this pharmacy failed. */
  pollingFailing: boolean;
}

export type ConnectorReading = { reachable: true; pharmacies: Map<string, ConnectorPharmacy> } | { reachable: false };

export interface ConnectorHealthSource {
  read(): Promise<ConnectorReading>;
}

/** Reads a connector health report defensively; anything that is not what it expects becomes "no evidence". */
export function parseConnectorReport(body: unknown): ConnectorReading {
  if (typeof body !== "object" || body === null) return { reachable: false };
  const b = body as { dependencies?: unknown; details?: { unpublishedOutbox?: unknown; pollingFailing?: unknown } };
  if (typeof b.dependencies !== "object" || b.dependencies === null || typeof b.details !== "object" || b.details === null) return { reachable: false };
  const deps = b.dependencies as Record<string, unknown>;
  const outbox = typeof b.details.unpublishedOutbox === "object" && b.details.unpublishedOutbox !== null ? (b.details.unpublishedOutbox as Record<string, unknown>) : {};
  const failing = new Set(Array.isArray(b.details.pollingFailing) ? b.details.pollingFailing.map(String) : []);
  const codes = new Set([...Object.keys(outbox), ...Object.keys(deps).filter((k) => k.startsWith("postgres:")).map((k) => k.slice("postgres:".length))]);
  const pharmacies = new Map<string, ConnectorPharmacy>();
  for (const code of codes) {
    const db = deps[`postgres:${code}`];
    const n = outbox[code];
    pharmacies.set(code, {
      databaseUp: db === "up" ? true : db === "down" ? false : null,
      unpublishedOutbox: typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null,
      pollingFailing: failing.has(code),
    });
  }
  return { reachable: true, pharmacies };
}

export class HttpConnectorHealth implements ConnectorHealthSource {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 1000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async read(): Promise<ConnectorReading> {
    try {
      // 503 means "degraded" and still carries the report, so the status code is not checked.
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      return parseConnectorReport(await res.json());
    } catch {
      return { reachable: false };
    }
  }
}
