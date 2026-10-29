import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deadLetterKey, eventStreamKey, syncStatusKey, type InventoryEvent } from "@medlink/event-schema";
import { createRedis, type Redis } from "@medlink/redis";
import { SyncStatusHandler, type EventHandler, type HandlerContext } from "../src/handler.js";
import { silentLogger } from "../src/logger.js";
import { SyncService, type SyncOptions } from "../src/service.js";
import { connect, deleteKeys, GROUP, makeEvent, newPrefix, pendingCount, publish, publishRaw, sleep, waitFor } from "./helpers.js";

let redis: Redis;
let prefix: string;
const services: SyncService[] = [];

const FAST: Partial<SyncOptions> = {
  blockMs: 100,
  minIdleMs: 150,
  claimIntervalMs: 40,
  discoveryIntervalMs: 40,
  maxDeliveries: 3,
};

/** A handler that records what it was given and can be told to fail. */
class TestHandler implements EventHandler {
  readonly calls: { event: InventoryEvent; ctx: HandlerContext }[] = [];
  constructor(private readonly failWhen: (e: InventoryEvent, attempt: number) => boolean = () => false) {}
  get events() {
    return this.calls.map((c) => c.event);
  }
  async handle(event: InventoryEvent, ctx: HandlerContext) {
    const attempt = this.calls.filter((c) => c.event.eventId === event.eventId).length + 1;
    this.calls.push({ event, ctx });
    if (this.failWhen(event, attempt)) throw new Error("simulated failure");
  }
}

function startService(handler: EventHandler, opts: Partial<SyncOptions> = {}, client = redis): SyncService {
  const s = new SyncService(client, handler, silentLogger, { ...FAST, keyPrefix: prefix, consumer: `c-${services.length}`, ...opts });
  services.push(s);
  s.start();
  return s;
}

beforeEach(() => {
  redis = connect();
  prefix = newPrefix();
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await deleteKeys(redis, prefix);
  redis.disconnect();
});

const dlq = async () => redis.xrange(deadLetterKey(prefix), "-", "+");
const dlqFields = (entry: [string, string[]]) => Object.fromEntries(entry[1].reduce<[string, string][]>((acc, v, i, a) => (i % 2 ? acc : [...acc, [v, a[i + 1]!]]), []));

describe("consuming events", () => {
  it("processes a valid event, hands it to the handler, and acknowledges it", async () => {
    const handler = new TestHandler();
    const svc = startService(handler);
    const ev = makeEvent();
    const streamId = await publish(redis, prefix, ev);

    await waitFor(() => handler.calls.length === 1);
    expect(handler.calls[0]!.event).toEqual(ev);
    expect(handler.calls[0]!.ctx).toEqual({ streamId, deliveries: 1 });
    await waitFor(async () => (await pendingCount(redis, eventStreamKey("P001", prefix))) === 0);
    expect(svc.stats()).toMatchObject({ processed: 1, deadLettered: 0, retriedFailures: 0, streams: 1 });
  });

  it("processes a pharmacy's events in the order they were written", async () => {
    const handler = new TestHandler();
    startService(handler);
    const sent: string[] = [];
    for (let i = 0; i < 25; i++) {
      const e = makeEvent();
      sent.push(e.eventId);
      await publish(redis, prefix, e);
    }
    await waitFor(() => handler.calls.length === 25);
    expect(handler.events.map((e) => e.eventId)).toEqual(sent);
  });

  it("processes events that were written before the service ever started", async () => {
    const handler = new TestHandler();
    const early = [makeEvent(), makeEvent(), makeEvent({ pharmacyId: "P002" })];
    for (const e of early) await publish(redis, prefix, e);
    startService(handler);
    await waitFor(() => handler.calls.length === 3);
    expect(new Set(handler.events.map((e) => e.eventId))).toEqual(new Set(early.map((e) => e.eventId)));
  });

  it("discovers pharmacy streams that appear after it started", async () => {
    const handler = new TestHandler();
    const svc = startService(handler);
    await sleep(100);
    expect(svc.stats().streams).toBe(0);
    await publish(redis, prefix, makeEvent({ pharmacyId: "P003" }));
    await waitFor(() => handler.calls.length === 1);
    expect(svc.stats().streams).toBe(1);
  });

  it("runs the SyncStatusHandler: records last event, last sync time and a count per pharmacy", async () => {
    const svc = startService(new SyncStatusHandler(redis, prefix));
    const a = makeEvent();
    const b = makeEvent({ eventType: "RESTOCK", quantityDelta: 5, quantityAfter: 15 });
    await publish(redis, prefix, a);
    await publish(redis, prefix, b);
    await publish(redis, prefix, makeEvent({ pharmacyId: "P002" }));
    await waitFor(() => svc.stats().processed === 3);

    const p1 = await redis.hgetall(syncStatusKey("P001", prefix));
    expect(p1).toMatchObject({ lastEventId: b.eventId, lastEventType: "RESTOCK", lastMedicineId: "M001", processedCount: "2" });
    expect(Date.now() - Date.parse(p1.lastSyncedAt!)).toBeLessThan(5000);
    expect(Number(p1.lastLatencyMs)).toBeGreaterThanOrEqual(0);
    expect((await redis.hgetall(syncStatusKey("P002", prefix))).processedCount).toBe("1");
  });
});

