import { execFile } from "node:child_process";
import { connect } from "node:net";

/**
 * Read-only probes for the development tooling. Nothing here writes to a database, to Redis or to any service, and nothing here
 * prints a connection string: callers get hosts and ports, states and counts.
 */

export type FetchResult = { ok: true; status: number; body: unknown } | { ok: false; reason: "refused" | "timeout" | "error" };

export async function fetchJson(url: string, ms = 2500): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* a page, not JSON: the status alone is the answer */
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, reason: "timeout" };
    const code = (err as { cause?: { code?: string } }).cause?.code;
    return { ok: false, reason: code === "ECONNREFUSED" ? "refused" : "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether something accepts TCP connections at host:port. */
export function tcpProbe(host: string, port: number, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(ms, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export type RedisProbe = "up" | "auth-required" | "unexpected-reply" | "unreachable";

/** Sends one PING over the raw protocol. Read-only; it authenticates nothing and stores nothing. */
export function redisPing(host: string, port: number, ms = 1500): Promise<RedisProbe> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (r: RedisProbe) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(ms, () => done("unreachable"));
    socket.once("error", () => done("unreachable"));
    socket.once("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
    socket.once("data", (d) => {
      const reply = d.toString();
      done(reply.startsWith("+PONG") ? "up" : reply.startsWith("-NOAUTH") || reply.startsWith("-ERR operation not permitted") ? "auth-required" : "unexpected-reply");
    });
  });
}

/** Host and port of a URL, without its credentials or path. Null if it is not a URL. */
export function hostPort(url: string | undefined, fallbackPort: number): { host: string; port: number } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname, port: u.port ? Number(u.port) : fallbackPort };
  } catch {
    return null;
  }
}

/** "host:port" of the first cluster seed node, or null. */
export function firstNode(nodes: string | undefined): { host: string; port: number } | null {
  const first = nodes?.split(",")[0]?.trim();
  const m = first ? /^(.+):(\d+)$/.exec(first) : null;
  return m ? { host: m[1] === "localhost" ? "127.0.0.1" : m[1]!, port: Number(m[2]) } : null;
}

const run = (cmd: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 4_000_000 }, (err, stdout) => resolve(err && !stdout ? null : String(stdout))));

/**
 * Whether a node process whose working directory is `<repo>/apps/<app>` exists. This only says a process EXISTS; it is never
 * proof that the service is healthy. Null when the check cannot be made (no `ps`/`lsof`).
 */
export async function processExists(appDir: string): Promise<boolean | null> {
  const ps = await run("ps", ["-axo", "pid=,command="]);
  if (ps === null) return null;
  const pids = ps
    .split("\n")
    .filter((l) => /\b(node|tsx)\b/.test(l) && /(src\/(main|server)\.ts|\.bin\/tsx|tsx\/dist)/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]!)
    .filter((p) => /^\d+$/.test(p));
  if (!pids.length) return false;
  const lsof = await run("lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")]);
  if (lsof === null) return null;
  return lsof.split("\n").some((l) => l.startsWith("n") && l.endsWith(appDir));
}
