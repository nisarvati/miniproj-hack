import { randomUUID } from "node:crypto";
import type { NodesResponse, NodeStatusEntry } from "../nodes/service.js";
import type { StockChange, StockFeed } from "./feed.js";

/** Version of every event payload below. A client ignores a version it does not know. */
export const LIVE_EVENT_VERSION = 1;

export interface StockPayload extends StockChange {
  version: typeof LIVE_EVENT_VERSION;
}

export interface NodePayload {
  version: typeof LIVE_EVENT_VERSION;
  node: NodeStatusEntry;
  /** Where the readings came from, so a client can say "status unavailable" instead of showing stale numbers as current. */
  meta: Pick<NodesResponse["meta"], "generatedAt" | "redis" | "connector" | "syncService">;
}

/** One connected browser. `send` returns false when the connection cannot keep up. */
export interface ClientSink {
  send(frame: string): boolean;
  close(): void;
}

export interface HubOptions {
  stock: StockFeed;
  /** The Milestone 1 node status. Computed once per tick for everyone, never per client. */
  nodes: () => Promise<NodesResponse>;
  /** How often the stream feed is read while anyone is connected. */
  pollMs?: number;
  /** How often node status is recomputed while anyone is connected. */
  nodePollMs?: number;
  /** After stock changes, node counters have moved: recompute soon (once, however many changes). */
  nodeAfterStockMs?: number;
  heartbeatMs?: number;
  /** How many recent events are kept for Last-Event-ID replay. */
  bufferSize?: number;
  maxClients?: number;
  log?: { warn(obj: object, msg: string): void };
}

export const HUB_DEFAULTS = { pollMs: 500, nodePollMs: 5_000, nodeAfterStockMs: 750, heartbeatMs: 15_000, bufferSize: 200, maxClients: 100 } as const;

interface Client {
  sink: ClientSink;
  snapshotSent: boolean;
}

