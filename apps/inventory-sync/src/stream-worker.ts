import {
  deadLetterKey,
  parseInventoryEvent,
  STREAM_EVENT_FIELD,
  type InventoryEvent,
} from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";
import type { EventHandler } from "./handler.js";
import type { Logger } from "./logger.js";

export interface WorkerOptions {
  group: string;
  consumer: string;
  batchSize: number;
  /** How long a read waits for new entries before looping (also how often `stop` is noticed). */
  blockMs: number;
  /** An entry pending (delivered, not acknowledged) for this long is retried / taken over. */
  minIdleMs: number;
  claimIntervalMs: number;
  /** After this many delivery attempts an entry is dead-lettered instead of retried. */
  maxDeliveries: number;
  keyPrefix?: string;
  deadLetterMaxLen: number;
}

export interface WorkerStats {
  processed: number;
  deadLettered: number;
  retriedFailures: number;
}

interface Entry {
  id: string;
  /** null if the entry was trimmed from the stream while still pending. */
  fields: string[] | null;
}

/**
 * Consumes ONE pharmacy's stream through a consumer group.
 *
 *  new entries   XREADGROUP ... >          -> handle -> XACK
 *  failures      left pending; XAUTOCLAIM re-delivers them after `minIdleMs` (also covers a crashed consumer)
 *  poison        invalid event, or too many failed attempts -> dead-letter stream, then XACK
 *
 * An entry is acknowledged only after it was fully handled (or dead-lettered), so a crash can cause a
 * re-delivery but never a lost event: delivery is at-least-once. Handlers must therefore tolerate duplicates.
 */
export class StreamWorker {
  readonly stats: WorkerStats = { processed: 0, deadLettered: 0, retriedFailures: 0 };
  private stopping = false;
  private done: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  /**
   * @param commands  shared connection for ordinary commands
   * @param blocking  a connection dedicated to this worker, because XREADGROUP BLOCK occupies it
   */
  constructor(
    private readonly streamKey: string,
    private readonly pharmacyId: string,
    private readonly commands: Redis,
    private readonly blocking: Redis,
    private readonly handler: EventHandler,
    private readonly logger: Logger,
    private readonly opts: WorkerOptions,
  ) {}

  start(): void {
    if (!this.done) this.done = this.loop();
  }

