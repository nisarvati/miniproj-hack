/**
 * End to end: pharmacy database -> inventory connector -> Redis stream -> inventory sync -> status in Redis.
 * Real Postgres and Redis; no mocks between the stages.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { deadLetterKey, eventStreamKey, syncStatusKey } from "@medlink/event-schema";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { InventoryConnector, RedisStreamPublisher, silentLogger as connectorLog } from "@medlink/inventory-connector";
import { SyncService, SyncStatusHandler, silentLogger as syncLog } from "@medlink/inventory-sync";

vi.setConfig({ testTimeout: 20_000 });

let admin: Db;
let pharmacyA: Db;
let urls: Record<string, string>;
let producerRedis: Redis;
let consumerRedis: Redis;
let prefix: string;
let sync: SyncService;
let connector: InventoryConnector;

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  admin = await freshSeededDb();
  urls = await freshPharmacyDbs(admin);
  pharmacyA = createPool(urls.P001);
});
afterAll(async () => {
  await pharmacyA.end();
  await admin.end();
});
beforeEach(async () => {
  prefix = `test-${randomUUID().slice(0, 8)}`;
  producerRedis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  consumerRedis = createRedis({ ...redisOptionsFromEnv(), onError: () => undefined });
  await setupPharmacyDatabase("P001", urls.P001!);
  await pharmacyA.query("TRUNCATE outbox");

  connector = new InventoryConnector({
    pharmacyId: "P001",
    db: pharmacyA,
    publisher: new RedisStreamPublisher(producerRedis, { keyPrefix: prefix }),
    logger: connectorLog,
    pollIntervalMs: 20,
  });
  sync = new SyncService(consumerRedis, new SyncStatusHandler(consumerRedis, prefix), syncLog, {
    keyPrefix: prefix,
    blockMs: 100,
    discoveryIntervalMs: 30,
    claimIntervalMs: 100,
    minIdleMs: 300,
  });
});
afterEach(async () => {
  await connector.stop();
  await sync.stop();
  await deleteAll(consumerRedis, await scanKeys(consumerRedis, `${prefix}:*`));
  producerRedis.disconnect();
  consumerRedis.disconnect();
});

/** A pharmacy that has just been (re)loaded: its 14 items sit in the outbox as MEDICINE_ADDED events. */
async function freshSnapshot() {
  await pharmacyA.query("DELETE FROM inventory");
  await pharmacyA.query("TRUNCATE outbox");
  await setupPharmacyDatabase("P001", urls.P001!);
}

const status = () => consumerRedis.hgetall(syncStatusKey("P001", prefix));
const pendingInStream = async () => Number(((await consumerRedis.xpending(eventStreamKey("P001", prefix), "inventory-sync")) as [number])[0]);

describe("pharmacy database -> connector -> Redis stream -> sync service", () => {
  it("carries a sale all the way through, live", async () => {
    connector.start();
    sync.start();

    await pharmacyA.query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'"); // Pharmacy A sells its last Crocin
    await waitFor(async () => (await status()).lastEventType === "SALE" && (await status()).lastMedicineId === "M001");

    const s = await status();
    expect(s.lastEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number(s.lastLatencyMs)).toBeLessThan(5000);
    // the stream holds exactly the event the sync service processed, and nothing is left unacknowledged
    const entries = await consumerRedis.xrange(eventStreamKey("P001", prefix), "-", "+");
    expect(entries.map(([, f]) => JSON.parse(f[1]!).eventId)).toContain(s.lastEventId);
    await waitFor(async () => (await pendingInStream()) === 0);
    expect(await consumerRedis.xlen(deadLetterKey(prefix))).toBe(0);
  });

  it("processes the whole initial snapshot and then each change in order (sale, restock, price)", async () => {
    await freshSnapshot();
    connector.start();
    sync.start();
    await waitFor(async () => Number((await status()).processedCount) === 14); // the 14 MEDICINE_ADDED snapshot events

    await pharmacyA.query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'");
    await waitFor(async () => (await status()).lastEventType === "SALE");
    await pharmacyA.query("UPDATE inventory SET quantity = quantity + 10 WHERE medicine_code = 'M001'");
    await waitFor(async () => (await status()).lastEventType === "RESTOCK");
    await pharmacyA.query("UPDATE inventory SET price = 27 WHERE medicine_code = 'M001'");
    await waitFor(async () => (await status()).lastEventType === "PRICE_UPDATED");

    expect(Number((await status()).processedCount)).toBe(17);
    const types = (await consumerRedis.xrange(eventStreamKey("P001", prefix), "-", "+")).map(([, f]) => JSON.parse(f[1]!).eventType);
    expect(types.slice(-3)).toEqual(["SALE", "RESTOCK", "PRICE_UPDATED"]);
    await waitFor(async () => (await pendingInStream()) === 0);
  });

  it("delivers events made while the sync service was not running, once it starts", async () => {
    await freshSnapshot();
    connector.start();
    await pharmacyA.query("UPDATE inventory SET quantity = quantity + 5 WHERE medicine_code = 'M001'");
    await waitFor(async () => (await consumerRedis.xlen(eventStreamKey("P001", prefix))) >= 15); // snapshot + restock waiting in the stream
    expect(await status()).toEqual({}); // nothing consumed yet

    sync.start();
    await waitFor(async () => (await status()).lastEventType === "RESTOCK");
    expect(Number((await status()).processedCount)).toBe(15);
  });
});
