import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { deadLetterKey, eventStreamKey } from "@medlink/event-schema";
import { SyncService } from "@medlink/inventory-sync";
import type { Redis } from "@medlink/redis";
import { connect, deleteKeys, makeEvent, newPrefix, pendingCount, publish, waitFor } from "../../inventory-sync/test/helpers.js";
import { silentLogger } from "../src/logger.js";
import { MockNotifier, type Notifier, type OutgoingNotification } from "../src/notifier.js";
import { NOTIFIER_GROUP, NotificationService } from "../src/service.js";

let db: Db;
let redis: Redis;
let prefix: string;
let crocin: number;
const stoppers: (() => Promise<void>)[] = [];

const FAST = { blockMs: 100, minIdleMs: 150, claimIntervalMs: 40, discoveryIntervalMs: 40, sweepIntervalMs: 60 };
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const restock = (over: Record<string, unknown> = {}) =>
  makeEvent({ eventType: "RESTOCK", quantityDelta: 10, quantityAfter: 10, timestamp: at(500), ...over });

beforeAll(async () => {
  db = await freshSeededDb();
  crocin = Number((await db.query("SELECT id FROM medicines WHERE code = 'M001'")).rows[0].id);
});
beforeEach(async () => {
  redis = connect();
  prefix = newPrefix();
  await db.query("TRUNCATE notifications, restock_subscriptions, users RESTART IDENTITY CASCADE");
});
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
  await deleteKeys(redis, prefix);
  redis.disconnect();
});
afterAll(async () => {
  await db.end();
});

async function subscribe(email: string): Promise<number> {
  const u = Number((await db.query("INSERT INTO users (name, email) VALUES ($1, $1) RETURNING id", [email])).rows[0].id);
  return Number((await db.query("INSERT INTO restock_subscriptions (user_id, medicine_id) VALUES ($1, $2) RETURNING id", [u, crocin])).rows[0].id);
}
function startService(notifier: Notifier = new MockNotifier(silentLogger)) {
  const svc = new NotificationService(db, redis, notifier, silentLogger, { ...FAST, keyPrefix: prefix });
  stoppers.push(() => svc.stop());
  svc.start();
  return svc;
}
const notifications = async () => (await db.query("SELECT * FROM notifications ORDER BY id")).rows;

