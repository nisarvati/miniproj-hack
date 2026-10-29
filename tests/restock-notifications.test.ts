/**
 * Milestone 11 acceptance: a user asks to be told when an unavailable medicine is restocked, and receives a
 * simulated notification after the restock.
 *
 * Everything real, nothing mocked between the stages:
 *   user -> HTTP API (subscribe)
 *   pharmacy database restock -> outbox -> connector -> Redis stream -> notification service -> notification stored
 *   user -> HTTP API (read notifications)
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { deadLetterKey } from "@medlink/event-schema";
import { InventoryConnector, RedisStreamPublisher, silentLogger as connectorLog } from "@medlink/inventory-connector";
import { MockNotifier, NotificationService, silentLogger } from "@medlink/notification-service";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { buildApp } from "../apps/search-service/src/app.js";
import { loadConfig } from "../apps/search-service/src/config.js";

vi.setConfig({ testTimeout: 20_000 });

let central: Db;
let pharmacyA: Db;
let app: FastifyInstance;
let producerRedis: Redis;
let consumerRedis: Redis;
let prefix: string;
let connector: InventoryConnector;
let notifications: NotificationService;
let notifier: MockNotifier;
let crocinId: number;

const EMAIL = "asha@example.com";

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const api = {
  subscribe: (email: string) => app.inject({ method: "POST", url: "/api/restock-subscriptions", payload: { email, medicineId: crocinId } }),
  notifications: async (email: string) => (await app.inject({ method: "GET", url: `/api/notifications?email=${email}` })).json().data as { message: string; deliveredAt: string | null }[],
  subscriptions: async (email: string) => (await app.inject({ method: "GET", url: `/api/restock-subscriptions?email=${email}` })).json().data as { status: string }[],
};
const setStock = (quantity: number) => pharmacyA.query("UPDATE inventory SET quantity = $1 WHERE medicine_code = 'M001'", [quantity]);
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  central = await freshSeededDb();
  const urls = await freshPharmacyDbs(central);
  pharmacyA = createPool(urls.P001!);
  app = await buildApp(central, loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" }), { logger: false });
  crocinId = Number((await central.query("SELECT id FROM medicines WHERE code = 'M001'")).rows[0].id);
});
afterAll(async () => {
  await app.close();
  await pharmacyA.end();
  await central.end();
});
beforeEach(async () => {
  prefix = `test-${randomUUID().slice(0, 8)}`;
  await central.query("TRUNCATE notifications, restock_subscriptions, users RESTART IDENTITY CASCADE");
  await pharmacyA.query("TRUNCATE outbox");
  await setStock(0); // the medicine is unavailable at the pharmacy
  await pharmacyA.query("TRUNCATE outbox");

  producerRedis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  consumerRedis = createRedis({ ...redisOptionsFromEnv(), onError: () => undefined });
  connector = new InventoryConnector({
    pharmacyId: "P001",
    db: pharmacyA,
    publisher: new RedisStreamPublisher(producerRedis, { keyPrefix: prefix }),
    logger: connectorLog,
    pollIntervalMs: 20,
  });
  notifier = new MockNotifier(silentLogger);
  notifications = new NotificationService(central, consumerRedis, notifier, silentLogger, {
    keyPrefix: prefix,
    blockMs: 100,
    discoveryIntervalMs: 30,
    claimIntervalMs: 100,
    minIdleMs: 300,
    sweepIntervalMs: 100,
  });
  connector.start();
  notifications.start();
});
afterEach(async () => {
  await connector.stop();
  await notifications.stop();
  await deleteAll(consumerRedis, await scanKeys(consumerRedis, `${prefix}:*`));
  producerRedis.disconnect();
  consumerRedis.disconnect();
});

describe("restock notifications, end to end", () => {
  it("a user waiting for an unavailable medicine receives a simulated notification after the restock", async () => {
    const res = await api.subscribe(EMAIL);
    expect(res.statusCode).toBe(201);
    expect(await api.notifications(EMAIL)).toEqual([]); // nothing yet: it is still out of stock

    await setStock(12); // the pharmacy receives a delivery

    await waitFor(async () => (await api.notifications(EMAIL)).length === 1);
    const [n] = await api.notifications(EMAIL);
    expect(n!.message).toMatch(/^Crocin 500mg is back in stock at .+ \(12 available\)\.$/);
    await waitFor(async () => (await api.notifications(EMAIL))[0]!.deliveredAt !== null);

    expect(notifier.sent).toHaveLength(1); // the simulated delivery
    expect(notifier.sent[0]).toMatchObject({ to: EMAIL, channel: "MOCK", message: n!.message });
    expect((await api.subscriptions(EMAIL))[0]!.status).toBe("NOTIFIED");
    expect(await consumerRedis.xlen(deadLetterKey(prefix))).toBe(0);
  });

  it("is told once: a second restock does not notify again, unless the user subscribes again", async () => {
    await api.subscribe(EMAIL);
    await setStock(5);
    await waitFor(async () => (await api.notifications(EMAIL)).length === 1);

    await setStock(0);
    await setStock(9); // another restock
    await waitFor(() => notifications.stats().restocks === 2);
    await settle();
    expect(await api.notifications(EMAIL)).toHaveLength(1);

    await setStock(0);
    expect((await api.subscribe(EMAIL)).statusCode).toBe(201); // asks again
    await setStock(20);
    await waitFor(async () => (await api.notifications(EMAIL)).length === 2);
  });

  it("does not notify before the restock: sales and price changes are not restocks", async () => {
    await api.subscribe(EMAIL);
    await pharmacyA.query("UPDATE inventory SET price = price + 1 WHERE medicine_code = 'M001'");
    await setStock(0);
    await settle();
    expect(await api.notifications(EMAIL)).toEqual([]);
    expect((await api.subscriptions(EMAIL))[0]!.status).toBe("ACTIVE");
  });

  it("does not notify a user who cancelled, nor one who asked only after the restock", async () => {
    const cancelled = (await api.subscribe("cancelled@example.com")).json().data;
    await app.inject({ method: "DELETE", url: `/api/restock-subscriptions/${cancelled.id}?email=cancelled@example.com` });

    await setStock(8);
    await waitFor(() => notifications.stats().restocks === 1);
    await api.subscribe("late@example.com"); // the restock is already history
    await settle();

    expect(await api.notifications("cancelled@example.com")).toEqual([]);
    expect(await api.notifications("late@example.com")).toEqual([]);
    expect((await api.subscriptions("late@example.com"))[0]!.status).toBe("ACTIVE"); // waits for the next one
  });
});
