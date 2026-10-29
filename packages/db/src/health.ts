import { createServer, type Server } from "node:http";

/**
 * A tiny health endpoint for the background services (connector, sync, notification service), which otherwise have no way to
 * say whether they are working. Each service reports THREE separate things, so "the process exists" is never read as "healthy":
 *   process       it is running and answering (implied by getting a reply at all)
 *   dependencies  whether PostgreSQL / Redis answered a bounded probe just now
 *   ready         whether it can do its work right now
 * Read-only: a probe only reads (PING, SELECT), nothing is written. Bound to 127.0.0.1. The report holds names, counts and states,
 * never a connection string, credential or email address.
 */
export type DependencyState = "up" | "down" | "not-configured";

export interface HealthReport {
  service: string;
  /** "ok": ready. "degraded": running but something it needs is failing. */
  status: "ok" | "degraded";
  ready: boolean;
  uptimeSec: number;
  dependencies: Record<string, DependencyState>;
  /** Counts and states specific to the service (streams consumed, unpublished outbox rows, email mode...). No secrets. */
  details: Record<string, unknown>;
  /** What to do about whatever is failing. */
  hints: string[];
}

export type HealthCheck = () => Promise<{ dependencies: Record<string, DependencyState>; details?: Record<string, unknown>; hints?: string[]; ready?: boolean }>;

/** Default local ports, one per background service. */
export const HEALTH_PORTS = { "inventory-connector": 4301, "inventory-sync": 4302, "notification-service": 4303 } as const;
/** Each service has its own override variable (they would collide on a shared one); "off" turns that endpoint off. */
export const HEALTH_PORT_ENV = { "inventory-connector": "HEALTH_PORT_CONNECTOR", "inventory-sync": "HEALTH_PORT_SYNC", "notification-service": "HEALTH_PORT_NOTIFY" } as const;

export function healthPortFor(service: keyof typeof HEALTH_PORTS, env: NodeJS.ProcessEnv = process.env): number | null {
  const v = env[HEALTH_PORT_ENV[service]]?.trim();
  if (v?.toLowerCase() === "off") return null;
  const n = v ? Number(v) : HEALTH_PORTS[service];
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : HEALTH_PORTS[service];
}

/** Rejects after `ms`, so a hung dependency becomes "down" instead of a hung health check. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** "up" if the probe resolves in time, "down" otherwise. Never throws. */
export async function probe(fn: () => Promise<unknown>, ms = 2000): Promise<"up" | "down"> {
  try {
    await withTimeout(fn(), ms);
    return "up";
  } catch {
    return "down";
  }
}

export async function buildReport(service: string, startedAt: number, check: HealthCheck, timeoutMs = 4000): Promise<HealthReport> {
  let result: Awaited<ReturnType<HealthCheck>>;
  try {
    result = await withTimeout(check(), timeoutMs);
  } catch (err) {
    result = { dependencies: {}, ready: false, hints: [`the health check itself failed: ${(err as Error).message}`] };
  }
  const failing = Object.entries(result.dependencies).filter(([, s]) => s === "down").map(([name]) => name);
  const ready = result.ready ?? failing.length === 0;
  const hints = [...(result.hints ?? [])];
  for (const name of failing) hints.push(DEPENDENCY_HINTS[name] ?? `${name} is not reachable`);
  return { service, status: ready ? "ok" : "degraded", ready, uptimeSec: Math.round((Date.now() - startedAt) / 1000), dependencies: result.dependencies, details: result.details ?? {}, hints };
}

const DEPENDENCY_HINTS: Record<string, string> = {
  redis: "Redis is not reachable: start it with `npm run infra:up` and check REDIS_URL / REDIS_MODE",
  postgres: "PostgreSQL is not reachable: start it with `npm run infra:up` and check DATABASE_URL",
};

export interface HealthServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Serves GET /health (200 when ready, 503 when degraded). If the port is taken (a second copy of the service, or another
 * program) it does NOT stop the service: it reports that through `onProblem` and returns null.
 */
export function startHealthServer(opts: {
  service: string;
  port: number;
  check: HealthCheck;
  host?: string;
  onProblem?: (message: string) => void;
}): Promise<HealthServer | null> {
  const startedAt = Date.now();
  const server: Server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/health") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }
    buildReport(opts.service, startedAt, opts.check).then(
      (report) => res.writeHead(report.ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(report)),
      () => res.writeHead(500).end(),
    );
  });
  return new Promise((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      opts.onProblem?.(err.code === "EADDRINUSE" ? `health port ${opts.port} is already in use (another copy of ${opts.service}?); running without a health endpoint. Set the service's HEALTH_PORT_* variable to use another port.` : `health endpoint could not start: ${err.message}`);
      resolve(null);
    });
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
