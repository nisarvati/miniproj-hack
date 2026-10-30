/**
 * Worker health from Redis heartbeats: healthy, unhealthy, stale and unreachable stay four different things, and a stale or missing heartbeat is never
 * turned into evidence (no remembered backlog, no "healthy").
 */
import { afterEach, describe, expect, it } from "vitest";
import { startHeartbeat, type HealthCheck } from "@medlink/db";
import { workerHealthKey } from "@medlink/event-schema";
import { createRedis, deleteAll, scanKeys, type Redis } from "@medlink/redis";
import { HeartbeatConnectorHealth, HeartbeatSyncServiceHealth, RedisWorkerHealth, classifyHeartbeats } from "../src/modules/nodes/heartbeat-health.js";
import { workerHealthFromEnv } from "../src/modules/nodes/health-config.js";
import { getNodes } from "../src/modules/nodes/service.js";
import type { SyncStatusSource } from "../src/modules/nodes/sync-status.js";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const beat = (ageMs: number, report: Record<string, unknown> = { ready: true }, extra: Record<string, unknown> = {}) => JSON.stringify({ v: 1, at: NOW - ageMs, startedAt: NOW - 100_000, instance: "i", report: { service: "x", status: "ok", ready: true, uptimeSec: 1, dependencies: {}, details: {}, hints: [], ...report }, ...extra });

describe("classifyHeartbeats", () => {
  it("healthy: a recent heartbeat that says ready", () => {
    expect(classifyHeartbeats({ a: beat(3000) }, NOW)).toMatchObject({ state: "healthy", ageMs: 3000, instances: 1 });
  });
  it("unhealthy: a recent heartbeat that says it is not ready (alive, and saying what is wrong)", () => {
    const r = classifyHeartbeats({ a: beat(3000, { ready: false, status: "degraded", dependencies: { postgres: "down" } }) }, NOW);
    expect(r.state).toBe("unhealthy");
    expect((r.report as { dependencies: unknown }).dependencies).toEqual({ postgres: "down" });
  });
  it("stale: heartbeats exist, but the newest is too old to say anything about now", () => {
    const r = classifyHeartbeats({ a: beat(40_000) }, NOW, { staleAfterMs: 35_000 });
    expect(r).toEqual({ state: "stale", ageMs: 40_000, instances: 0, report: null }); // the old report is NOT handed on as evidence
    expect(classifyHeartbeats({ a: beat(34_000) }, NOW, { staleAfterMs: 35_000 }).state).toBe("healthy"); // just inside
  });
  it("unreachable: nothing at all, or nothing that can be read", () => {
    expect(classifyHeartbeats(null, NOW).state).toBe("unreachable");
    expect(classifyHeartbeats({}, NOW).state).toBe("unreachable");
    expect(classifyHeartbeats({ a: "not json", b: "{}", c: JSON.stringify({ v: 2, at: NOW, report: {} }), d: JSON.stringify({ v: 1, at: "yesterday", report: {} }), e: JSON.stringify({ v: 1, at: NOW, report: null }) }, NOW).state).toBe("unreachable");
  });
  it("forgets a worker that went away long ago (a previous deploy's leftover) instead of calling the service stale for ever", () => {
    expect(classifyHeartbeats({ old: beat(20 * 60_000) }, NOW, { forgetAfterMs: 10 * 60_000 }).state).toBe("unreachable");
  });
  it("uses the newest instance, so an old one left behind by a deploy does not hide a healthy new one or make a healthy service look stale", () => {
    const r = classifyHeartbeats({ old: beat(120_000), fresh: beat(2000) }, NOW);
    expect(r).toMatchObject({ state: "healthy", ageMs: 2000, instances: 1 });
  });
  it("with several fresh instances it is healthy if any is ready, and unhealthy only if none is", () => {
    expect(classifyHeartbeats({ a: beat(1000, { ready: false }), b: beat(5000, { ready: true }) }, NOW)).toMatchObject({ state: "healthy", instances: 2 });
    expect(classifyHeartbeats({ a: beat(1000, { ready: false }), b: beat(5000, { ready: false }) }, NOW).state).toBe("unhealthy");
  });
  it("does not trust a timestamp from the future as proof of life (a broken clock), but tolerates small skew", () => {
    expect(classifyHeartbeats({ a: beat(-3_600_000) }, NOW).state).toBe("unreachable");
    expect(classifyHeartbeats({ a: beat(-5000) }, NOW)).toMatchObject({ state: "healthy", ageMs: 0 });
  });
});

