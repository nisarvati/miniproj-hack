import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReport, healthHostFor, heartbeatEnabled, heartbeatIntervalMs, startHeartbeat, type HealthCheck, type HeartbeatRecord, type HeartbeatStore } from "../src/health.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakeStore(over: Partial<Record<keyof HeartbeatStore, () => Promise<unknown>>> = {}) {
  const fields = new Map<string, string>();
  const expires: [string, number][] = [];
  const store: HeartbeatStore = {
    hset: over.hset ?? (async (_key: string, field: string, value: string) => void fields.set(field, value)),
    hdel: over.hdel ?? (async (_key: string, ...f: string[]) => void f.forEach((x) => fields.delete(x))),
    expire: over.expire ?? (async (key: string, s: number) => void expires.push([key, s])),
  } as HeartbeatStore;
  return { store, fields, expires };
}
const ok: HealthCheck = async () => ({ dependencies: { redis: "up", postgres: "up" }, details: { processed: 3 } });
const record = (raw: string | undefined) => JSON.parse(raw!) as HeartbeatRecord;

describe("startHeartbeat", () => {
  it("writes the health report with the time, as its own instance's field, at once and then every interval, and keeps the key from living forever", async () => {
    vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
    const { store, fields, expires } = fakeStore();
    const hb = startHeartbeat({ service: "inventory-sync", instance: "sync-1", key: "k", store, check: ok, intervalMs: 5000, ttlSeconds: 300 });
    await vi.advanceTimersByTimeAsync(10);
    const first = record(fields.get("sync-1"));
    expect(first).toMatchObject({ v: 1, instance: "sync-1", at: Date.parse("2026-10-30T10:00:00Z"), report: { service: "inventory-sync", ready: true, status: "ok", details: { processed: 3 } } });
    expect(expires[0]).toEqual(["k", 300]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(record(fields.get("sync-1")).at).toBeGreaterThan(first.at);
    expect([...fields.keys()]).toEqual(["sync-1"]); // only its own field
    await hb.stop();
  });

  it("carries a degraded report as it is: unhealthy is not the same as silent", async () => {
    const { store, fields } = fakeStore();
    const bad: HealthCheck = async () => ({ dependencies: { redis: "up", postgres: "down" } });
    const hb = startHeartbeat({ service: "inventory-sync", instance: "a", key: "k", store, check: bad });
    await vi.advanceTimersByTimeAsync(10);
    expect(record(fields.get("a")).report).toMatchObject({ ready: false, status: "degraded", dependencies: { postgres: "down" } });
    await hb.stop();
  });

  it("never throws or stalls when Redis fails or hangs, reports the first failure once and the recovery once, and carries on", async () => {
    const problems: string[] = [];
    let mode: "fail" | "hang" | "ok" = "fail";
    const { store, fields } = fakeStore({
      hset: async () => {
        if (mode === "fail") throw new Error("connection refused");
        if (mode === "hang") return new Promise(() => undefined);
      },
    });
    const hb = startHeartbeat({ service: "inventory-connector", instance: "c", key: "k", store, check: ok, intervalMs: 1000, writeTimeoutMs: 500, onProblem: (m) => problems.push(m) });
    await vi.advanceTimersByTimeAsync(3500); // three failed beats
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/could not be written.*connection refused.*stale/);
    mode = "hang";
    await vi.advanceTimersByTimeAsync(3500); // a hung write times out instead of piling up
    expect(problems).toHaveLength(1);
    mode = "ok";
    await vi.advanceTimersByTimeAsync(3500);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toMatch(/recovered/);
    expect(fields.size).toBe(0); // the fake `hset` above never stored anything: the point is that nothing threw
    await hb.stop();
  });

  it("does not start a beat while the last is still running", async () => {
    let calls = 0;
    const slow: HealthCheck = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 2500));
      return { dependencies: { redis: "up" } };
    };
    const { store } = fakeStore();
    const hb = startHeartbeat({ service: "x", instance: "i", key: "k", store, check: slow, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(2400);
    expect(calls).toBe(1);
    await hb.stop();
  });

  it("removes its record on a clean stop, so a restart is not read as a crash, and stops beating", async () => {
    const { store, fields } = fakeStore();
    const hb = startHeartbeat({ service: "x", instance: "i", key: "k", store, check: ok, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(fields.has("i")).toBe(true);
    await hb.stop();
    expect(fields.has("i")).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fields.has("i")).toBe(false);
  });

  it("survives a store that fails on stop", async () => {
    const { store } = fakeStore({ hdel: async () => { throw new Error("gone"); } });
    const hb = startHeartbeat({ service: "x", instance: "i", key: "k", store, check: ok });
    await vi.advanceTimersByTimeAsync(10);
    await expect(hb.stop()).resolves.toBeUndefined();
  });

  it("keeps a failing health check from being a failed beat: it reports not ready instead", async () => {
    const { store, fields } = fakeStore();
    const broken: HealthCheck = async () => { throw new Error("probe exploded"); };
    const hb = startHeartbeat({ service: "x", instance: "i", key: "k", store, check: broken });
    await vi.advanceTimersByTimeAsync(10);
    expect(record(fields.get("i")).report).toMatchObject({ ready: false });
    await hb.stop();
  });
});

describe("settings", () => {
  it("heartbeats are opt-in", () => {
    for (const v of [undefined, "", "off", "false", "0", "no"]) expect(heartbeatEnabled({ WORKER_HEARTBEAT: v })).toBe(false);
    for (const v of ["redis", "on", "true", "1", "ON", " redis "]) expect(heartbeatEnabled({ WORKER_HEARTBEAT: v })).toBe(true);
  });
  it("the interval is bounded, so a typo cannot flood Redis or hide a dead worker", () => {
    expect(heartbeatIntervalMs({})).toBe(10_000);
    expect(heartbeatIntervalMs({ WORKER_HEARTBEAT_INTERVAL_MS: "5000" })).toBe(5000);
    for (const v of ["0", "10", "-5", "abc", "999999999"]) expect(heartbeatIntervalMs({ WORKER_HEARTBEAT_INTERVAL_MS: v })).toBe(10_000);
  });
  it("the health endpoint stays on this machine unless told otherwise", () => {
    expect(healthHostFor({})).toBe("127.0.0.1");
    expect(healthHostFor({ HEALTH_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(healthHostFor({ HEALTH_HOST: "  " })).toBe("127.0.0.1");
  });
  it("buildReport is unchanged: still the report a heartbeat carries", async () => {
    const r = await buildReport("s", Date.now() - 5000, ok);
    expect(r).toMatchObject({ service: "s", ready: true, dependencies: { redis: "up" } });
  });
});
