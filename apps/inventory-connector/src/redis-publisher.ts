import { DEFAULT_KEY_PREFIX, eventStreamKey, STREAM_EVENT_FIELD, streamRegistryKey, type InventoryEvent } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";
import type { EventPublisher } from "./publisher.js";

export interface RedisStreamPublisherOptions {
  keyPrefix?: string;
  /**
   * Approximate cap on entries kept per pharmacy stream (XADD MAXLEN ~). Entries are not deleted when
   * consumed, so this bounds memory; it must comfortably exceed what a stalled consumer could fall behind by.
   */
  maxLen?: number;
}

/** Appends each event to its pharmacy's Redis stream. XADD succeeding = the event is accepted by Redis. */
export class RedisStreamPublisher implements EventPublisher {
  private readonly prefix: string;
  private readonly maxLen: number;
  private readonly registered = new Set<string>();

  constructor(
    private readonly redis: Redis,
    opts: RedisStreamPublisherOptions = {},
  ) {
    this.prefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.maxLen = opts.maxLen ?? 100_000;
  }

  async publish(event: InventoryEvent): Promise<void> {
    const key = eventStreamKey(event.pharmacyId, this.prefix);
    // Register before appending: if XADD then fails, the registry just lists an empty stream.
    // The reverse order could strand an event in a stream no consumer knows about.
    if (!this.registered.has(key)) {
      await this.redis.sadd(streamRegistryKey(this.prefix), key);
      this.registered.add(key);
    }
    await this.redis.xadd(key, "MAXLEN", "~", this.maxLen, "*", STREAM_EVENT_FIELD, JSON.stringify(event));
  }
}
