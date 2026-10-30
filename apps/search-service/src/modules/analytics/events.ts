import { eventStreamKey } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";

export interface EventHistory {
  /** When each retained stream entry for a pharmacy was published, within [fromMs, toMs]. `truncated`: more entries existed than `cap`. */
  read(pharmacyCode: string, fromMs: number, toMs: number, cap: number): Promise<{ times: number[]; truncated: boolean }>;
}

/**
 * Entry ids of the per-pharmacy event stream. A stream id starts with the millisecond the connector published the event, so counting ids needs no
 * payload parsing and exposes nothing about an event. This is plain XRANGE: no consumer group, no acknowledgement, nothing deleted. What it counts is
 * PUBLISHED events that the stream still retains (it is trimmed to a maximum length), not events the sync service has processed.
 */
export class RedisEventHistory implements EventHistory {
  constructor(
    private readonly redis: Redis,
    private readonly opts: { keyPrefix?: string } = {},
  ) {}

  async read(pharmacyCode: string, fromMs: number, toMs: number, cap: number) {
    const entries = (await this.redis.xrange(eventStreamKey(pharmacyCode, this.opts.keyPrefix), String(fromMs), String(toMs), "COUNT", cap + 1)) as [string, string[]][];
    const times = entries.slice(0, cap).map(([id]) => Number(id.split("-")[0]));
    return { times: times.filter(Number.isFinite), truncated: entries.length > cap };
  }
}
