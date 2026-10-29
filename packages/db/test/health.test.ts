import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { buildReport, healthPortFor, probe, startHealthServer, withTimeout, type HealthServer } from "../src/health.js";

const open: HealthServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});
const serve = async (check: Parameters<typeof startHealthServer>[0]["check"]) => {
  const s = (await startHealthServer({ service: "demo", port: 0, check }))!;
  open.push(s);
  return s;
};
const get = async (port: number, path = "/health") => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { uptimeSec?: number; hints: string[] } };
};

describe("the health endpoint of a background service", () => {
  it("is 200 and ready when every dependency answered, and says what it checked", async () => {
    const s = await serve(async () => ({ dependencies: { redis: "up", postgres: "up" }, details: { streams: 5 } }));
    const { status, body } = await get(s.port);
    expect(status).toBe(200);
    expect(body).toMatchObject({ service: "demo", status: "ok", ready: true, dependencies: { redis: "up", postgres: "up" }, details: { streams: 5 } });
    expect(typeof body.uptimeSec).toBe("number");
  });

  it("is 503 and degraded, with an actionable hint, when a dependency is down: a live process is not a healthy service", async () => {
    const s = await serve(async () => ({ dependencies: { redis: "down", postgres: "up" } }));
    const { status, body } = await get(s.port);
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "degraded", ready: false });
    expect(body.hints.join(" ")).toMatch(/Redis is not reachable.*infra:up/);
  });

  it("a check that hangs or throws is reported as not ready, not as a hung request", async () => {
    const slow = await buildReport("demo", Date.now(), () => new Promise(() => undefined), 50);
    expect(slow).toMatchObject({ ready: false, status: "degraded" });
    expect(slow.hints[0]).toMatch(/health check itself failed/);
    const bad = await buildReport("demo", Date.now(), async () => {
      throw new Error("boom");
    });
    expect(bad.ready).toBe(false);
  });

  it("probe turns a slow or failing dependency into 'down' within its bound, and never throws", async () => {
    expect(await probe(async () => 1)).toBe("up");
    expect(await probe(async () => Promise.reject(new Error("x")))).toBe("down");
    const t0 = Date.now();
    expect(await probe(() => new Promise(() => undefined), 60)).toBe("down");
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(withTimeout(new Promise(() => undefined), 20)).rejects.toThrow(/timed out/);
  });

  it("serves only GET /health, only on localhost, and contains no secrets or connection strings", async () => {
    const s = await serve(async () => ({ dependencies: { redis: "up" }, details: { emailDelivery: "enabled" } }));
    expect((await get(s.port, "/other")).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${s.port}/health`, { method: "POST" })).status).toBe(404);
    expect(JSON.stringify((await get(s.port)).body)).not.toMatch(/postgres:\/\/|redis:\/\/|password|SMTP_PASS|@/i);
  });

  it("when its port is taken it does not stop the service: it reports the problem and returns null", async () => {
    const blocker = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    const port = (blocker.address() as { port: number }).port;
    const problems: string[] = [];
    const s = await startHealthServer({ service: "demo", port, check: async () => ({ dependencies: {} }), onProblem: (m) => problems.push(m) });
    expect(s).toBeNull();
    expect(problems[0]).toMatch(/already in use.*HEALTH_PORT/);
    blocker.close();
  });

  it("has one port and one override variable per service, and 'off' disables it", () => {
    expect(healthPortFor("inventory-connector", {})).toBe(4301);
    expect(healthPortFor("inventory-sync", {})).toBe(4302);
    expect(healthPortFor("notification-service", {})).toBe(4303);
    expect(healthPortFor("notification-service", { HEALTH_PORT_NOTIFY: "5555" })).toBe(5555);
    expect(healthPortFor("notification-service", { HEALTH_PORT_NOTIFY: "off" })).toBeNull();
    expect(healthPortFor("inventory-sync", { HEALTH_PORT_NOTIFY: "off" })).toBe(4302); // each service has its own variable
    expect(healthPortFor("inventory-sync", { HEALTH_PORT_SYNC: "nonsense" })).toBe(4302);
  });
});