const frame = (event: string, data: unknown, id?: string) => `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** Everything in a node reading that is worth telling a client about. syncLagMs grows every second, so it never counts as a change. */
const nodeFingerprint = (n: NodeStatusEntry) => JSON.stringify({ ...n, syncLagMs: null });

/**
 * One shared fan-out for every browser connected to GET /api/stream. All the work (reading the Redis streams, computing node status,
 * the heartbeat timer) happens once per tick, however many clients are connected, and only while at least one is: with nobody
 * connected there are no timers and no Redis traffic.
 *
 * Delivery is at-most-once per connection, in order, with no exactly-once claim. Recent events are kept in memory for Last-Event-ID
 * replay; when the id is unknown (server restarted, or older than the buffer) the `connected` event says `resync: true` and the
 * client reloads from the API, which is always the truth.
 */
export class LiveHub {
  /** Identifies this run of the server. Event ids are "<bootId>.<n>", so an id from before a restart is recognised and not trusted. */
  readonly bootId = randomUUID().slice(0, 8);
  private readonly opts: Required<Omit<HubOptions, "log" | "stock" | "nodes">> & Pick<HubOptions, "log" | "stock" | "nodes">;
  private readonly clients = new Set<Client>();
  private buffer: { seq: number; frame: string }[] = [];
  private seq = 0;
  private timers: NodeJS.Timeout[] = [];
  private nodeTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private refreshing = false;
  private nodeSnapshot = new Map<string, string>();
  private latest: NodesResponse | null = null;
  private generation = 0;

  constructor(opts: HubOptions) {
    this.opts = { ...HUB_DEFAULTS, ...opts };
  }

  get clientCount(): number {
    return this.clients.size;
  }
  get running(): boolean {
    return this.timers.length > 0;
  }
  get maxClients(): number {
    return this.opts.maxClients;
  }

  /**
   * Adds a client. null: the server is full. Sends `connected`, replays what the client missed, and (once node status is known)
   * the current state of every node. The returned function removes the client; call it when the connection closes.
   */
  connect(sink: ClientSink, lastEventId?: string): (() => void) | null {
    if (this.clients.size >= this.opts.maxClients) return null;
    const client: Client = { sink, snapshotSent: false };
    this.clients.add(client);

    const missed = this.missedSince(lastEventId);
    const resync = lastEventId !== undefined && missed === null;
    this.deliver(client, frame("connected", { version: LIVE_EVENT_VERSION, bootId: this.bootId, resync, heartbeatMs: this.opts.heartbeatMs, at: new Date().toISOString() }));
    for (const m of missed ?? []) if (!this.deliver(client, m.frame)) break;
    if (this.latest && this.clients.has(client)) this.sendSnapshot(client, this.latest);

    if (this.clients.has(client)) this.start();
    return () => this.remove(client);
  }

  /** Ends every connection and stops all timers. */
  stop(): void {
    for (const c of [...this.clients]) this.remove(c);
    this.halt();
  }

  // ----------------------------------------------------------------- internals

  /** The events after `lastEventId`, or null when they cannot be replayed (unknown id, other boot, or fallen out of the buffer). */
  private missedSince(lastEventId: string | undefined): { seq: number; frame: string }[] | null {
    if (lastEventId === undefined) return [];
    const m = /^([a-z0-9]+)\.(\d+)$/.exec(lastEventId);
    if (!m || m[1] !== this.bootId) return null;
    const last = Number(m[2]);
    if (last > this.seq) return null;
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (last < oldest - 1) return null; // something after `last` has already been dropped from the buffer
    return this.buffer.filter((e) => e.seq > last);
  }

  private start(): void {
    if (this.running) return;
    const generation = ++this.generation;
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.opts.pollMs, () => void this.pollStock(generation));
    every(this.opts.nodePollMs, () => void this.refreshNodes(generation));
    every(this.opts.heartbeatMs, () => this.broadcast(frame("heartbeat", { version: LIVE_EVENT_VERSION, at: new Date().toISOString() })));
    void this.refreshNodes(generation); // the first reading: also the current state for whoever just connected
  }

  private halt(): void {
    this.generation++;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.nodeTimer) clearTimeout(this.nodeTimer);
    this.nodeTimer = null;
    this.nodeSnapshot.clear();
    this.latest = null;
  }

  private remove(client: Client): void {
    if (!this.clients.delete(client)) return;
    try {
      client.sink.close();
    } catch {
      /* already closed */
    }
    if (this.clients.size === 0) this.halt();
  }

  /** false: the client was dropped (it cannot keep up, or its connection is gone). */
  private deliver(client: Client, text: string): boolean {
    let ok = false;
    try {
      ok = client.sink.send(text);
    } catch {
      ok = false;
    }
    if (!ok) this.remove(client);
    return ok;
  }

  private broadcast(text: string, only?: (c: Client) => boolean): void {
    for (const c of [...this.clients]) if (!only || only(c)) this.deliver(c, text);
  }

  /** An event that is kept for replay and sent to everyone. */
  private publish(event: string, data: unknown, only?: (c: Client) => boolean): void {
    const seq = ++this.seq;
    const text = frame(event, data, `${this.bootId}.${seq}`);
    this.buffer.push({ seq, frame: text });
    if (this.buffer.length > this.opts.bufferSize) this.buffer.splice(0, this.buffer.length - this.opts.bufferSize);
    this.broadcast(text, only);
  }

  private async pollStock(generation: number): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const changes = await this.opts.stock.poll();
      if (generation !== this.generation) return; // everyone left while we were reading
      for (const change of changes) this.publish("stock", { version: LIVE_EVENT_VERSION, ...change } satisfies StockPayload);
      if (changes.length > 0) this.scheduleNodeRefresh(generation);
    } catch (err) {
      // Redis trouble must not end the stream or the process: say so once per failure and try again on the next tick.
      this.opts.log?.warn({ err: (err as Error).message }, "live stock feed could not be read; retrying");
    } finally {
      this.polling = false;
    }
  }

  private scheduleNodeRefresh(generation: number): void {
    if (this.nodeTimer) return;
    this.nodeTimer = setTimeout(() => {
      this.nodeTimer = null;
      void this.refreshNodes(generation);
    }, this.opts.nodeAfterStockMs);
    this.nodeTimer.unref?.();
  }

  private async refreshNodes(generation: number): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const reading = await this.opts.nodes();
      if (generation !== this.generation) return;
      this.latest = reading;
      const baseline = this.nodeSnapshot.size > 0;
      for (const node of reading.data) {
        const fingerprint = nodeFingerprint(node);
        const changed = this.nodeSnapshot.get(node.pharmacyCode) !== fingerprint;
        this.nodeSnapshot.set(node.pharmacyCode, fingerprint);
        // Clients that already have a snapshot hear about changes; the others are about to get the full state below.
        if (baseline && changed) this.publish("node", this.nodePayload(node, reading), (c) => c.snapshotSent);
      }
      for (const c of [...this.clients]) if (!c.snapshotSent) this.sendSnapshot(c, reading);
    } catch (err) {
      this.opts.log?.warn({ err: (err as Error).message }, "live node status could not be computed; retrying");
    } finally {
      this.refreshing = false;
    }
  }

  private nodePayload(node: NodeStatusEntry, reading: NodesResponse): NodePayload {
    const { generatedAt, redis, connector, syncService } = reading.meta;
    return { version: LIVE_EVENT_VERSION, node, meta: { generatedAt, redis, connector, syncService } };
  }

  /** The current state of every node, for a client that has just connected. Not kept for replay. */
  private sendSnapshot(client: Client, reading: NodesResponse): void {
    client.snapshotSent = true;
    for (const node of reading.data) if (!this.deliver(client, frame("node", this.nodePayload(node, reading)))) return;
  }
}