describe("invalid events are dead-lettered, not retried and not blocking", () => {
  it.each([
    ["not JSON", ["event", "{oops"], "MALFORMED", /not valid JSON/],
    ["no event field", ["something", "else"], "MALFORMED", /no "event" field/],
    ["a JSON array", ["event", "[1,2]"], "MALFORMED", /JSON object/],
    ["schema-invalid event", ["event", JSON.stringify({ ...makeEvent(), quantityDelta: 4 })], "INVALID", /quantityDelta/],
    ["unsupported schemaVersion", ["event", JSON.stringify({ ...makeEvent(), schemaVersion: 99 })], "UNSUPPORTED_VERSION", /schemaVersion 99/],
    ["an event in another pharmacy's stream", ["event", JSON.stringify(makeEvent({ pharmacyId: "P002" }))], "INVALID", /P002.*P001/],
  ])("%s", async (_name, fields, code, reason) => {
    const handler = new TestHandler();
    const svc = startService(handler);
    const bad = await publishRaw(redis, prefix, "P001", fields as string[]);
    const good = makeEvent();
    await publish(redis, prefix, good); // behind the poison entry

    await waitFor(() => handler.calls.length === 1); // the good event still gets through
    expect(handler.events[0]!.eventId).toBe(good.eventId);
    await waitFor(async () => (await dlq()).length === 1);

    const entry = dlqFields((await dlq())[0] as [string, string[]]);
    expect(entry).toMatchObject({ stream: eventStreamKey("P001", prefix), entryId: bad, code });
    expect(entry.reason).toMatch(reason as RegExp);
    expect(entry.payload).toBeTruthy();
    await waitFor(async () => (await pendingCount(redis, eventStreamKey("P001", prefix))) === 0);
    expect(svc.stats().deadLettered).toBe(1);
  });
});