describe("NotificationService", () => {
  it("sends a simulated notification to a waiting user when a RESTOCK arrives on the stream", async () => {
    await subscribe("waiting@example.com");
    const notifier = new MockNotifier(silentLogger);
    startService(notifier);

    await publish(redis, prefix, restock({ pharmacyId: "P001", medicineId: "M001", quantityAfter: 10 }));
    await waitFor(() => notifier.sent.length === 1);

    expect(notifier.sent[0]).toMatchObject({ to: "waiting@example.com", channel: "MOCK" });
    expect(notifier.sent[0]!.message).toMatch(/^Crocin 500mg is back in stock at .+ \(10 available\)\.$/);
    expect((await notifications())[0].delivered_at).toBeInstanceOf(Date);
    await waitFor(async () => (await pendingCount(redis, eventStreamKey("P001", prefix), NOTIFIER_GROUP)) === 0);
  });

  it("does nothing for events that are not restocks", async () => {
    await subscribe("waiting@example.com");
    const svc = startService();
    await publish(redis, prefix, makeEvent({ medicineId: "M001", quantityDelta: -1, quantityAfter: 0, timestamp: at(500) })); // SALE
    await publish(redis, prefix, makeEvent({ eventType: "PRICE_UPDATED", medicineId: "M001", price: 30, quantityDelta: undefined, quantityAfter: undefined, timestamp: at(500) }));
    await waitFor(() => svc.stats().processed === 2);
    expect(await notifications()).toEqual([]);
    expect(svc.stats().restocks).toBe(0);
  });

  it("does nothing for a restock of a medicine nobody is waiting for", async () => {
    await subscribe("waiting@example.com");
    const svc = startService();
    await publish(redis, prefix, restock({ medicineId: "M002" }));
    await waitFor(() => svc.stats().processed === 1);
    expect(await notifications()).toEqual([]);
    expect(svc.stats().restocks).toBe(1);
  });

  it("notifies once when the same restock event is published twice", async () => {
    await subscribe("waiting@example.com");
    const notifier = new MockNotifier(silentLogger);
    const svc = startService(notifier);
    const e = restock({ medicineId: "M001" });
    await publish(redis, prefix, e);
    await publish(redis, prefix, e); // connector crashed after XADD: same eventId again
    await waitFor(() => svc.stats().processed === 2);
    expect(await notifications()).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it("does not tell a user about a restock that happened before they subscribed (backlog replay)", async () => {
    // The restock is already in the stream when the service starts; the consumer group reads from the beginning.
    await publish(redis, prefix, restock({ medicineId: "M001", timestamp: at(-5000) }));
    await subscribe("new@example.com");
    const svc = startService();
    await waitFor(() => svc.stats().processed === 1);
    expect(await notifications()).toEqual([]);
    expect((await db.query("SELECT status FROM restock_subscriptions")).rows[0].status).toBe("ACTIVE");

    // ...but the next real restock does reach them
    await publish(redis, prefix, restock({ medicineId: "M001" }));
    await waitFor(async () => (await notifications()).length === 1);
  });

  it("runs next to inventory-sync: both consumer groups get every event, independently", async () => {
    await subscribe("waiting@example.com");
    const notifier = new MockNotifier(silentLogger);
    startService(notifier);
    const handled: string[] = [];
    const inventorySync = new SyncService(redis, { handle: async (e) => void handled.push(e.eventId) }, silentLogger, { ...FAST, keyPrefix: prefix });
    stoppers.push(() => inventorySync.stop());
    inventorySync.start();

    const e = restock({ medicineId: "M001" });
    await publish(redis, prefix, e);
    await waitFor(() => notifier.sent.length === 1 && handled.length === 1);
    expect(handled).toEqual([e.eventId]);
    const stream = eventStreamKey("P001", prefix);
    // acknowledged shortly after the handler returns
    await waitFor(async () => (await pendingCount(redis, stream, NOTIFIER_GROUP)) === 0 && (await pendingCount(redis, stream)) === 0);
  });

  it("a channel that is down does not lose the notification: it stays stored and is sent once the channel is back", async () => {
    await subscribe("waiting@example.com");
    let down = true;
    const sent: OutgoingNotification[] = [];
    const flaky: Notifier = { send: async (n) => { if (down) throw new Error("channel down"); sent.push(n); } };
    const svc = startService(flaky);

    await publish(redis, prefix, restock({ medicineId: "M001" }));
    await waitFor(() => svc.stats().processed === 1);
    expect(await notifications()).toHaveLength(1); // stored...
    expect((await notifications())[0].delivered_at).toBeNull(); // ...not yet delivered
    expect(await pendingCount(redis, eventStreamKey("P001", prefix), NOTIFIER_GROUP)).toBe(0); // the event itself is done: no retry loop
    expect(await redis.xlen(deadLetterKey(prefix))).toBe(0);

    down = false;
    await waitFor(() => sent.length === 1); // the periodic sweep
    expect(sent).toHaveLength(1);
    expect((await notifications())[0].delivered_at).toBeInstanceOf(Date);
  });

  it("sends notifications that were stored before a restart", async () => {
    const sub = await subscribe("waiting@example.com");
    await db.query(
      `INSERT INTO notifications (user_id, subscription_id, medicine_id, event_id, message)
       SELECT user_id, id, medicine_id, gen_random_uuid(), 'left over' FROM restock_subscriptions WHERE id = $1`,
      [sub],
    );
    const notifier = new MockNotifier(silentLogger);
    startService(notifier);
    await waitFor(() => notifier.sent.length === 1);
    expect(notifier.sent[0]!.message).toBe("left over");
  });

  it("notifies every waiting user, across pharmacies' streams", async () => {
    for (const e of ["a", "b", "c"]) await subscribe(`${e}@example.com`);
    const notifier = new MockNotifier(silentLogger);
    startService(notifier);
    await publish(redis, prefix, restock({ pharmacyId: "P002", medicineId: "M001" }));
    await waitFor(() => notifier.sent.length === 3);
    expect(notifier.sent.map((n) => n.to).sort()).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(notifier.sent[0]!.message).toMatch(/back in stock at /);
  });
});
