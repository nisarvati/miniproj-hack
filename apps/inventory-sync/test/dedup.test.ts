import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dedupKey, eventStreamKey, syncStatusKey, type InventoryEvent } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";
import { DedupHandler, EventInFlightError } from "../src/dedup.js";
import type { EventHandler, HandlerContext } from "../src/handler.js";
import { silentLogger } from "../src/logger.js";
import { SyncService, type SyncOptions } from "../src/service.js";
import { connect, deleteKeys, makeEvent, newPrefix, pendingCount, publish, sleep, waitFor } from "./helpers.js";

let redis: Redis;
let prefix: string;
const services: SyncService[] = [];
const ctx: HandlerContext = { streamId: "1-0", deliveries: 1 };

const FAST: Partial<SyncOptions> = { blockMs: 100, minIdleMs: 150, claimIntervalMs: 40, discoveryIntervalMs: 40, maxDeliveries: 5 };

class Inner implements EventHandler {
  calls = 0;
  constructor(private readonly behave: (call: number) => Promise<void> | void = () => undefined) {}
  async handle() {
    await this.behave(++this.calls);
  }
}

const dedup = (inner: EventHandler, leaseMs = 5000) => new DedupHandler(redis, inner, { keyPrefix: prefix, leaseMs });
const marker = (e: InventoryEvent) => redis.get(dedupKey(e.pharmacyId, e.eventId, prefix));

beforeEach(() => {
  redis = connect();
  prefix = newPrefix();
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  await deleteKeys(redis, prefix);
  redis.disconnect();
});

describe("DedupHandler", () => {
  it("handles an event once and marks it done only after success", async () => {
    const inner = new Inner(async () => {
      expect(await marker(ev)).toBe("processing");
    });
    const ev = makeEvent();
    await dedup(inner).handle(ev, ctx);
    expect(inner.calls).toBe(1);
    expect(await marker(ev)).toBe("done");
  });

  it("ignores a second delivery of the same event and counts it", async () => {
    const inner = new Inner();
    const h = dedup(inner);
    const ev = makeEvent();
    await h.handle(ev, ctx);
    await h.handle(ev, { ...ctx, deliveries: 2 });
    expect(inner.calls).toBe(1);
    expect(h.stats.duplicates).toBe(1);
    expect(await redis.hget(syncStatusKey("P001", prefix), "duplicateCount")).toBe("1");
  });

  it("does not confuse different events", async () => {
    const inner = new Inner();
    const h = dedup(inner);
    await h.handle(makeEvent(), ctx);
    await h.handle(makeEvent(), ctx);
    expect(inner.calls).toBe(2);
  });

  it("does not lose an event whose handler failed: the retry runs it again", async () => {
    const inner = new Inner((call) => {
      if (call === 1) throw new Error("boom");
    });
    const h = dedup(inner);
    const ev = makeEvent();
    await expect(h.handle(ev, ctx)).rejects.toThrow("boom");
    expect(await marker(ev)).toBeNull(); // lease released, not "done"
    await h.handle(ev, { ...ctx, deliveries: 2 });
    expect(inner.calls).toBe(2);
    expect(await marker(ev)).toBe("done");
  });

  it("defers a delivery while another one is being handled, then takes over when the lease expires", async () => {
    const ev = makeEvent();
    // Simulates a consumer that took the event and crashed: the lease marker exists, nobody finishes it.
    await redis.set(dedupKey(ev.pharmacyId, ev.eventId, prefix), "processing", "PX", 120);
    const inner = new Inner();
    const h = dedup(inner);
    await expect(h.handle(ev, ctx)).rejects.toBeInstanceOf(EventInFlightError);
    expect(inner.calls).toBe(0);
    await sleep(160);
    await h.handle(ev, { ...ctx, deliveries: 2 });
    expect(inner.calls).toBe(1);
  });

  it("only one of two concurrent deliveries runs the handler", async () => {
    const inner = new Inner(() => sleep(60));
    const h = dedup(inner);
    const ev = makeEvent();
    const results = await Promise.allSettled([h.handle(ev, ctx), h.handle(ev, ctx)]);
    expect(inner.calls).toBe(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("forgets an event after the retention period", async () => {
    const inner = new Inner();
    const h = new DedupHandler(redis, inner, { keyPrefix: prefix, retentionMs: 80 });
    const ev = makeEvent();
    await h.handle(ev, ctx);
    await sleep(120);
    await h.handle(ev, ctx);
    expect(inner.calls).toBe(2);
  });
});

describe("dedup in the running service", () => {
  it("applies an event republished with the same eventId only once, and acknowledges both entries", async () => {
    const inner = new Inner();
    const svc = new SyncService(redis, dedup(inner), silentLogger, { ...FAST, keyPrefix: prefix });
    services.push(svc);
    svc.start();
    const ev = makeEvent();
    await publish(redis, prefix, ev);
    await publish(redis, prefix, ev); // connector crashed between XADD and marking the outbox row published
    await publish(redis, prefix, makeEvent());
    await waitFor(() => svc.stats().processed === 3);
    expect(inner.calls).toBe(2);
    expect(await pendingCount(redis, eventStreamKey("P001", prefix))).toBe(0);
    expect(await redis.xlen(`${prefix}:events:dlq`)).toBe(0);
  });

  it("two instances never handle the same duplicated event twice", async () => {
    const inner = new Inner(() => sleep(20));
    const h = dedup(inner);
    for (let i = 0; i < 2; i++) {
      const s = new SyncService(redis, h, silentLogger, { ...FAST, keyPrefix: prefix, consumer: `c-${i}`, batchSize: 5 });
      services.push(s);
      s.start();
    }
    const events = Array.from({ length: 10 }, () => makeEvent());
    for (const e of events) for (let copy = 0; copy < 3; copy++) await publish(redis, prefix, e);
    await waitFor(async () => (await pendingCount(redis, eventStreamKey("P001", prefix))) === 0 && h.stats.duplicates + inner.calls >= 30, 10000);
    expect(inner.calls).toBe(10);
  });
});
