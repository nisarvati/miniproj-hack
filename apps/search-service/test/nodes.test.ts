import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@medlink/db";
import { eventStreamKey, syncStatusKey } from "@medlink/event-schema";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseServiceReport, type SyncServiceState } from "../src/modules/nodes/service-health.js";
import { parseConnectorReport, type ConnectorHealthSource, type ConnectorReading } from "../src/modules/nodes/connector-health.js";
import { lagMs, registryPharmacies, THRESHOLDS, type NodesResponse } from "../src/modules/nodes/service.js";
import { parseSyncRecord, RedisSyncStatus, type NodeReading, type SyncReading, type SyncStatusSource } from "../src/modules/nodes/sync-status.js";

const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
/** Proves the endpoint never touches a database: any query fails the test. */
const noDb = { query: () => { throw new Error("GET /api/nodes must not query a database"); } } as unknown as Db;

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const PHARMACIES = [
  { code: "P001", name: "Alpha Chemist" },
  { code: "P002", name: "Beta Chemist" },
  { code: "P003", name: "Gamma Chemist" },
];

const record = (over: Partial<NodeReading["record"] & object> = {}): NodeReading["record"] => ({ lastSyncedAt: ago(2_000), processedCount: 42, duplicateCount: 3, staleCount: 1, ...over });
const reading = (over: Partial<NodeReading> = {}): NodeReading => ({ record: record(), backlog: 0, ...over });
const sync = (nodes: Record<string, NodeReading>): SyncStatusSource => ({ read: async (): Promise<SyncReading> => ({ redis: "up", nodes: new Map(Object.entries(nodes)) }) });
const connector = (pharmacies: Record<string, { databaseUp?: boolean | null; unpublishedOutbox?: number | null; pollingFailing?: boolean }>): ConnectorHealthSource => ({
  read: async (): Promise<ConnectorReading> => ({
    reachable: true,
    pharmacies: new Map(Object.entries(pharmacies).map(([c, v]) => [c, { databaseUp: v.databaseUp ?? true, unpublishedOutbox: "unpublishedOutbox" in v ? (v.unpublishedOutbox ?? null) : 0, pollingFailing: v.pollingFailing ?? false }])),
  }),
});

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function nodes(sources: Parameters<typeof buildApp>[2] extends infer O ? NonNullable<O extends { nodes?: infer N } ? N : never> : never): Promise<{ status: number; body: NodesResponse }> {
  const app = await buildApp(noDb, config, { logger: false, nodes: { pharmacies: () => PHARMACIES, now: () => NOW, ...sources } });
  apps.push(app);
  const res = await app.inject({ method: "GET", url: "/api/nodes" });
  return { status: res.statusCode, body: res.json() };
}
const entry = (r: { body: NodesResponse }, code: string) => r.body.data.find((n) => n.pharmacyCode === code)!;

