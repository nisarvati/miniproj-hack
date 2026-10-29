import { spawn, type ChildProcess } from "node:child_process";

/**
 * Runs a set of services side by side: each in its own process group, its output prefixed with its name, and all of them stopped
 * together. It only ever signals the process groups IT created, so nothing that was already running, and nothing else on the
 * machine, can be affected by starting or stopping it.
 */
export interface ServiceSpec {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RunOptions {
  out?: { write(chunk: string): unknown };
  /** How long to wait after SIGTERM before SIGKILL, for the groups this run started. */
  graceMs?: number;
  /** Called once all services are started (a process exists; this says nothing about their health). */
  onStarted?: (pids: Record<string, number>) => void;
  /** Resolves a stop request (Ctrl+C) to a shutdown. Defaults to listening for SIGINT and SIGTERM. */
  stopSignal?: { once(event: "stop", cb: () => void): unknown };
  signals?: NodeJS.Signals[];
}

const COLORS = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m", "\x1b[34m", "\x1b[31m"];
const RESET = "\x1b[0m";

export function prefixer(name: string, width: number, color: string | null, write: (s: string) => unknown) {
  let buffer = "";
  const tag = color ? `${color}[${name.padEnd(width)}]${RESET}` : `[${name.padEnd(width)}]`;
  return {
    push(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const l of lines) write(`${tag} ${l}\n`);
    },
    flush() {
      if (buffer) write(`${tag} ${buffer}\n`);
      buffer = "";
    },
  };
}

/** Resolves with the exit code: the first failing service's code, 130/143 after Ctrl+C/SIGTERM, 0 if all exited cleanly. */
export function runServices(specs: ServiceSpec[], options: RunOptions = {}): Promise<number> {
  const write = (s: string) => (options.out ?? process.stdout).write(s);
  const graceMs = options.graceMs ?? 8000;
  const width = Math.max(0, ...specs.map((s) => s.name.length));
  const tty = (options.out ?? process.stdout) === process.stdout && process.stdout.isTTY;
  const children = new Map<string, ChildProcess>();
  let stopping = false;
  let exitCode: number | null = null;
  let resolveDone: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  const alive = new Set<string>();

  const killGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal); // the group this run created for that service, and only that group
    } catch {
      /* already gone */
    }
  };

  const shutdown = (code: number, why: string) => {
    if (exitCode === null) exitCode = code;
    if (stopping) return;
    stopping = true;
    write(`\n[dev] ${why}; stopping the ${alive.size} service${alive.size === 1 ? "" : "s"} this command started (nothing else is touched)\n`);
    for (const name of alive) killGroup(children.get(name)!, "SIGTERM");
    const timer = setTimeout(() => {
      for (const name of alive) {
        write(`[dev] ${name} did not stop in ${graceMs / 1000}s; sending SIGKILL to its own process group\n`);
        killGroup(children.get(name)!, "SIGKILL");
      }
    }, graceMs);
    timer.unref();
  };

  const onSignal = (sig: NodeJS.Signals) => () => shutdown(sig === "SIGINT" ? 130 : 143, `received ${sig}`);
  const handlers = (options.signals ?? ["SIGINT", "SIGTERM"]).map((sig) => [sig, onSignal(sig)] as const);
  if (!options.stopSignal) for (const [sig, h] of handlers) process.on(sig, h);
  options.stopSignal?.once("stop", () => shutdown(130, "stop requested"));

  const pids: Record<string, number> = {};
  specs.forEach((spec, i) => {
    const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.set(spec.name, child);
    alive.add(spec.name);
    if (child.pid) pids[spec.name] = child.pid;
    const color = tty ? COLORS[i % COLORS.length]! : null;
    const out = prefixer(spec.name, width, color, write);
    const err = prefixer(spec.name, width, color, write);
    child.stdout?.setEncoding("utf8").on("data", (c: string) => out.push(c));
    child.stderr?.setEncoding("utf8").on("data", (c: string) => err.push(c));
    child.once("error", (e) => {
      write(`[dev] could not start ${spec.name}: ${e.message}\n`);
      alive.delete(spec.name);
      shutdown(1, `${spec.name} failed to start`);
      if (alive.size === 0) resolveDone(exitCode ?? 1);
    });
    child.once("exit", (code, signal) => {
      out.flush();
      err.flush();
      alive.delete(spec.name);
      if (!stopping) {
        write(`[dev] ${spec.name} exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})\n`);
        shutdown(code && code !== 0 ? code : 1, `${spec.name} stopped`);
      }
      if (alive.size === 0) {
        for (const [sig, h] of handlers) process.off(sig, h);
        resolveDone(exitCode ?? 0);
      }
    });
  });
  options.onStarted?.(pids);
  return done;
}
