import { fetchJson, firstNode, hostPort, processExists, redisPing, tcpProbe } from "./probe.js";

/**
 * The status of each MedLink component, with the most accurate word that can be established and an honest statement of what the
 * check actually proved. "healthy" is reserved for a component that answered a check that exercises what it depends on.
 */
export type State = "healthy" | "running" | "degraded" | "not running" | "unreachable" | "unknown";

export interface ComponentStatus {
  name: string;
  state: State;
  /** What was established, one short line each. No secrets, no connection strings, no email addresses. */
  notes: string[];
}

export const BACKGROUND = [
  { name: "Inventory connector", app: "inventory-connector", env: "HEALTH_PORT_CONNECTOR", port: 4301, start: "npm run connector:start" },
  { name: "Inventory sync", app: "inventory-sync", env: "HEALTH_PORT_SYNC", port: 4302, start: "npm run sync:start" },
  { name: "Notification service", app: "notification-service", env: "HEALTH_PORT_NOTIFY", port: 4303, start: "npm run notify:start" },
] as const;

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Turns a background service's /health report into a status. A reply proves the process; `ready` and `dependencies` prove the rest. */
export function fromHealthReport(name: string, status: number, body: unknown): ComponentStatus {
  const b = asRecord(body);
  const deps = asRecord(b.dependencies);
  const details = asRecord(b.details);
  const notes: string[] = [`process answering; ready: ${b.ready === true ? "yes" : "no"}`];
  const depText = Object.entries(deps).map(([k, v]) => `${k} ${String(v)}`);
  if (depText.length) notes.push(`dependencies: ${depText.join(", ")}`);
  if (typeof details.emailDelivery === "string") notes.push(`email delivery: ${details.emailDelivery}${Array.isArray(details.emailProblems) && details.emailProblems.length ? ` (${(details.emailProblems as string[]).join("; ")})` : ""}`);
  if (typeof details.pendingNotifications === "number") notes.push(`notifications waiting to be sent: ${details.pendingNotifications}`);
  if (details.unpublishedOutbox && typeof details.unpublishedOutbox === "object") {
    const total = Object.values(details.unpublishedOutbox as Record<string, number | null>).reduce<number>((a, n) => a + (n ?? 0), 0);
    notes.push(`events waiting in pharmacy outboxes: ${total}`);
  }
  if (typeof details.streams === "number") notes.push(`streams consumed: ${details.streams}`);
  for (const h of Array.isArray(b.hints) ? (b.hints as string[]) : []) notes.push(`hint: ${h}`);
  return { name, state: status === 200 && b.ready === true ? "healthy" : "degraded", notes };
}

export interface StatusEnv {
  [key: string]: string | undefined;
}

const num = (v: string | undefined, d: number) => (v && Number.isInteger(Number(v)) ? Number(v) : d);