  async stop(timeoutMs = 5000): Promise<void> {
    this.stopping = true;
    this.wake?.();
    this.blocking.disconnect(); // aborts a read that is blocked waiting for entries
    if (this.done) {
      await Promise.race([this.done, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
    }
    this.done = null;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    let lastClaim = 0;
    let groupReady = false;
    while (!this.stopping) {
      try {
        if (!groupReady) {
          await this.ensureGroup();
          groupReady = true;
        }
        if (Date.now() - lastClaim >= this.opts.claimIntervalMs) {
          await this.claimStale();
          lastClaim = Date.now();
        }
        for (const entry of await this.readNew()) await this.process(entry, 1);
        failures = 0;
      } catch (err) {
        if (this.stopping) break;
        failures++;
        const delay = Math.min(5000, 200 * 2 ** Math.min(failures, 5));
        this.logger.error({ stream: this.streamKey, failures, retryInMs: delay, error: (err as Error).message }, "stream worker error");
        await this.sleep(delay);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** Creates the group at the very beginning of the stream, so events published before we first ran are not skipped. */
  private async ensureGroup(): Promise<void> {
    try {
      await this.commands.xgroup("CREATE", this.streamKey, this.opts.group, "0", "MKSTREAM");
      this.logger.info({ stream: this.streamKey, group: this.opts.group }, "consumer group created");
    } catch (err) {
      if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
    }
  }

  private async readNew(): Promise<Entry[]> {
    const res = (await this.blocking.xreadgroup(
      "GROUP", this.opts.group, this.opts.consumer,
      "COUNT", this.opts.batchSize,
      "BLOCK", this.opts.blockMs,
      "STREAMS", this.streamKey, ">",
    )) as [string, [string, string[]][]][] | null;
    return (res?.[0]?.[1] ?? []).map(([id, fields]) => ({ id, fields }));
  }

  /** Takes over entries that were delivered but never acknowledged for at least `minIdleMs`, and retries them. */
  private async claimStale(): Promise<void> {
    let cursor = "0-0";
    do {
      const res = (await this.commands.xautoclaim(
        this.streamKey, this.opts.group, this.opts.consumer, this.opts.minIdleMs, cursor, "COUNT", this.opts.batchSize,
      )) as unknown as [string, [string, string[] | null][], string[]?];
      cursor = res[0];
      const claimed: Entry[] = res[1].map(([id, fields]) => ({ id, fields }));
      // Entries trimmed away while pending are reported as deleted; nothing left to process.
      for (const id of res[2] ?? []) await this.ack(id);
      if (claimed.length === 0) continue;

      const deliveries = await this.deliveryCounts(claimed.map((e) => e.id));
      for (const entry of claimed) {
        if (this.stopping) return;
        await this.process(entry, deliveries.get(entry.id) ?? 1);
      }
    } while (cursor !== "0-0" && !this.stopping);
  }

  /** Exact delivery count per entry (one XPENDING per id, pipelined). */
  private async deliveryCounts(ids: string[]): Promise<Map<string, number>> {
    const pipeline = this.commands.pipeline();
    for (const id of ids) pipeline.xpending(this.streamKey, this.opts.group, id, id, 1);
    const results = (await pipeline.exec()) ?? [];
    const counts = new Map<string, number>();
    results.forEach(([err, rows], i) => {
      if (err) throw err;
      const row = (rows as [string, string, number, number][])[0];
      if (row) counts.set(ids[i]!, row[3]);
    });
    return counts;
  }

  private async process(entry: Entry, deliveries: number): Promise<void> {
    const log = { stream: this.streamKey, streamId: entry.id, deliveries };

    if (entry.fields === null) {
      await this.ack(entry.id);
      return;
    }
    if (deliveries > this.opts.maxDeliveries) {
      await this.deadLetter(entry, `failed after ${this.opts.maxDeliveries} delivery attempts`, "MAX_DELIVERIES");
      return;
    }

    const event = this.decode(entry);
    if ("reason" in event) {
      await this.deadLetter(entry, event.reason, event.code);
      return;
    }

    const started = Date.now();
    try {
      await this.handler.handle(event, { streamId: entry.id, deliveries });
    } catch (err) {
      // Leave it pending: it will be re-delivered after minIdleMs.
      this.stats.retriedFailures++;
      this.logger.warn({ ...log, eventId: event.eventId, error: (err as Error).message }, "event handling failed; will retry");
      return;
    }
    await this.ack(entry.id);
    this.stats.processed++;
    this.logger.info(
      {
        ...log,
        eventId: event.eventId,
        eventType: event.eventType,
        pharmacyId: event.pharmacyId,
        medicineId: event.medicineId,
        syncLatencyMs: Date.now() - Date.parse(event.timestamp),
        handlerMs: Date.now() - started,
      },
      "event processed",
    );
  }

  private decode(entry: Entry): InventoryEvent | { reason: string; code: string } {
    const fields = entry.fields!;
    const at = fields.indexOf(STREAM_EVENT_FIELD);
    const raw = at >= 0 ? fields[at + 1] : undefined;
    if (raw === undefined) return { code: "MALFORMED", reason: `entry has no "${STREAM_EVENT_FIELD}" field` };

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { code: "MALFORMED", reason: "entry is not valid JSON" };
    }
    const parsed = parseInventoryEvent(json);
    if (!parsed.success) return { code: parsed.code, reason: parsed.errors.join("; ") };
    if (parsed.event.pharmacyId !== this.pharmacyId) {
      return { code: "INVALID", reason: `event for ${parsed.event.pharmacyId} found in the stream of ${this.pharmacyId}` };
    }
    return parsed.event;
  }

  /** Keeps the entry for inspection in the dead-letter stream, then acknowledges it so it stops being retried. */
  private async deadLetter(entry: Entry, reason: string, code: string): Promise<void> {
    const fields = entry.fields ?? [];
    const at = fields.indexOf(STREAM_EVENT_FIELD);
    await this.commands.xadd(
      deadLetterKey(this.opts.keyPrefix), "MAXLEN", "~", this.opts.deadLetterMaxLen, "*",
      "stream", this.streamKey,
      "group", this.opts.group, // several services read the same streams; say which one gave up
      "entryId", entry.id,
      "code", code,
      "reason", reason,
      "payload", at >= 0 ? (fields[at + 1] ?? "") : JSON.stringify(fields),
      "deadAt", new Date().toISOString(),
    );
    await this.ack(entry.id);
    this.stats.deadLettered++;
    this.logger.error({ stream: this.streamKey, streamId: entry.id, code, reason }, "event dead-lettered");
  }

  private async ack(id: string): Promise<void> {
    await this.commands.xack(this.streamKey, this.opts.group, id);
  }
}