describe("RedisWorkerHealth", () => {
  it("reads the service's key by its convention and the configured prefix", async () => {
    const asked: string[] = [];
    const w = new RedisWorkerHealth({ hgetall: async (k) => (asked.push(k), { a: beat(1000) }) }, { keyPrefix: "demo", now: () => NOW });
    expect((await w.read("inventory-sync")).state).toBe("healthy");
    expect(asked).toEqual(["demo:health:inventory-sync"]);
  });
  it("never throws: Redis failing, or hanging, is unreachable (no evidence)", async () => {
    const down = new RedisWorkerHealth({ hgetall: async () => { throw new Error("ECONNREFUSED"); } });
    expect((await down.read("x")).state).toBe("unreachable");
    const hung = new RedisWorkerHealth({ hgetall: () => new Promise(() => undefined) }, { timeoutMs: 50 });
    expect((await hung.read("x")).state).toBe("unreachable");
  });
});

describe("adapters to the node-status contract", () => {
  const reader = (fields: Record<string, string> | Error) => new RedisWorkerHealth({ hgetall: async () => { if (fields instanceof Error) throw fields; return fields; } }, { now: () => NOW });
  const connectorReport = { ready: true, dependencies: { redis: "up", "postgres:P001": "up", "postgres:P002": "down" }, details: { unpublishedOutbox: { P001: 4, P002: null }, pollingFailing: ["P002"] } };

  it("the connector's heartbeat gives the same per-pharmacy evidence its /health endpoint did", async () => {
    const r = await new HeartbeatConnectorHealth(reader({ a: beat(1000, connectorReport) })).read();
    expect(r.reachable).toBe(true);
    if (!r.reachable) return;
    expect(r.pharmacies.get("P001")).toEqual({ databaseUp: true, unpublishedOutbox: 4, pollingFailing: false });
    expect(r.pharmacies.get("P002")).toEqual({ databaseUp: false, unpublishedOutbox: null, pollingFailing: true });
  });
  it("a stale connector heartbeat gives no pharmacy evidence at all, and says stale", async () => {
    expect(await new HeartbeatConnectorHealth(reader({ a: beat(90_000, connectorReport) })).read()).toEqual({ reachable: false, stale: true });
  });
  it("a missing or unreadable connector heartbeat is unreachable, not stale", async () => {
    expect(await new HeartbeatConnectorHealth(reader({})).read()).toEqual({ reachable: false });
    expect(await new HeartbeatConnectorHealth(reader(new Error("down"))).read()).toEqual({ reachable: false });
  });
  it("the sync service maps healthy, unhealthy, stale and unreachable to ready, not-ready, stale and unreachable", async () => {
    const sync = (f: Record<string, string> | Error) => new HeartbeatSyncServiceHealth(reader(f)).read();
    expect(await sync({ a: beat(1000) })).toBe("ready");
    expect(await sync({ a: beat(1000, { ready: false }) })).toBe("not-ready");
    expect(await sync({ a: beat(90_000) })).toBe("stale");
    expect(await sync({})).toBe("unreachable");
    expect(await sync(new Error("x"))).toBe("unreachable");
  });
});

describe("node status with heartbeat evidence", () => {
  const syncStatus: SyncStatusSource = {
    read: async () => ({
      redis: "up",
      nodes: new Map([["P001", { record: { lastSyncedAt: new Date(NOW - 60_000).toISOString(), processedCount: 5, duplicateCount: 0, staleCount: 0 }, backlog: 0 }]]),
    }) as never,
  };
  const nodes = async (syncService?: HeartbeatSyncServiceHealth, connector?: HeartbeatConnectorHealth) =>
    getNodes({ sync: syncStatus, syncService, connector, pharmacies: () => [{ code: "P001", name: "A" }], now: () => NOW });
  const reader = (fields: Record<string, string>) => new RedisWorkerHealth({ hgetall: async () => fields }, { now: () => NOW });

  it("healthy only while the sync service's heartbeat is fresh and ready", async () => {
    const r = await nodes(new HeartbeatSyncServiceHealth(reader({ a: beat(2000) })));
    expect(r.data[0]).toMatchObject({ status: "healthy" });
    expect(r.meta.syncService).toBe("ready");
  });
  it("a stale sync-service heartbeat makes a quiet node unknown, with the reason, and says stale in the response", async () => {
    const r = await nodes(new HeartbeatSyncServiceHealth(reader({ a: beat(120_000) })));
    expect(r.data[0]).toMatchObject({ status: "unknown", statusReason: expect.stringMatching(/last heartbeat is too old/) });
    expect(r.meta.syncService).toBe("stale");
  });
  it("an unhealthy sync service degrades a quiet node; a missing heartbeat leaves it unknown", async () => {
    expect((await nodes(new HeartbeatSyncServiceHealth(reader({ a: beat(1000, { ready: false }) })))).data[0]!.status).toBe("degraded");
    const r = await nodes(new HeartbeatSyncServiceHealth(reader({})));
    expect(r.data[0]!.status).toBe("unknown");
    expect(r.meta.syncService).toBe("unreachable");
  });
  it("a stale connector shows no backlog and reports itself stale, leaving the rest of the reading alone", async () => {
    const r = await nodes(new HeartbeatSyncServiceHealth(reader({ a: beat(2000) })), new HeartbeatConnectorHealth(reader({ a: beat(120_000, { details: { unpublishedOutbox: { P001: 9 } } }) })));
    expect(r.meta.connector).toBe("stale");
    expect(r.data[0]!.unpublishedOutbox).toBeNull();
    expect(r.data[0]!.status).toBe("healthy");
  });
  it("a fresh connector heartbeat supplies the backlog and a database that is down", async () => {
    const r = await nodes(undefined, new HeartbeatConnectorHealth(reader({ a: beat(1000, { dependencies: { "postgres:P001": "down" }, details: { unpublishedOutbox: { P001: 3 } } }) })));
    expect(r.meta.connector).toBe("up");
    expect(r.data[0]).toMatchObject({ unpublishedOutbox: 3, status: "down" });
  });
});