export async function collectStatus(env: StatusEnv = process.env, repoRoot = process.cwd()): Promise<ComponentStatus[]> {
  const out: ComponentStatus[] = [];
  const apiPort = num(env.PORT, 4000);
  const portalPort = num(env.PORTAL_PORT, 4200);

  const [web, api, portal] = await Promise.all([
    fetchJson("http://127.0.0.1:3000/"),
    fetchJson(`http://127.0.0.1:${apiPort}/api/health`),
    fetchJson(`http://127.0.0.1:${portalPort}/health`),
  ]);
  const notRunning = (name: string, start: string, r: { ok: false; reason: string }): ComponentStatus => ({
    name,
    state: r.reason === "refused" ? "not running" : "unreachable",
    notes: [r.reason === "refused" ? `nothing is listening; start it with ${start}` : `no usable reply (${r.reason})`],
  });

  out.push(
    web.ok
      ? { name: "Web app", state: "running", notes: [`answers HTTP (status ${web.status}); this does not check the API or anything behind it`] }
      : notRunning("Web app", "npm run web:dev", web),
  );

  let apiDatabaseUp = false;
  if (api.ok) {
    const checks = asRecord(asRecord(api.body).checks);
    apiDatabaseUp = checks.database === "up";
    out.push({
      name: "Search API",
      state: api.status === 200 ? "healthy" : "degraded",
      notes: [`its own health check: database ${String(checks.database ?? "unknown")}${checks.live ? `, live stock ${String(checks.live)}` : ""}`],
    });
  } else out.push(notRunning("Search API", "npm run api:dev", api));

  out.push(
    portal.ok
      ? { name: "Pharmacy portal", state: "running", notes: ["answers its health route; that route does not check the databases behind it"] }
      : notRunning("Pharmacy portal", "npm run portal:dev", portal),
  );

  for (const svc of BACKGROUND) {
    const port = num(env[svc.env], svc.port);
    const report = await fetchJson(`http://127.0.0.1:${port}/health`);
    if (report.ok) {
      out.push(fromHealthReport(svc.name, report.status, report.body));
      continue;
    }
    const exists = await processExists(`${repoRoot}/apps/${svc.app}`);
    out.push(
      exists === true
        ? { name: svc.name, state: "unknown", notes: ["a process exists but it has no health endpoint (it was probably started before health reporting was added, or with its HEALTH_PORT_* variable set to off); its readiness cannot be checked", "restart it yourself to get a health report"] }
        : exists === null
          ? { name: svc.name, state: "unknown", notes: ["no health endpoint answered and the process list could not be checked"] }
          : { name: svc.name, state: "not running", notes: [`no health endpoint and no process found; start it with ${svc.start}`] },
    );
  }

  const pg = hostPort(env.DATABASE_URL, 5432) ?? { host: "127.0.0.1", port: 5433 };
  const pgUp = await tcpProbe(pg.host, pg.port);
  out.push(
    apiDatabaseUp
      ? { name: "PostgreSQL", state: "healthy", notes: ["answered a query through the search API's health check"] }
      : pgUp
        ? { name: "PostgreSQL", state: "running", notes: [`accepts connections on ${pg.host}:${pg.port}; login and schema were not tested`] }
        : { name: "PostgreSQL", state: "unreachable", notes: [`nothing accepts connections on ${pg.host}:${pg.port}; start it with npm run infra:up`] },
  );

  const cluster = env.REDIS_MODE === "cluster";
  const rd = cluster ? firstNode(env.REDIS_CLUSTER_NODES) : (hostPort(env.REDIS_URL, 6379) ?? { host: "127.0.0.1", port: 6379 });
  if (!rd) out.push({ name: "Redis", state: "unknown", notes: ["REDIS_MODE=cluster but no usable node in REDIS_CLUSTER_NODES"] });
  else {
    const r = await redisPing(rd.host, rd.port);
    out.push(
      r === "up"
        ? { name: "Redis", state: "healthy", notes: [`answered PING on ${rd.host}:${rd.port}${cluster ? " (first cluster node only)" : ""}`] }
        : r === "auth-required"
          ? { name: "Redis", state: "running", notes: [`reachable on ${rd.host}:${rd.port} but it requires a password, so PING was not tested`] }
          : r === "unexpected-reply"
            ? { name: "Redis", state: "degraded", notes: [`something answers on ${rd.host}:${rd.port} but not like Redis`] }
            : { name: "Redis", state: "unreachable", notes: [`nothing answers on ${rd.host}:${rd.port}; start it with npm run infra:up`] },
    );
  }
  return out;
}

const ICON: Record<State, string> = { healthy: "✓", running: "•", degraded: "!", "not running": "✗", unreachable: "✗", unknown: "?" };

export function formatStatus(rows: ComponentStatus[]): string {
  const width = Math.max(...rows.map((r) => r.name.length));
  return rows
    .map((r) => `${ICON[r.state]} ${r.name.padEnd(width)}  ${r.state}\n${r.notes.map((n) => `    ${n}`).join("\n")}`)
    .join("\n");
}

/** Non-zero when anything needed is absent or failing. "running" and "unknown" are not failures, but they are not "healthy" either. */
export const exitCodeFor = (rows: ComponentStatus[]) => (rows.some((r) => r.state === "not running" || r.state === "unreachable" || r.state === "degraded") ? 1 : 0);