describe("retries and failure handling", () => {
  it("retries a failed event after the idle time, with an increased delivery count, then acknowledges it", async () => {
    const handler = new TestHandler((_e, attempt) => attempt === 1);
    const svc = startService(handler);
    const ev = makeEvent();
    await publish(redis, prefix, ev);

    await waitFor(() => handler.calls.length === 2);
    expect(handler.calls.map((c) => [c.event.eventId, c.ctx.deliveries])).toEqual([[ev.eventId, 1], [ev.eventId, 2]]);
    await waitFor(async () => (await pendingCount(redis, eventStreamKey("P001", prefix))) === 0);
    expect(svc.stats()).toMatchObject({ processed: 1, retriedFailures: 1, deadLettered: 0 });
    expect(await dlq()).toEqual([]);
  });

  it("dead-letters an event that keeps failing, after the maximum number of attempts", async () => {
    const handler = new TestHandler((e) => e.eventId === bad.eventId);
    const bad = makeEvent();
    const svc = startService(handler, { maxDeliveries: 3 });
    await publish(redis, prefix, bad);
    await publish(redis, prefix, makeEvent()); // must not be blocked behind it

    await waitFor(async () => (await dlq()).length === 1, 8000);
    expect(handler.calls.filter((c) => c.event.eventId === bad.eventId)).toHaveLength(3);
    const entry = dlqFields((await dlq())[0] as [string, string[]]);
    expect(entry).toMatchObject({ code: "MAX_DELIVERIES" });
    expect(JSON.parse(entry.payload!).eventId).toBe(bad.eventId);
    await waitFor(async () => (await pendingCount(redis, eventStreamKey("P001", prefix))) === 0);
    expect(handler.events.filter((e) => e.eventId !== bad.eventId)).toHaveLength(1);
    expect(svc.stats().deadLettered).toBe(1);
  });

  it("a failing pharmacy does not hold up the others (fault isolation)", async () => {
    const handler = new TestHandler((e) => e.pharmacyId === "P001");
    startService(handler);
    await publish(redis, prefix, makeEvent({ pharmacyId: "P001" }));
    const others = [makeEvent({ pharmacyId: "P002" }), makeEvent({ pharmacyId: "P003" }), makeEvent({ pharmacyId: "P002" })];
    for (const e of others) await publish(redis, prefix, e);

    await waitFor(() => others.every((o) => handler.events.some((e) => e.eventId === o.eventId)));
    expect(await pendingCount(redis, eventStreamKey("P002", prefix))).toBe(0);
  });

  it("takes over entries a crashed consumer received but never acknowledged", async () => {
    const key = eventStreamKey("P001", prefix);
    const ev = makeEvent();
    await publish(redis, prefix, ev);
    // A previous consumer reads the entry and then dies without acknowledging it.
    await redis.xgroup("CREATE", key, GROUP, "0");
    await redis.xreadgroup("GROUP", GROUP, "dead-consumer", "COUNT", 10, "STREAMS", key, ">");
    expect(await pendingCount(redis, key)).toBe(1);

    const handler = new TestHandler();
    startService(handler);
    await waitFor(() => handler.calls.length === 1);
    expect(handler.calls[0]!.event.eventId).toBe(ev.eventId);
    expect(handler.calls[0]!.ctx.deliveries).toBe(2); // it is a re-delivery
    await waitFor(async () => (await pendingCount(redis, key)) === 0);
  });

  it("leaves nothing unacknowledged after a clean shutdown and does not process further events", async () => {
    const handler = new TestHandler();
    const svc = startService(handler);
    await publish(redis, prefix, makeEvent());
    await waitFor(() => handler.calls.length === 1);
    await svc.stop();
    await publish(redis, prefix, makeEvent());
    await sleep(200);
    expect(handler.calls).toHaveLength(1);
    expect(await pendingCount(redis, eventStreamKey("P001", prefix))).toBe(0);
  });
});

describe("scaling out", () => {
  it("several sync instances in one consumer group share the work: every event is handled exactly once", async () => {
    const handlerA = new TestHandler();
    const handlerB = new TestHandler();
    const clientB = connect();
    startService(handlerA, {}, redis);
    startService(handlerB, {}, clientB);

    const sent: string[] = [];
    for (let i = 0; i < 40; i++) {
      const e = makeEvent({ pharmacyId: `P00${(i % 3) + 1}` });
      sent.push(e.eventId);
      await publish(redis, prefix, e);
    }
    await waitFor(() => handlerA.calls.length + handlerB.calls.length >= 40);
    await sleep(300); // give any (wrong) duplicate time to show up
    const handled = [...handlerA.events, ...handlerB.events].map((e) => e.eventId);
    expect(handled).toHaveLength(40);
    expect(new Set(handled)).toEqual(new Set(sent));
    clientB.disconnect();
  });
});

describe("Redis trouble", () => {
  it("shuts down promptly even when Redis is unreachable", async () => {
    const dead = createRedis({ url: "redis://127.0.0.1:1", onError: () => undefined });
    const errors: object[] = [];
    const s = new SyncService(dead, new TestHandler(), { ...silentLogger, error: (o) => void errors.push(o) }, { ...FAST, keyPrefix: prefix, shutdownTimeoutMs: 300 });
    s.start();
    await sleep(400);
    const began = Date.now();
    await s.stop(); // must not hang just because Redis is down
    expect(Date.now() - began).toBeLessThan(2000);
    dead.disconnect();
  });
});