describe("choosing where worker health comes from", () => {
  const fakeRedis = { hgetall: async () => ({}) };
  it("keeps the local behaviour by default: each worker's /health on this machine", () => {
    const w = workerHealthFromEnv({}, undefined);
    expect(w.mode).toBe("http");
    expect(w.connector).toBeDefined();
    expect(w.syncService).toBeDefined();
  });
  it("an off port leaves that worker unchecked", () => {
    const w = workerHealthFromEnv({ HEALTH_PORT_CONNECTOR: "off", HEALTH_PORT_SYNC: "off" }, undefined);
    expect(w.connector).toBeUndefined();
    expect(w.syncService).toBeUndefined();
  });
  it("redis mode reads heartbeats, and needs a Redis connection", () => {
    const w = workerHealthFromEnv({ WORKER_HEALTH: "redis" }, fakeRedis);
    expect(w.mode).toBe("redis");
    expect(w.connector).toBeInstanceOf(HeartbeatConnectorHealth);
    expect(w.syncService).toBeInstanceOf(HeartbeatSyncServiceHealth);
    const none = workerHealthFromEnv({ WORKER_HEALTH: "redis" }, undefined);
    expect(none).toMatchObject({ mode: "off" });
    expect(none.note).toMatch(/no Redis connection/);
  });
  it("off checks nothing", () => {
    const w = workerHealthFromEnv({ WORKER_HEALTH: "off" }, fakeRedis);
    expect(w.mode).toBe("off");
    expect(w.connector).toBeUndefined();
    expect(w.syncService).toBeUndefined();
  });
  it("accepts private-network URLs, and refuses anything that is not a plain http(s) URL, or that carries credentials", () => {
    expect(workerHealthFromEnv({ WORKER_HEALTH_URL_SYNC: "http://sync:10000/health" }, undefined).note).toMatch(/configured health URLs/);
    for (const bad of ["not a url", "ftp://x/health", "javascript:alert(1)", "http://user:pw@host/health"]) {
      expect(() => workerHealthFromEnv({ WORKER_HEALTH_URL_CONNECTOR: bad }, undefined), bad).toThrow(/WORKER_HEALTH_URL_CONNECTOR/);
    }
  });
  it("refuses an unknown mode instead of guessing", () => {
    expect(() => workerHealthFromEnv({ WORKER_HEALTH: "magic" }, undefined)).toThrow(/WORKER_HEALTH must be/);
  });
});

describe("a real heartbeat through real Redis", () => {
  let redis: Redis | undefined;
  const prefix = `test${Math.random().toString(36).slice(2, 10)}`;
  afterEach(async () => {
    if (redis) {
      await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
      redis.disconnect();
    }
  });

  it("a worker's heartbeat is read back as healthy, becomes stale when it stops beating, and disappears when it stops cleanly", async () => {
    redis = createRedis({ url: process.env.REDIS_URL ?? "redis://localhost:6379", name: "heartbeat-test", failFast: true });
    const check: HealthCheck = async () => ({ dependencies: { redis: "up" }, details: { n: 1 } });
    const key = workerHealthKey("inventory-sync", prefix);
    const hb = startHeartbeat({ service: "inventory-sync", instance: "t1", key, store: redis, check, intervalMs: 1000 });
    const health = new HeartbeatSyncServiceHealth(new RedisWorkerHealth(redis, { keyPrefix: prefix, staleAfterMs: 1500 }));
    await new Promise((r) => setTimeout(r, 300));
    expect(await health.read()).toBe("ready");
    expect(await redis.ttl(key)).toBeGreaterThan(0); // the key cannot outlive its workers for ever
    await hb.stop();
    expect(await health.read()).toBe("unreachable"); // a clean stop removes the record
    // a worker that dies without stopping leaves its last heartbeat behind: it goes stale
    await redis.hset(key, "dead", JSON.stringify({ v: 1, at: Date.now() - 5000, startedAt: 0, instance: "dead", report: { ready: true } }));
    expect(await health.read()).toBe("stale");
  });
});
