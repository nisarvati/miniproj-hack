/**
 * The development tooling: the orchestrator behind `npm run dev:all` and the probes behind `npm run services:status`. Uses
 * harmless throwaway child processes and local sockets only: no MedLink service, database, Redis or email is involved.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer as createHttp } from "node:http";
import { createServer as createTcp } from "node:net";
import { describe, expect, it } from "vitest";
import { prefixer, runServices } from "../scripts/lib/orchestrator.js";
import { fetchJson, firstNode, hostPort, redisPing, tcpProbe } from "../scripts/lib/probe.js";
import { exitCodeFor, formatStatus, fromHealthReport, type ComponentStatus } from "../scripts/lib/status.js";

const sleeper = (name: string, extra = ""): { name: string; command: string; args: string[] } => ({ name, command: process.execPath, args: ["-e", `console.log("${name} up"); ${extra} setInterval(() => {}, 1000)`] });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sink = () => {
  const lines: string[] = [];
  return { lines, out: { write: (s: string) => void lines.push(s) } };
};
const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("the orchestrator behind npm run dev:all", () => {
  it("prefixes every line with its service's name", async () => {
    const { lines, out } = sink();
    const stop = new EventEmitter();
    const done = runServices([sleeper("alpha"), sleeper("beta-long")], { out, stopSignal: stop, graceMs: 2000 });
    await until(() => lines.some((l) => l.includes("alpha up")) && lines.some((l) => l.includes("beta-long up")));
    expect(lines.find((l) => l.includes("alpha up"))).toMatch(/^\[alpha {4}\] alpha up/);
    expect(lines.find((l) => l.includes("beta-long up"))).toMatch(/^\[beta-long\] beta-long up/);
    stop.emit("stop");
    await done;
  });

  it("stops only the processes it started: an unrelated process running at the same time survives", async () => {
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const { out } = sink();
    const stop = new EventEmitter();
    let pids: Record<string, number> = {};
    const done = runServices([sleeper("one"), sleeper("two")], { out, stopSignal: stop, graceMs: 2000, onStarted: (p) => (pids = p) });
    await until(() => Object.keys(pids).length === 2);
    expect(Object.values(pids).every(alive)).toBe(true);
    stop.emit("stop");
    const code = await done;
    expect(code).toBe(130);
    await until(() => !alive(pids.one!) && !alive(pids.two!));
    expect(alive(bystander.pid!)).toBe(true); // untouched
    bystander.kill();
  });

  it("propagates a failing service's exit code and stops the others", async () => {
    const { lines, out } = sink();
    let pids: Record<string, number> = {};
    const code = await runServices([sleeper("steady"), { name: "crasher", command: process.execPath, args: ["-e", "setTimeout(() => process.exit(7), 200)"] }], {
      out,
      graceMs: 2000,
      signals: [],
      onStarted: (p) => (pids = p),
    });
    expect(code).toBe(7);
    expect(lines.join("")).toMatch(/crasher exited unexpectedly \(code 7\)/);
    await until(() => !alive(pids.steady!));
  });

  it("reports a command that cannot start and stops the rest, without hanging", async () => {
    const { lines, out } = sink();
    const code = await runServices([sleeper("fine"), { name: "missing", command: "definitely-not-a-command-xyz", args: [] }], { out, graceMs: 2000, signals: [] });
    expect(code).not.toBe(0);
    expect(lines.join("")).toMatch(/could not start missing/);
  });

  it("buffers partial lines and flushes the last one", () => {
    const got: string[] = [];
    const p = prefixer("svc", 3, null, (s) => got.push(s));
    p.push("hel");
    p.push("lo\nwor");
    p.push("ld");
    p.flush();
    expect(got).toEqual(["[svc] hello\n", "[svc] world\n"]);
  });
});

describe("the probes behind npm run services:status", () => {
  it("fetchJson tells a reply, a refused connection and a timeout apart", async () => {
    const server = createHttp((req, res) => {
      if (req.url === "/slow") return; // never answers
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ ok: false }));
    }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    expect(await fetchJson(`http://127.0.0.1:${port}/x`)).toEqual({ ok: true, status: 503, body: { ok: false } });
    expect(await fetchJson(`http://127.0.0.1:${port}/slow`, 150)).toEqual({ ok: false, reason: "timeout" });
    server.closeAllConnections();
    server.close();
    // a port nothing listens on (a fresh one, so no kept-alive connection from above is reused)
    const probeServer = createTcp().listen(0, "127.0.0.1");
    await new Promise((r) => probeServer.once("listening", r));
    const free = (probeServer.address() as { port: number }).port;
    probeServer.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await fetchJson(`http://127.0.0.1:${free}/x`)).toEqual({ ok: false, reason: "refused" });
  });

  it("redisPing reads one PING reply: up, auth required, unexpected, or unreachable; and tcpProbe agrees", async () => {
    const reply = (text: string) =>
      new Promise<{ port: number; close(): void }>((resolve) => {
        const s = createTcp((sock) => sock.once("data", () => sock.end(text))).listen(0, "127.0.0.1", () => resolve({ port: (s.address() as { port: number }).port, close: () => s.close() }));
      });
    const up = await reply("+PONG\r\n");
    expect(await redisPing("127.0.0.1", up.port)).toBe("up");
    expect(await tcpProbe("127.0.0.1", up.port)).toBe(true);
    up.close();
    const auth = await reply("-NOAUTH Authentication required.\r\n");
    expect(await redisPing("127.0.0.1", auth.port)).toBe("auth-required");
    auth.close();
    const odd = await reply("HTTP/1.1 400 Bad Request\r\n");
    expect(await redisPing("127.0.0.1", odd.port)).toBe("unexpected-reply");
    odd.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await redisPing("127.0.0.1", up.port, 300)).toBe("unreachable");
    expect(await tcpProbe("127.0.0.1", up.port, 300)).toBe(false);
  });

  it("hostPort and firstNode return a host and port, never a credential", () => {
    expect(hostPort("postgres://user:s3cret@localhost:5433/medlink", 5432)).toEqual({ host: "127.0.0.1", port: 5433 });
    expect(JSON.stringify(hostPort("redis://:hunter2@cache.internal/0", 6379))).not.toMatch(/hunter2/);
    expect(hostPort("not a url", 1)).toBeNull();
    expect(hostPort(undefined, 1)).toBeNull();
    expect(firstNode("localhost:7001,localhost:7002")).toEqual({ host: "127.0.0.1", port: 7001 });
    expect(firstNode("nonsense")).toBeNull();
  });
});

describe("turning a health report into a status", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    service: "notification-service",
    status: "ok",
    ready: true,
    dependencies: { redis: "up", postgres: "up" },
    details: { emailDelivery: "disabled", emailProblems: [], pendingNotifications: 2, streams: 5 },
    hints: [],
    ...over,
  });

  it("is healthy only when the service says it is ready, and shows the email mode and what is waiting", () => {
    const s = fromHealthReport("Notification service", 200, report());
    expect(s.state).toBe("healthy");
    expect(s.notes.join("\n")).toMatch(/email delivery: disabled/);
    expect(s.notes.join("\n")).toMatch(/notifications waiting to be sent: 2/);
  });

  it("is degraded, with the hint, when a dependency is down: the process answering is not enough", () => {
    const s = fromHealthReport("Inventory connector", 503, report({ status: "degraded", ready: false, dependencies: { redis: "down" }, hints: ["Redis is not reachable"] }));
    expect(s.state).toBe("degraded");
    expect(s.notes.join("\n")).toMatch(/hint: Redis is not reachable/);
  });

  it("says when email is enabled but unconfigured, by setting name only", () => {
    const s = fromHealthReport("Notification service", 200, report({ details: { emailDelivery: "unconfigured", emailProblems: ["SMTP_PASS is not set"] } }));
    expect(s.notes.join("\n")).toMatch(/email delivery: unconfigured \(SMTP_PASS is not set\)/);
  });

  it("counts events still waiting in the pharmacy outboxes (the unpublished-event symptom)", () => {
    const s = fromHealthReport("Inventory connector", 200, report({ details: { unpublishedOutbox: { P001: 0, P004: 3, P005: null } } }));
    expect(s.notes.join("\n")).toMatch(/events waiting in pharmacy outboxes: 3/);
  });

  it("exits non-zero when something needed is missing, failing or unreachable; 'running' and 'unknown' are not failures but never 'healthy'", () => {
    const row = (state: ComponentStatus["state"]): ComponentStatus => ({ name: "x", state, notes: [] });
    expect(exitCodeFor([row("healthy"), row("running"), row("unknown")])).toBe(0);
    for (const bad of ["not running", "unreachable", "degraded"] as const) expect(exitCodeFor([row("healthy"), row(bad)])).toBe(1);
    expect(formatStatus([row("unknown")])).toContain("unknown");
  });
});
