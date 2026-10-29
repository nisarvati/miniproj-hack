import type { InventoryEvent } from "@medlink/event-schema";

/**
 * Where the connector sends standardized events. The connector never touches MedLink's inventory state
 * directly; it only hands events to a publisher. (See RedisStreamPublisher for the real transport.)
 *
 * Contract: resolve only once the event has been durably accepted; reject otherwise.
 * Delivery is at-least-once, so the same event may be published again after a failure.
 */
export interface EventPublisher {
  publish(event: InventoryEvent): Promise<void>;
}

/** Collects events in memory. For tests and local experiments. */
export class MemoryPublisher implements EventPublisher {
  readonly events: InventoryEvent[] = [];
  async publish(event: InventoryEvent): Promise<void> {
    this.events.push(event);
  }
}
