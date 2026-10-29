import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@medlink/db";
import { dedupKey, eventStreamKey } from "@medlink/event-schema";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { NodesResponse, NodeStatusEntry } from "../src/modules/nodes/service.js";
import { RedisStockFeed, type StockChange, type StockFeed } from "../src/modules/stream/feed.js";
import { HUB_DEFAULTS, LiveHub, type ClientSink } from "../src/modules/stream/hub.js";

const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
const noDb = { query: () => { throw new Error("the stream must not query a database"); } } as unknown as Db;

// ------------------------------------------------------------------ fakes

const change = (over: Partial<StockChange> = {}): StockChange => ({
  eventId: randomUUID(),
  pharmacyCode: "P001",
  medicineCode: "M001",
  eventType: "SALE",
  quantity: 9,
  price: null,
  occurredAt: "2026-10-29T12:00:00.000Z",
  ...over,
});

class FakeFeed implements StockFeed {
  queue: StockChange[] = [];
  polls = 0;
  failWith: Error | null = null;
  async poll() {
    this.polls++;
    if (this.failWith) throw this.failWith;
    return this.queue.splice(0);
  }
  stats() {
    return { malformed: 0, unconfirmed: 0 };
  }
}

const node = (code: string, over: Partial<NodeStatusEntry> = {}): NodeStatusEntry => ({
  pharmacyCode: code,
  name: `Pharmacy ${code}`,
  status: "healthy",
  statusReason: "No events are waiting; the last event was processed.",
  lastSyncedAt: "2026-10-29T11:59:00.000Z",
  syncLagMs: 60_000,
  unpublishedOutbox: 0,
  staleCount: 0,
  duplicateCount: 0,
  processedCount: 5,
  ...over,
});
class FakeNodes {
  entries = [node("P001"), node("P002")];
  calls = 0;
  failWith: Error | null = null;
  read = async (): Promise<NodesResponse> => {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return {
      data: this.entries.map((n) => ({ ...n })),
      meta: { generatedAt: new Date().toISOString(), redis: "up", connector: "up", syncService: "ready", thresholds: { degradedAfterMs: 15_000, downAfterMs: 120_000 } },
    };
  };
}

class FakeClient implements ClientSink {
  frames: string[] = [];
  closed = false;
  accepting = true;
  send(frame: string) {
    this.frames.push(frame);
    return this.accepting;
  }
  close() {
    this.closed = true;
  }
  get events() {
    return parseFrames(this.frames.join(""));
  }
  of(name: string) {
    return this.events.filter((e) => e.event === name);
  }
}

interface Parsed {
  id?: string;
  event: string;
  // The test reads fields of whatever payload an event carries, so it is deliberately loose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}
function parseFrames(text: string): Parsed[] {
  return text
    .split("\n\n")
    .filter((b) => b.includes("event:"))
    .map((block) => {
      const out: Parsed = { event: "", data: null };
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) out.id = line.slice(4);
        else if (line.startsWith("event: ")) out.event = line.slice(7);
        else if (line.startsWith("data: ")) out.data = JSON.parse(line.slice(6));
      }
      return out;
    });
}

// -------------------------------------------------------------- the hub