describe("GET /api/nodes", () => {
  it("returns one entry per configured pharmacy, with real values from the sync status", async () => {
    const r = await nodes({
      sync: sync({
        P001: reading({ record: record({ lastSyncedAt: ago(1_200), processedCount: 42, duplicateCount: 3, staleCount: 0 }) }),
        P002: reading({ record: record({ lastSyncedAt: ago(60_000), processedCount: 7, duplicateCount: 0, staleCount: 2 }) }),
        P003: reading(),
      }),
      connector: connector({ P001: { unpublishedOutbox: 0 }, P002: { unpublishedOutbox: 4 }, P003: { unpublishedOutbox: 0 } }),
      syncService: { read: async () => "ready" },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.map((n) => [n.pharmacyCode, n.name])).toEqual(PHARMACIES.map((p) => [p.code, p.name]));
    expect(entry(r, "P001")).toMatchObject({ status: "healthy", lastSyncedAt: ago(1_200), syncLagMs: 1_200, unpublishedOutbox: 0, staleCount: 0, duplicateCount: 3, processedCount: 42 });
    // A real zero is reported as 0 ...
    expect(entry(r, "P001").staleCount).toBe(0);
    // ... and every pharmacy gets its own numbers.
    expect(entry(r, "P002")).toMatchObject({ syncLagMs: 60_000, unpublishedOutbox: 4, processedCount: 7, staleCount: 2 });
    expect(r.body.meta).toMatchObject({ generatedAt: new Date(NOW).toISOString(), redis: "up", connector: "up", syncService: "ready", thresholds: THRESHOLDS });
  });

  it("reports a pharmacy that never synchronized as unknown, with null (not 0) metrics", async () => {
    const r = await nodes({ sync: sync({ P001: reading(), P002: { record: null, backlog: 0 } }) });
    expect(entry(r, "P002")).toMatchObject({ status: "unknown", lastSyncedAt: null, syncLagMs: null, staleCount: null, duplicateCount: null, processedCount: null });
    // P003 is not even in Redis's answer: the same.
    expect(entry(r, "P003")).toMatchObject({ status: "unknown", syncLagMs: null, processedCount: null });
    expect(entry(r, "P002").statusReason).toMatch(/no event has been synchronized/i);
    // An existing status key alone is not health: no backlog measurement means "cannot confirm".
    const unmeasured = await nodes({ sync: sync({ P001: reading({ backlog: null }) }) });
    expect(entry(unmeasured, "P001").status).toBe("unknown");
  });

  it("holds freshness against a node only when events are waiting", async () => {
    // Idle for a day with nothing waiting is healthy: silence is not a failure.
    const idle = await nodes({ sync: sync({ P001: reading({ record: record({ lastSyncedAt: ago(24 * 3_600_000) }), backlog: 0 }) }) });
    expect(entry(idle, "P001").status).toBe("healthy");

    const waiting = (ms: number | null) => reading({ record: record({ lastSyncedAt: ms === null ? null : ago(ms) }), backlog: 5 });
    const r = await nodes({
      sync: sync({
        P001: waiting(THRESHOLDS.degradedAfterMs - 1_000),
        P002: waiting(THRESHOLDS.degradedAfterMs + 1_000),
        P003: waiting(THRESHOLDS.downAfterMs + 1_000),
      }),
    });
    expect(entry(r, "P001").status).toBe("healthy");
    expect(entry(r, "P002").status).toBe("degraded");
    expect(entry(r, "P003")).toMatchObject({ status: "down" });
    expect(entry(r, "P003").statusReason).toMatch(/waiting/);
    // Events waiting and nothing ever processed: degraded, not healthy.
    const never = await nodes({ sync: sync({ P001: { record: null, backlog: 3 } }) });
    expect(entry(never, "P001").status).toBe("degraded");
  });

  it("uses the connector's evidence: an unreachable pharmacy database is down, a failing poll is degraded", async () => {
    const r = await nodes({
      sync: sync({ P001: reading(), P002: reading(), P003: reading() }),
      connector: connector({ P001: { databaseUp: false, unpublishedOutbox: null }, P002: { pollingFailing: true, unpublishedOutbox: 9 }, P003: {} }),
    });
    expect(entry(r, "P001")).toMatchObject({ status: "down", unpublishedOutbox: null });
    expect(entry(r, "P002")).toMatchObject({ status: "degraded", unpublishedOutbox: 9 });
    expect(entry(r, "P003").status).toBe("healthy");
  });

  it("says the outbox count is unavailable (null) when the connector cannot be reached", async () => {
    const r = await nodes({ sync: sync({ P001: reading() }), connector: { read: async () => ({ reachable: false }) } });
    expect(r.body.meta.connector).toBe("unreachable");
    expect(r.body.data.every((n) => n.unpublishedOutbox === null)).toBe(true);
    expect(entry(r, "P001").status).toBe("healthy"); // missing evidence is not negative evidence
  });

  it("calls a caught-up node healthy only when the sync service confirms it is running", async () => {
    const svc = (state: SyncServiceState) => ({ read: async () => state });
    const caughtUp = sync({ P001: reading(), P002: reading({ backlog: 0 }) });
    const ready = await nodes({ sync: caughtUp, syncService: svc("ready") });
    expect(ready.body.meta.syncService).toBe("ready");
    expect(entry(ready, "P001").status).toBe("healthy");
    // Nothing is consuming, so "caught up" proves nothing: unknown, not healthy.
    const gone = await nodes({ sync: caughtUp, syncService: svc("unreachable") });
    expect(gone.body.meta.syncService).toBe("unreachable");
    expect(gone.body.data.every((n) => n.status === "unknown")).toBe(true);
    expect(entry(gone, "P001").statusReason).toMatch(/could not be reached/);
    // The service answers but says it is not ready.
    const sick = await nodes({ sync: caughtUp, syncService: svc("not-ready") });
    expect(entry(sick, "P001").status).toBe("degraded");
    // Waiting events with a silent consumer are still down: that is negative evidence, not missing evidence.
    const stuck = await nodes({ sync: sync({ P001: reading({ record: record({ lastSyncedAt: ago(THRESHOLDS.downAfterMs + 1_000) }), backlog: 4 }) }), syncService: svc("unreachable") });
    expect(entry(stuck, "P001").status).toBe("down");
    expect((await nodes({ sync: caughtUp })).body.meta.syncService).toBe("not-configured");
  });

  it("reads a service health report: ready only when it says so", () => {
    expect(parseServiceReport({ service: "inventory-sync", ready: true })).toBe("ready");
    expect(parseServiceReport({ service: "inventory-sync", ready: false, status: "degraded" })).toBe("not-ready");
    for (const bad of [null, "ok", {}, { ready: "yes" }, { status: "ok" }]) expect(parseServiceReport(bad)).toBe("unreachable");
  });

  it("reports every node unknown, with null counters, when Redis is unavailable", async () => {
    const r = await nodes({ sync: { read: async () => ({ redis: "down" }) } });
    expect(r.status).toBe(200);
    expect(r.body.meta.redis).toBe("down");
    expect(r.body.data).toHaveLength(PHARMACIES.length);
    for (const n of r.body.data) expect(n).toMatchObject({ status: "unknown", lastSyncedAt: null, syncLagMs: null, staleCount: null, duplicateCount: null, processedCount: null });
    // A source that throws is as bad as a down one: not a 500, not healthy.
    const broken = await nodes({ sync: { read: async () => ({ redis: "down" }) }, connector: connector({ P001: { databaseUp: true } }) });
    expect(broken.body.data.every((n) => n.status === "unknown")).toBe(true);
  });

  it("reports not-configured, never healthy, when live status is switched off", async () => {
    const r = await nodes({});
    expect(r.body.meta.redis).toBe("not-configured");
    expect(r.body.data.every((n) => n.status === "unknown" && n.processedCount === null)).toBe(true);
  });

  it("covers exactly the registry's active pharmacies and queries no database", async () => {
    const app = await buildApp(noDb, config, { logger: false, nodes: { sync: sync({}), now: () => NOW } });
    apps.push(app);
    const body = (await app.inject({ method: "GET", url: "/api/nodes" })).json() as NodesResponse;
    expect(body.data.map((n) => n.pharmacyCode)).toEqual(registryPharmacies({}).map((p) => p.code));
    expect(body.data.map((n) => n.pharmacyCode)).toEqual(["P001", "P002", "P003", "P004", "P005"]);
    expect(body.data.every((n) => n.name.length > 0)).toBe(true);
    // A directory pharmacy joins only when its database URL is configured.
    expect(registryPharmacies({ PHARMACY_P006_DATABASE_URL: "postgres://x" }).map((p) => p.code)).toContain("P006");
    expect(registryPharmacies({}).map((p) => p.code)).not.toContain("P006");
  });
});

describe("reading sync data defensively", () => {
  it("returns null for missing or malformed fields and never invents a number", () => {
    expect(parseSyncRecord({})).toBeNull();
    expect(parseSyncRecord({ lastSyncedAt: "not a date", processedCount: "x", duplicateCount: "-3", staleCount: "1.5" })).toEqual({ lastSyncedAt: null, processedCount: null, duplicateCount: null, staleCount: null });
    // Absent lazy counters are zero only beside a valid processedCount.
    expect(parseSyncRecord({ lastSyncedAt: ago(1), processedCount: "5" })).toMatchObject({ processedCount: 5, duplicateCount: 0, staleCount: 0 });
    expect(parseSyncRecord({ lastSyncedAt: ago(1) })).toMatchObject({ processedCount: null, duplicateCount: null, staleCount: null });
    expect(parseSyncRecord({ processedCount: "5", duplicateCount: "oops" })).toMatchObject({ duplicateCount: null });
  });

  it("calculates lag from a valid timestamp only", () => {
    expect(lagMs(ago(1_500), NOW)).toBe(1_500);
    expect(lagMs(ago(0), NOW)).toBe(0);
    expect(lagMs(null, NOW)).toBeNull();
    expect(lagMs("garbage", NOW)).toBeNull();
    expect(lagMs(new Date(NOW + 5_000).toISOString(), NOW)).toBeNull(); // in the future: not a lag
  });

  it("answers null lag and unknown status for a stored but unusable timestamp", async () => {
    const r = await nodes({ sync: sync({ P001: reading({ record: parseSyncRecord({ lastSyncedAt: "garbage", processedCount: "3" }), backlog: 0 }) }) });
    expect(entry(r, "P001")).toMatchObject({ status: "unknown", lastSyncedAt: null, syncLagMs: null, processedCount: 3 });
  });

  it("reads the connector's health report, and treats anything unexpected as no evidence", () => {
    const ok = parseConnectorReport({
      dependencies: { redis: "up", "postgres:P001": "up", "postgres:P002": "down" },
      details: { unpublishedOutbox: { P001: 0, P002: null }, pollingFailing: ["P001"] },
    });
    expect(ok).toEqual({
      reachable: true,
      pharmacies: new Map([
        ["P001", { databaseUp: true, unpublishedOutbox: 0, pollingFailing: true }],
        ["P002", { databaseUp: false, unpublishedOutbox: null, pollingFailing: false }],
      ]),
    });
    for (const bad of [null, "x", {}, { dependencies: {} }, { dependencies: {}, details: null }]) expect(parseConnectorReport(bad)).toEqual({ reachable: false });
    const weird = parseConnectorReport({ dependencies: {}, details: { unpublishedOutbox: { P001: -1, P002: "3", P003: 1.5 } } });
    expect(weird.reachable && [...weird.pharmacies.values()].every((p) => p.unpublishedOutbox === null)).toBe(true);
  });
});

describe("RedisSyncStatus (real Redis, unique key prefix)", () => {
  let redis: Redis;
  const prefix = `test-${randomUUID().slice(0, 8)}`;
  beforeAll(() => {
    redis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  });
  afterEach(async () => {
    await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  });
  afterAll(() => redis.disconnect());
  const source = () => new RedisSyncStatus(redis, { keyPrefix: prefix, timeoutMs: 1000 });
  const nodeOf = async (code: string) => {
    const r = await source().read([code]);
    if (r.redis !== "up") throw new Error("redis down");
    return r.nodes.get(code)!;
  };

  it("finds nothing for a pharmacy that never synchronized: no record, nothing waiting", async () => {
    expect(await nodeOf("P001")).toEqual({ record: null, backlog: 0 });
  });

  it("counts events nobody has consumed yet, then reaches 0 once they are handled and acknowledged", async () => {
    const stream = eventStreamKey("P001", prefix);
    await redis.xadd(stream, "*", "event", "{}");
    await redis.xadd(stream, "*", "event", "{}");
    expect((await nodeOf("P001")).backlog).toBe(2); // stream exists, no consumer group yet
    await redis.xgroup("CREATE", stream, "inventory-sync", "0");
    expect((await nodeOf("P001")).backlog).toBe(2); // group exists, nothing delivered: lag
    const got = (await redis.xreadgroup("GROUP", "inventory-sync", "c1", "COUNT", 1, "STREAMS", stream, ">")) as [string, [string, string[]][]][];
    expect((await nodeOf("P001")).backlog).toBe(2); // one delivered but unacknowledged + one lagging
    await redis.xack(stream, "inventory-sync", got[0]![1][0]![0]);
    expect((await nodeOf("P001")).backlog).toBe(1);
  });

  it("reads the sync status the sync service wrote, and keeps pharmacies apart", async () => {
    await redis.hset(syncStatusKey("P001", prefix), { lastSyncedAt: ago(500), processedCount: "9", staleCount: "2" });
    const r = await source().read(["P001", "P002"]);
    if (r.redis !== "up") throw new Error("redis down");
    expect(r.nodes.get("P001")!.record).toEqual({ lastSyncedAt: ago(500), processedCount: 9, staleCount: 2, duplicateCount: 0 });
    expect(r.nodes.get("P002")!.record).toBeNull();
  });

  it("reports down when Redis cannot be reached", async () => {
    const dead = createRedis({ url: "redis://127.0.0.1:1", failFast: true, onError: () => undefined });
    try {
      expect(await new RedisSyncStatus(dead, { keyPrefix: prefix, timeoutMs: 500 }).read(["P001"])).toEqual({ redis: "down" });
    } finally {
      dead.disconnect();
    }
  });
});
