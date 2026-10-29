import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { eventStreamKey, parseInventoryEvent, STREAM_EVENT_FIELD, streamRegistryKey, type InventoryEvent } from "@medlink/event-schema";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { InventoryConnector } from "../src/connector.js";
import { silentLogger } from "../src/logger.js";
import { RedisStreamPublisher } from "../src/redis-publisher.js";

let redis: Redis;
let prefix: string;

const makeEvent = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    schemaVersion: 1,
    eventId: randomUUID(),
    eventType: "SALE",
    pharmacyId: "P001",
    medicineId: "M001",
    quantityDelta: -1,
    quantityAfter: 4,
    price: 25,
    timestamp: new Date().toISOString(),
    ...over,
  }) as InventoryEvent;

beforeEach(() => {
  redis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  prefix = `test-${randomUUID().slice(0, 8)}`;
});
afterEach(async () => {
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  redis.disconnect();
});

describe("RedisStreamPublisher", () => {
  it("appends the event as JSON to the pharmacy's own stream", async () => {
    const ev = makeEvent();
    await new RedisStreamPublisher(redis, { keyPrefix: prefix }).publish(ev);

    const entries = await redis.xrange(eventStreamKey("P001", prefix), "-", "+");
    expect(entries).toHaveLength(1);
    const [, fields] = entries[0]!;
    expect(fields[0]).toBe(STREAM_EVENT_FIELD);
    const parsed = parseInventoryEvent(JSON.parse(fields[1]!));
    expect(parsed.success && parsed.event).toEqual(ev);
  });

  it("keeps each pharmacy in its own stream, in publish order", async () => {
    const pub = new RedisStreamPublisher(redis, { keyPrefix: prefix });
    const a1 = makeEvent();
    const b1 = makeEvent({ pharmacyId: "P002" });
    const a2 = makeEvent();
    for (const e of [a1, b1, a2]) await pub.publish(e);
    const ids = async (p: string) =>
      (await redis.xrange(eventStreamKey(p, prefix), "-", "+")).map(([, f]) => JSON.parse(f[1]!).eventId);
    expect(await ids("P001")).toEqual([a1.eventId, a2.eventId]);
    expect(await ids("P002")).toEqual([b1.eventId]);
  });

  it("registers each stream so consumers can discover it", async () => {
    const pub = new RedisStreamPublisher(redis, { keyPrefix: prefix });
    await pub.publish(makeEvent());
    await pub.publish(makeEvent({ pharmacyId: "P004" }));
    await pub.publish(makeEvent());
    expect((await redis.smembers(streamRegistryKey(prefix))).sort()).toEqual([eventStreamKey("P001", prefix), eventStreamKey("P004", prefix)].sort());
  });

  it("bounds stream length (approximate MAXLEN trimming)", async () => {
    const pub = new RedisStreamPublisher(redis, { keyPrefix: prefix, maxLen: 100 });
    for (let i = 0; i < 600; i++) await pub.publish(makeEvent());
    expect(await redis.xlen(eventStreamKey("P001", prefix))).toBeLessThan(400);
  });

  it("rejects quickly (instead of hanging) when Redis is unreachable", async () => {
    const dead = createRedis({ url: "redis://127.0.0.1:1", failFast: true, onError: () => undefined });
    const began = Date.now();
    await expect(new RedisStreamPublisher(dead, { keyPrefix: prefix }).publish(makeEvent())).rejects.toThrow();
    expect(Date.now() - began).toBeLessThan(5000);
    dead.disconnect();
  });
});

describe("connector with Redis: pharmacy database -> stream", () => {
  let admin: Db;
  let db: Db;
  let urls: Record<string, string>;

  beforeAll(async () => {
    admin = await freshSeededDb();
    urls = await freshPharmacyDbs(admin);
    db = createPool(urls.P001);
  });
  afterAll(async () => {
    await db.end();
    await admin.end();
  });
  beforeEach(async () => {
    await setupPharmacyDatabase("P001", urls.P001!);
    await db.query("TRUNCATE outbox");
  });

  const pending = async () => Number((await db.query("SELECT count(*) FROM outbox WHERE published_at IS NULL")).rows[0].count);

  it("a sale in the pharmacy database ends up as a SALE entry in that pharmacy's stream", async () => {
    await db.query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'");
    const connector = new InventoryConnector({ pharmacyId: "P001", db, publisher: new RedisStreamPublisher(redis, { keyPrefix: prefix }), logger: silentLogger });
    expect(await connector.runOnce()).toEqual({ published: 1, failed: 0 });

    const entries = await redis.xrange(eventStreamKey("P001", prefix), "-", "+");
    const event = JSON.parse(entries[0]![1][1]!);
    expect(event).toMatchObject({ eventType: "SALE", pharmacyId: "P001", medicineId: "M001", quantityDelta: -1, quantityAfter: 0, price: 25 });
    expect(await pending()).toBe(0);
  });

  it("keeps events safely in the outbox while Redis is down, and delivers them (same eventId) once it is back", async () => {
    await db.query("UPDATE inventory SET quantity = quantity + 3 WHERE medicine_code = 'M001'");
    const deadRedis = createRedis({ url: "redis://127.0.0.1:1", failFast: true, onError: () => undefined });
    const whileDown = new InventoryConnector({ pharmacyId: "P001", db, publisher: new RedisStreamPublisher(deadRedis, { keyPrefix: prefix }), logger: silentLogger });
    await expect(whileDown.runOnce()).rejects.toThrow();
    deadRedis.disconnect();
    expect(await pending()).toBe(1); // nothing lost
    const outboxEventId = (await db.query("SELECT event_id FROM outbox")).rows[0].event_id;

    const afterRecovery = new InventoryConnector({ pharmacyId: "P001", db, publisher: new RedisStreamPublisher(redis, { keyPrefix: prefix }), logger: silentLogger });
    expect(await afterRecovery.runOnce()).toEqual({ published: 1, failed: 0 });
    const entries = await redis.xrange(eventStreamKey("P001", prefix), "-", "+");
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]![1][1]!).eventId).toBe(outboxEventId);
  });
});