describe("LiveHub", () => {
  let feed: FakeFeed;
  let nodes: FakeNodes;
  let warnings: string[];
  const make = (over: Partial<ConstructorParameters<typeof LiveHub>[0]> = {}) =>
    new LiveHub({ stock: feed, nodes: nodes.read, log: { warn: (_o, msg) => void warnings.push(msg) }, ...over });
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  beforeEach(() => {
    vi.useFakeTimers();
    feed = new FakeFeed();
    nodes = new FakeNodes();
    warnings = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing until someone connects: no timers, no feed reads, no node computation", async () => {
    make();
    await tick(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(feed.polls).toBe(0);
    expect(nodes.calls).toBe(0);
  });

  it("confirms the connection first, then sends the current state of every node", async () => {
    const hub = make();
    const c = new FakeClient();
    expect(hub.connect(c)).toBeTypeOf("function");
    expect(c.events[0]).toMatchObject({ event: "connected", data: { version: 1, bootId: hub.bootId, resync: false, heartbeatMs: HUB_DEFAULTS.heartbeatMs } });
    expect(c.events[0]!.id).toBeUndefined(); // never an id: it must not move the client's Last-Event-ID
    await tick(0);
    expect(c.of("node").map((e) => e.data.node.pharmacyCode)).toEqual(["P001", "P002"]);
    expect(c.of("node")[0]!.data).toMatchObject({ version: 1, meta: { redis: "up", connector: "up", syncService: "ready" } });
    expect(c.of("node").every((e) => e.id === undefined)).toBe(true);
  });

  it("publishes a stock change with an id and only the fields search already shows", async () => {
    const hub = make();
    const c = new FakeClient();
    hub.connect(c);
    await tick(0);
    feed.queue.push(change({ eventId: "11111111-1111-4111-8111-111111111111", quantity: 7, price: 25.5 }));
    await tick(HUB_DEFAULTS.pollMs);
    const [stock] = c.of("stock");
    expect(stock!.id).toBe(`${hub.bootId}.1`);
    expect(stock!.data).toEqual({ version: 1, eventId: "11111111-1111-4111-8111-111111111111", pharmacyCode: "P001", medicineCode: "M001", eventType: "SALE", quantity: 7, price: 25.5, occurredAt: "2026-10-29T12:00:00.000Z" });
    expect(JSON.stringify(stock)).not.toMatch(/quantityDelta|credential|password/i);
  });

  it("sends a node event only for a node that changed (the ever-growing lag is not a change), once, after stock moves", async () => {
    const hub = make({ nodePollMs: 60_000 });
    const c = new FakeClient();
    hub.connect(c);
    await tick(0);
    const snapshot = c.of("node").length;

    nodes.entries[0] = node("P001", { syncLagMs: 61_000 }); // only the lag moved
    feed.queue.push(change());
    await tick(HUB_DEFAULTS.pollMs + HUB_DEFAULTS.nodeAfterStockMs);
    expect(c.of("node")).toHaveLength(snapshot);

    nodes.entries[0] = node("P001", { processedCount: 6, lastSyncedAt: "2026-10-29T12:00:01.000Z" });
    feed.queue.push(change(), change(), change()); // several changes still cause one recomputation
    const before = nodes.calls;
    await tick(HUB_DEFAULTS.pollMs + HUB_DEFAULTS.nodeAfterStockMs);
    expect(nodes.calls).toBe(before + 1);
    const changed = c.of("node").slice(snapshot);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.data.node).toMatchObject({ pharmacyCode: "P001", processedCount: 6 });
    expect(changed[0]!.id).toBeDefined();
  });

  it("recomputes node status on its own timer, so a node that goes down is reported without any stock event", async () => {
    const hub = make({ nodePollMs: 5_000 });
    const c = new FakeClient();
    hub.connect(c);
    await tick(0);
    nodes.entries[1] = node("P002", { status: "down", statusReason: "stopped" });
    await tick(5_000);
    const last = c.of("node").at(-1)!;
    expect(last.data.node).toMatchObject({ pharmacyCode: "P002", status: "down" });
  });

  it("sends a heartbeat on a timer", async () => {
    const hub = make({ heartbeatMs: 10_000 });
    const c = new FakeClient();
    hub.connect(c);
    await tick(35_000);
    expect(c.of("heartbeat")).toHaveLength(3);
    expect(c.of("heartbeat")[0]!.data).toMatchObject({ version: 1 });
  });

  it("serves many clients from one read of the feed and one node computation", async () => {
    const hub = make();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.connect(a);
    hub.connect(b);
    await tick(0);
    expect(nodes.calls).toBe(1);
    feed.queue.push(change());
    const before = feed.polls;
    await tick(HUB_DEFAULTS.pollMs);
    expect(feed.polls).toBe(before + 1);
    expect(a.of("stock")).toHaveLength(1);
    expect(b.of("stock")).toHaveLength(1);
    expect(a.of("stock")[0]!.id).toBe(b.of("stock")[0]!.id);
  });

  it("releases every timer when the last client leaves, and ends the connection", async () => {
    const hub = make();
    const a = new FakeClient();
    const b = new FakeClient();
    const leaveA = hub.connect(a)!;
    const leaveB = hub.connect(b)!;
    await tick(1_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    leaveA();
    expect(hub.clientCount).toBe(1);
    expect(hub.running).toBe(true);
    leaveB();
    expect(hub.clientCount).toBe(0);
    expect(hub.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(a.closed && b.closed).toBe(true);
    leaveB(); // leaving twice is harmless
    const polls = feed.polls;
    await tick(60_000);
    expect(feed.polls).toBe(polls);
  });

  it("stop() ends every connection and all timers (server shutdown)", async () => {
    const hub = make();
    const c = new FakeClient();
    hub.connect(c);
    await tick(0);
    hub.stop();
    expect(c.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replays what a reconnecting client missed, using Last-Event-ID", async () => {
    const hub = make();
    const first = new FakeClient();
    hub.connect(first);
    await tick(0);
    for (const q of [1, 2, 3]) {
      feed.queue.push(change({ quantity: q }));
      await tick(HUB_DEFAULTS.pollMs);
    }
    const ids = first.of("stock").map((e) => e.id!);
    expect(ids).toHaveLength(3);

    const again = new FakeClient();
    hub.connect(again, ids[0]);
    expect(again.of("connected")[0]!.data.resync).toBe(false);
    expect(again.of("stock").map((e) => e.data.quantity)).toEqual([2, 3]);
    // Caught up exactly: nothing to replay.
    const current = new FakeClient();
    hub.connect(current, ids[2]);
    expect(current.of("stock")).toHaveLength(0);
    expect(current.of("connected")[0]!.data.resync).toBe(false);
  });

  it("tells the client to reload instead of replaying when it cannot", async () => {
    const hub = make({ bufferSize: 2 });
    const first = new FakeClient();
    hub.connect(first);
    await tick(0);
    for (let i = 0; i < 5; i++) {
      feed.queue.push(change({ quantity: i }));
      await tick(HUB_DEFAULTS.pollMs);
    }
    const resyncs = (lastEventId: string) => {
      const c = new FakeClient();
      hub.connect(c, lastEventId);
      return { resync: c.of("connected")[0]!.data.resync, replayed: c.of("stock").length };
    };
    expect(resyncs(`${hub.bootId}.1`)).toEqual({ resync: true, replayed: 0 }); // older than the buffer holds
    expect(resyncs(`${hub.bootId}.4`)).toEqual({ resync: false, replayed: 1 });
    expect(resyncs(`otherboot.3`)).toEqual({ resync: true, replayed: 0 }); // from before a restart
    expect(resyncs(`${hub.bootId}.99`)).toEqual({ resync: true, replayed: 0 }); // from the future: not ours
    expect(resyncs("garbage")).toEqual({ resync: true, replayed: 0 });
  });

  it("keeps running when the Redis feed fails, and delivers once it recovers", async () => {
    const hub = make();
    const c = new FakeClient();
    hub.connect(c);
    await tick(0);
    feed.failWith = new Error("redis down");
    await tick(HUB_DEFAULTS.pollMs * 3);
    expect(warnings.some((w) => /could not be read/.test(w))).toBe(true);
    expect(hub.clientCount).toBe(1);
    expect(c.closed).toBe(false);
    feed.failWith = null;
    feed.queue.push(change({ quantity: 3 }));
    await tick(HUB_DEFAULTS.pollMs);
    expect(c.of("stock").map((e) => e.data.quantity)).toEqual([3]);
  });

  it("keeps running when node status cannot be computed", async () => {
    const hub = make({ nodePollMs: 1_000 });
    nodes.failWith = new Error("boom");
    const c = new FakeClient();
    hub.connect(c);
    await tick(3_000);
    expect(warnings.some((w) => /node status could not be computed/.test(w))).toBe(true);
    expect(c.closed).toBe(false);
    nodes.failWith = null;
    await tick(1_000);
    expect(c.of("node").length).toBeGreaterThan(0); // the snapshot arrives as soon as it can be computed
  });

  it("drops a client that cannot keep up, and the others carry on", async () => {
    const hub = make();
    const slow = new FakeClient();
    const fine = new FakeClient();
    hub.connect(slow);
    hub.connect(fine);
    await tick(0);
    slow.accepting = false;
    feed.queue.push(change());
    await tick(HUB_DEFAULTS.pollMs);
    expect(slow.closed).toBe(true);
    expect(hub.clientCount).toBe(1);
    expect(fine.of("stock")).toHaveLength(1);
  });

  it("refuses connections beyond its limit", () => {
    const hub = make({ maxClients: 2 });
    expect(hub.connect(new FakeClient())).toBeTypeOf("function");
    expect(hub.connect(new FakeClient())).toBeTypeOf("function");
    expect(hub.connect(new FakeClient())).toBeNull();
    expect(hub.clientCount).toBe(2);
    hub.stop();
  });
});

// ------------------------------------------------------------ over HTTP

describe("GET /api/stream over HTTP", () => {
  const apps: FastifyInstance[] = [];
  const aborts: AbortController[] = [];
  afterEach(async () => {
    aborts.splice(0).forEach((a) => a.abort());
    // fetch keeps a spare, never-used connection that Node's close() would wait ~4 s for (a test-client artifact, not a browser's).
    await Promise.all(apps.splice(0).map(async (a) => (a.server.closeAllConnections(), a.close())));
  });

  async function serve(hubOver: Partial<ConstructorParameters<typeof LiveHub>[0]> = {}) {
    const feed = new FakeFeed();
    const nodes = new FakeNodes();
    const hub = new LiveHub({ stock: feed, nodes: nodes.read, pollMs: 20, nodePollMs: 60_000, heartbeatMs: 60_000, ...hubOver });
    const app = await buildApp(noDb, config, { logger: false, stream: { hub }, nodes: {} });
    apps.push(app);
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    return { app, hub, feed, nodes, url };
  }
  async function open(url: string, headers: Record<string, string> = {}) {
    const ctl = new AbortController();
    aborts.push(ctl);
    const res = await fetch(`${url}/api/stream`, { headers, signal: ctl.signal });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (pred: (events: Parsed[]) => boolean, ms = 2_000) => {
      const stop = Date.now() + ms;
      while (!pred(parseFrames(text))) {
        if (Date.now() > stop) throw new Error(`timed out; received: ${JSON.stringify(text)}`);
        const r = await Promise.race([reader!.read(), new Promise<null>((res) => setTimeout(() => res(null), 50))]);
        if (r && !r.done) text += decoder.decode(r.value);
        if (r?.done) break;
      }
      return parseFrames(text);
    };
    return { res, ctl, until, reader: reader!, text: () => text };
  }
  const waitFor = async (pred: () => boolean, ms = 2_000) => {
    const stop = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > stop) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("answers as an event stream, unbuffered and uncached, and confirms the connection", async () => {
    const { url } = await serve();
    const s = await open(url, { origin: "http://localhost:3000" });
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(s.res.headers.get("cache-control")).toMatch(/no-cache/);
    expect(s.res.headers.get("x-accel-buffering")).toBe("no");
    expect(s.res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const events = await s.until((e) => e.some((x) => x.event === "connected"));
    expect(events.find((e) => e.event === "connected")!.data).toMatchObject({ version: 1, resync: false });
    expect(s.text().startsWith("retry: 3000")).toBe(true);
  });

  it("delivers a stock change and the node snapshot to the browser", async () => {
    const { url, feed } = await serve();
    const s = await open(url);
    await s.until((e) => e.filter((x) => x.event === "node").length === 2);
    feed.queue.push(change({ medicineCode: "M042", quantity: 11 }));
    const events = await s.until((e) => e.some((x) => x.event === "stock"));
    expect(events.find((e) => e.event === "stock")!.data).toMatchObject({ pharmacyCode: "P001", medicineCode: "M042", quantity: 11 });
  });

  it("sends heartbeats", async () => {
    const { url } = await serve({ heartbeatMs: 30 });
    const s = await open(url);
    const events = await s.until((e) => e.filter((x) => x.event === "heartbeat").length >= 2);
    expect(events.filter((e) => e.event === "heartbeat").length).toBeGreaterThanOrEqual(2);
  });

  it("serves several browsers at once, and ordinary API requests are not held up", async () => {
    const { url, feed, hub } = await serve();
    const [a, b] = await Promise.all([open(url), open(url)]);
    await Promise.all([a.until((e) => e.some((x) => x.event === "connected")), b.until((e) => e.some((x) => x.event === "connected"))]);
    expect(hub.clientCount).toBe(2);
    const started = Date.now();
    const health = await fetch(`${url}/api/nodes`);
    expect(health.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    feed.queue.push(change({ quantity: 4 }));
    const [ea, eb] = await Promise.all([a.until((e) => e.some((x) => x.event === "stock")), b.until((e) => e.some((x) => x.event === "stock"))]);
    expect(ea.find((e) => e.event === "stock")!.id).toBe(eb.find((e) => e.event === "stock")!.id);
  });

  it("releases the connection and the hub's timers when the browser disconnects", async () => {
    const { url, hub } = await serve();
    const s = await open(url);
    await s.until((e) => e.some((x) => x.event === "connected"));
    expect(hub.clientCount).toBe(1);
    expect(hub.running).toBe(true);
    s.ctl.abort();
    await waitFor(() => hub.clientCount === 0);
    expect(hub.running).toBe(false);
  });

  it("replays missed events when the browser reconnects with Last-Event-ID", async () => {
    const { url, feed } = await serve();
    const first = await open(url);
    feed.queue.push(change({ quantity: 1 }));
    const seen = await first.until((e) => e.some((x) => x.event === "stock"));
    const lastId = seen.find((e) => e.event === "stock")!.id!;
    first.ctl.abort();
    feed.queue.push(change({ quantity: 2 }));
    const second = await open(url, { "last-event-id": lastId });
    const events = await second.until((e) => e.some((x) => x.event === "stock"));
    expect(events.find((e) => e.event === "connected")!.data.resync).toBe(false);
    expect(events.filter((e) => e.event === "stock").map((e) => e.data.quantity)).toEqual([2]);
  });

  it("refuses a connection over the limit with a normal JSON error", async () => {
    const { url } = await serve({ maxClients: 1 });
    const a = await open(url);
    await a.until((e) => e.some((x) => x.event === "connected"));
    const res = await fetch(`${url}/api/stream`);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("STREAM_FULL");
  });

  it("does not stop the server from shutting down while streams are open", async () => {
    const { app, hub, url } = await serve();
    const s = await open(url);
    await s.until((e) => e.some((x) => x.event === "connected"));
    await Promise.race([app.close(), new Promise((_, rej) => setTimeout(() => rej(new Error("close() hung with an open stream")), 3_000))]);
    expect(hub.clientCount).toBe(0);
  });
});

// --------------------------------------------- the real Redis feed

describe("RedisStockFeed (real Redis, unique key prefix)", () => {
  let redis: Redis;
  let prefix: string;
  let feed: RedisStockFeed;
  let clock: number;
  beforeAll(() => {
    redis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  });
  beforeEach(() => {
    prefix = `test-${randomUUID().slice(0, 8)}`;
    clock = Date.now();
    feed = new RedisStockFeed(redis, { pharmacyCodes: () => ["P001", "P002"], keyPrefix: prefix, confirmTimeoutMs: 5_000, now: () => clock });
  });
  afterEach(async () => {
    await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  });
  afterAll(() => redis.disconnect());

  const eventOf = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    eventId: randomUUID(),
    pharmacyId: "P001",
    medicineId: "M001",
    eventType: "SALE",
    quantityDelta: -2,
    quantityAfter: 8,
    timestamp: new Date().toISOString(),
    ...over,
  });
  const publish = async (e: Record<string, unknown>, code = String(e.pharmacyId)) => redis.xadd(eventStreamKey(code, prefix), "*", "event", JSON.stringify(e));
  const processed = (e: { eventId?: unknown; pharmacyId?: unknown }) => redis.set(dedupKey(String(e.pharmacyId), String(e.eventId), prefix), "done");

  it("starts at the end of each stream: history is never replayed to a browser", async () => {
    await publish(eventOf());
    expect(await feed.poll()).toEqual([]);
    expect(await feed.poll()).toEqual([]);
  });

  it("releases a change only after the sync service has marked it done, exactly once", async () => {
    await feed.poll();
    const e = eventOf({ quantityAfter: 6, price: 12.5 });
    await publish(e);
    expect(await feed.poll()).toEqual([]); // published, not processed yet
    await processed(e);
    expect(await feed.poll()).toEqual([{ eventId: e.eventId, pharmacyCode: "P001", medicineCode: "M001", eventType: "SALE", quantity: 6, price: 12.5, occurredAt: e.timestamp }]);
    expect(await feed.poll()).toEqual([]); // not again
  });

  it("keeps events in order: a later one waits for an earlier one that is not done yet", async () => {
    await feed.poll();
    const first = eventOf({ quantityAfter: 1 });
    const second = eventOf({ quantityAfter: 2 });
    await publish(first);
    await publish(second);
    await processed(second);
    expect(await feed.poll()).toEqual([]);
    await processed(first);
    expect((await feed.poll()).map((c) => c.quantity)).toEqual([1, 2]);
  });

  it("gives up on an event the sync service never confirms, so it cannot hold back the rest", async () => {
    await feed.poll();
    const stuck = eventOf({ quantityAfter: 1 });
    const next = eventOf({ quantityAfter: 2 });
    await publish(stuck);
    await publish(next);
    await processed(next);
    expect(await feed.poll()).toEqual([]);
    clock += 6_000;
    expect((await feed.poll()).map((c) => c.quantity)).toEqual([2]);
    expect(feed.stats().unconfirmed).toBe(1);
  });

  it("skips malformed, unsupported and foreign entries without stopping, and counts them", async () => {
    await feed.poll();
    await redis.xadd(eventStreamKey("P001", prefix), "*", "event", "{not json");
    await redis.xadd(eventStreamKey("P001", prefix), "*", "other", "field");
    await publish(eventOf({ schemaVersion: 99 }));
    await publish(eventOf({ eventType: "NOPE" }));
    await publish(eventOf({ pharmacyId: "P002" }), "P001"); // a P002 event on P001's stream: never passed on
    const good = eventOf({ quantityAfter: 3 });
    await publish(good);
    await processed(good);
    expect((await feed.poll()).map((c) => c.quantity)).toEqual([3]);
    expect(feed.stats().malformed).toBe(5);
  });

  it("carries no quantity for a price update, and keeps pharmacies apart", async () => {
    await feed.poll();
    const price = eventOf({ eventType: "PRICE_UPDATED", price: 40, quantityDelta: undefined, quantityAfter: undefined });
    const other = eventOf({ pharmacyId: "P002", quantityAfter: 5 });
    await publish(price);
    await publish(other);
    await processed(price);
    await processed(other);
    const out = await feed.poll();
    expect(out.find((c) => c.pharmacyCode === "P001")).toMatchObject({ eventType: "PRICE_UPDATED", quantity: null, price: 40 });
    expect(out.find((c) => c.pharmacyCode === "P002")).toMatchObject({ quantity: 5, price: null });
    expect(JSON.stringify(out)).not.toMatch(/quantityDelta/);
  });

  it("does not disturb the sync service's consumer group: nothing is delivered, acknowledged or claimed on its behalf", async () => {
    const stream = eventStreamKey("P001", prefix);
    await feed.poll();
    const e1 = eventOf({ quantityAfter: 1 });
    const e2 = eventOf({ quantityAfter: 2 });
    await publish(e1);
    await publish(e2);
    await redis.xgroup("CREATE", stream, "inventory-sync", "0");
    await redis.xreadgroup("GROUP", "inventory-sync", "worker-1", "COUNT", 1, "STREAMS", stream, ">"); // e1 delivered, not acknowledged
    const snapshot = async () => ({ groups: await redis.xinfo("GROUPS", stream), pending: await redis.xpending(stream, "inventory-sync") });
    const before = await snapshot();
    await processed(e1);
    await processed(e2);
    for (let i = 0; i < 3; i++) await feed.poll();
    expect(await snapshot()).toEqual(before);
    expect(await redis.xlen(stream)).toBe(2); // nothing deleted either
  });

  it("fails (so the caller retries) when Redis cannot be read", async () => {
    const dead = createRedis({ url: "redis://127.0.0.1:1", failFast: true, onError: () => undefined });
    try {
      await expect(new RedisStockFeed(dead, { pharmacyCodes: () => ["P001"], keyPrefix: prefix }).poll()).rejects.toThrow();
    } finally {
      dead.disconnect();
    }
  });
});
