import { pharmacyIdFromStreamKey, streamRegistryKey } from "@medlink/event-schema";
import { describeError, type Redis } from "@medlink/redis";
import type { EventHandler } from "./handler.js";
import type { Logger } from "./logger.js";
import { StreamWorker, type WorkerOptions, type WorkerStats } from "./stream-worker.js";

export interface SyncOptions extends WorkerOptions {
  /** How often to look for newly registered pharmacy streams. */
  discoveryIntervalMs: number;
  /**
   * stop() waits at most this long for in-flight work. Needed because consumers retry Redis commands forever,
   * so with Redis down a loop can be stuck on a command that never completes.
   */
  shutdownTimeoutMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  group: "inventory-sync",
  consumer: `consumer-${process.pid}`,
  batchSize: 50,
  blockMs: 2000,
  minIdleMs: 10_000,
  claimIntervalMs: 5000,
  maxDeliveries: 5,
  deadLetterMaxLen: 10_000,
  discoveryIntervalMs: 3000,
  shutdownTimeoutMs: 5000,
};

/** Resolves when `p` settles or after `ms`, whichever comes first. */
export const boundedWait = (p: Promise<unknown> | null, ms: number): Promise<unknown> =>
  p ? Promise.race([p, new Promise((resolve) => setTimeout(resolve, ms).unref())]) : Promise.resolve();

/**
 * Redis Streams -> handler.
 * Discovers each pharmacy's stream from the registry and runs one StreamWorker per stream, so a slow or
 * failing pharmacy never holds up the others. Several instances can run in the same consumer group:
 * Redis hands each entry to exactly one of them.
 */
export class SyncService {
  private readonly workers = new Map<string, { worker: StreamWorker; blocking: Redis }>();
  /** Registry keys that are not pharmacy streams; remembered so we warn about each only once. */
  private readonly ignored = new Set<string>();
  private readonly opts: SyncOptions;
  private stopping = false;
  private discovery: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly handler: EventHandler,
    private readonly logger: Logger,
    opts: Partial<SyncOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SYNC_OPTIONS, ...opts };
  }

  start(): void {
    if (this.discovery) return;
    this.stopping = false;
    this.discovery = this.discoverLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await boundedWait(this.discovery, this.opts.shutdownTimeoutMs);
    this.discovery = null;
    await Promise.all([...this.workers.values()].map(({ worker }) => worker.stop(this.opts.shutdownTimeoutMs)));
    this.workers.clear();
  }

  /** Counters summed over all workers. */
  stats(): WorkerStats & { streams: number } {
    const total = { processed: 0, deadLettered: 0, retriedFailures: 0, streams: this.workers.size };
    for (const { worker } of this.workers.values()) {
      total.processed += worker.stats.processed;
      total.deadLettered += worker.stats.deadLettered;
      total.retriedFailures += worker.stats.retriedFailures;
    }
    return total;
  }

  private async discoverLoop(): Promise<void> {
    this.logger.info({ group: this.opts.group, consumer: this.opts.consumer }, "sync service started");
    while (!this.stopping) {
      try {
        const keys = await this.redis.smembers(streamRegistryKey(this.opts.keyPrefix));
        for (const key of keys) if (!this.workers.has(key) && !this.ignored.has(key)) this.addWorker(key);
      } catch (err) {
        if (!this.stopping) this.logger.error({ error: (err as Error).message }, "stream discovery failed; will retry");
      }
      if (!this.stopping) await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.discoveryIntervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    this.logger.info({}, "sync service stopped");
  }

  private addWorker(streamKey: string): void {
    const pharmacyId = pharmacyIdFromStreamKey(streamKey);
    if (!pharmacyId) {
      this.logger.warn({ streamKey }, "registry lists a key that is not a pharmacy event stream; ignored");
      this.ignored.add(streamKey);
      return;
    }
    const blocking = this.redis.duplicate();
    blocking.on("error", (err) => this.logger.warn({ stream: streamKey, error: describeError(err) }, "redis connection error"));
    const worker = new StreamWorker(streamKey, pharmacyId, this.redis, blocking, this.handler, this.logger, this.opts);
    this.workers.set(streamKey, { worker, blocking });
    worker.start();
    this.logger.info({ stream: streamKey, pharmacyId }, "consuming stream");
  }
}
