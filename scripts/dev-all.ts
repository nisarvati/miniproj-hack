import { spawnSync } from "node:child_process";
import { runServices, type ServiceSpec } from "./lib/orchestrator.js";
import { fetchJson, firstNode, hostPort, processExists, tcpProbe } from "./lib/probe.js";
import { BACKGROUND, collectStatus, formatStatus } from "./lib/status.js";

/**
 * npm run dev:all [-- --check] [-- --infra] [-- --skip=web,portal]
 *
 * Starts the MedLink development services together, using the existing workspace scripts, with every log line prefixed by its
 * service. Ctrl+C stops only the processes this command started.
 *
 *  - It never kills, restarts or replaces anything already running. A service whose port is taken, whose health endpoint already
 *    answers, or which already has a process, is SKIPPED with a message, not started twice.
 *  - It does not start infrastructure unless you pass --infra (which runs the documented `npm run infra:up`, a no-op for
 *    containers that are already running). Without it, unreachable PostgreSQL/Redis stops the run with a clear message.
 *  - It does not turn real email on: the notification service reads its own EMAIL_DELIVERY_ENABLED and says which mode it is in.
 *  - --check only reports what it would do. Starting a process is not proof of health: after the start it prints the real status
 *    (the same as `npm run services:status`).
 */
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const skip = new Set((args.find((a) => a.startsWith("--skip="))?.slice(7) ?? "").split(",").filter(Boolean));
const unknown = args.filter((a) => !["--check", "--infra"].includes(a) && !a.startsWith("--skip="));
if (unknown.length) {
  console.error(`Unknown option ${unknown.join(" ")}.\nUsage: npm run dev:all -- [--check] [--infra] [--skip=web,api,portal,connector,sync,notify]`);
  process.exit(2);
}

const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isInteger(Number(v)) ? Number(v) : d);

interface Planned extends ServiceSpec {
  key: string;
  port: number;
  /** For background services: what to call to see whether it is already running. */
  health: boolean;
  app: string;
}
const npm = (script: string) => ({ command: "npm", args: ["run", script] });
const PLAN: Planned[] = [
  { key: "web", name: "web", ...npm("web:dev"), port: 3000, health: false, app: "web" },
  { key: "api", name: "api", ...npm("api:dev"), port: num(env.PORT, 4000), health: false, app: "search-service" },
  { key: "portal", name: "portal", ...npm("portal:dev"), port: num(env.PORTAL_PORT, 4200), health: false, app: "pharmacy-portal" },
  { key: "connector", name: "connector", ...npm("connector:start"), port: num(env.HEALTH_PORT_CONNECTOR, BACKGROUND[0].port), health: true, app: "inventory-connector" },
  { key: "sync", name: "sync", ...npm("sync:start"), port: num(env.HEALTH_PORT_SYNC, BACKGROUND[1].port), health: true, app: "inventory-sync" },
  { key: "notify", name: "notify", ...npm("notify:start"), port: num(env.HEALTH_PORT_NOTIFY, BACKGROUND[2].port), health: true, app: "notification-service" },
];

async function decide(p: Planned): Promise<{ start: boolean; why: string }> {
  if (skip.has(p.key)) return { start: false, why: "skipped by --skip" };
  if (p.health) {
    const h = await fetchJson(`http://127.0.0.1:${p.port}/health`);
    if (h.ok) return { start: false, why: `already running (its health endpoint answers on port ${p.port}); not starting a second copy` };
    if ((await processExists(`${process.cwd()}/apps/${p.app}`)) === true) {
      return { start: false, why: "a process for it already exists (an older build with no health endpoint); not starting a duplicate. Restart it yourself to get health reporting" };
    }
    return { start: true, why: "starting" };
  }
  return (await tcpProbe("127.0.0.1", p.port))
    ? { start: false, why: `port ${p.port} is already in use (probably already running); not starting it, and not touching what is there` }
    : { start: true, why: "starting" };
}

async function infraReachable() {
  const pg = hostPort(env.DATABASE_URL, 5432) ?? { host: "127.0.0.1", port: 5433 };
  const rd = env.REDIS_MODE === "cluster" ? firstNode(env.REDIS_CLUSTER_NODES) : (hostPort(env.REDIS_URL, 6379) ?? { host: "127.0.0.1", port: 6379 });
  const [postgres, redis] = await Promise.all([tcpProbe(pg.host, pg.port), rd ? tcpProbe(rd.host, rd.port) : Promise.resolve(false)]);
  return { postgres, redis, pg, rd };
}

if (flag("--infra")) {
  console.log("[dev] --infra: running `npm run infra:up` (starts PostgreSQL and Redis if they are not already running)");
  const r = spawnSync("npm", ["run", "infra:up"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const infra = await infraReachable();
if (!infra.postgres || !infra.redis) {
  console.error(
    `[dev] cannot start: ${[!infra.postgres && `PostgreSQL is not reachable at ${infra.pg.host}:${infra.pg.port}`, !infra.redis && "Redis is not reachable"].filter(Boolean).join(" and ")}.\n` +
      "      Start them with `npm run infra:up` (or run `npm run dev:all -- --infra`), then try again. Nothing was started.",
  );
  process.exit(1);
}

const decisions = await Promise.all(PLAN.map(async (p) => ({ p, ...(await decide(p)) })));
for (const d of decisions) console.log(`[dev] ${d.p.name.padEnd(9)} ${d.start ? "will start" : "not started"}: ${d.why}`);
const toStart = decisions.filter((d) => d.start).map((d) => d.p);

if (flag("--check")) {
  console.log("[dev] --check: nothing was started.");
  process.exit(0);
}
if (!toStart.length) {
  console.log("[dev] everything is already running or skipped; nothing to start. See `npm run services:status` for health.");
  process.exit(0);
}

// A summary, not a claim: started processes are reported by what their own health checks say, a few seconds later.
const report = async (label: string) => console.log(`\n[dev] ${label}\n${formatStatus(await collectStatus(env, process.cwd()))}\n`);
setTimeout(() => void report("status 10 s after start (a process existing is not the same as being ready)"), 10_000).unref();
setTimeout(() => void report("status 40 s after start"), 40_000).unref();

const code = await runServices(toStart, { onStarted: (pids) => console.log(`[dev] started ${Object.keys(pids).join(", ")}. Press Ctrl+C to stop these (and only these).`) });
process.exit(code);
