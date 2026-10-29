/**
 * ============================================================================
 * Module: MedLink Restock Notification & Alert Dispatcher
 * Component: Restock Notification Event Handler (Concrete Observer)
 * Design Patterns:
 *   1. Observer Pattern (Concrete Observer implementing EventHandler)
 *   2. Strategy Pattern (Collaborates with pluggable Notifier strategy)
 *
 * Coding Standards:
 *   - Clear descriptive variable & method names
 *   - "Why" documentation explaining architectural decisions and error boundaries
 *   - Loose coupling and high cohesion
 * ============================================================================
 */

import type { Db } from "@medlink/db";
import type { InventoryEvent } from "@medlink/event-schema";
import type { EventHandler } from "@medlink/inventory-sync";
import type { Logger } from "./logger.js";
import type { Notifier } from "./notifier.js";
import { detectRestock } from "./restock.js";
import { deliverPending, fulfilSubscriptions } from "./store.js";

/**
 * ----------------------------------------------------------------------------
 * DESIGN PATTERN: OBSERVER PATTERN (Concrete Observer)
 * ----------------------------------------------------------------------------
 * Intent:
 *   Define a one-to-many dependency between objects so that when one object
 *   changes state, all its dependents are notified and updated automatically.
 *
 * Role in System:
 *   - Subject / Observable: Redis Streams & Pharmacy Outbox event bus.
 *   - Observer Interface: `EventHandler` (defined in `@medlink/inventory-sync`).
 *   - Concrete Observer: `RestockNotificationHandler`.
 *
 * Why Observer Pattern is essential here:
 *   1. Decouples inventory writes from alert side-effects: The pharmacy selling
 *      or restocking medicine doesn't need to know who is subscribed or how
 *      they are notified. It simply emits domain events.
 *   2. Independent consumer scaling: Notification processing runs in its own
 *      consumer group without adding latency to core inventory searches.
 */
export class RestockNotificationHandler implements EventHandler {
  /** Internal operational metrics for telemetry and monitoring. */
  readonly stats = {
    restocks: 0,
    get restocksDetected() {
      return this.restocks;
    },
    notificationsCreated: 0,
  };

  constructor(
    private readonly databaseClient: Db,
    private readonly notificationStrategy: Notifier,
    private readonly logger: Logger,
  ) {}

  /**
   * Processes an incoming inventory domain event.
   *
   * @param event The inventory event deserialized from Redis Streams.
   */
  async handle(event: InventoryEvent): Promise<void> {
    // Step 1: Filter domain events. Only RESTOCK with positive quantity qualifies.
    const restock = detectRestock(event);
    if (!restock) {
      return;
    }
    this.stats.restocks++;

    // Step 2: Atomically transition active subscriptions to NOTIFIED status.
    //
    // Why failures here MUST throw:
    // If the database transaction fails, throwing allows the stream worker to
    // retry the event (or route to Dead-Letter Queue after MAX_DELIVERIES).
    // Because fulfilSubscriptions uses atomic conditional SQL updates, retries
    // are completely idempotent and safe.
    const fulfilled = await fulfilSubscriptions(this.databaseClient, restock);
    if (fulfilled.length === 0) {
      return;
    }

    this.stats.notificationsCreated += fulfilled.length;
    this.logger.info(
      {
        eventId: restock.eventId,
        medicineCode: restock.medicineCode,
        pharmacyCode: restock.pharmacyCode,
        subscribersFulfilled: fulfilled.length,
      },
      "restock fulfilled waiting subscriptions successfully",
    );

    // Step 3: Immediate dispatch attempt.
    //
    // Why errors in immediate delivery are caught rather than thrown:
    // Subscriptions have already been safely converted into persistent notifications.
    // If external delivery channels (SMTP/SMS) fail here, we must NOT retry the
    // Redis event (which would find 0 active subscriptions). Instead, a scheduled
    // background sweep will pick up pending notifications where delivered_at is NULL.
    try {
      await deliverPending(this.databaseClient, this.notificationStrategy, this.logger);
    } catch (deliveryError) {
      this.logger.warn(
        { error: (deliveryError as Error).message },
        "immediate notification dispatch failed; background sweep will retry",
      );
    }
  }
}

