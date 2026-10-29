import type { Db } from "@medlink/db";
import { toEvent, type OutboxRow } from "./convert.js";
import type { Logger } from "./logger.js";
import type { EventPublisher } from "./publisher.js";

export interface ConnectorOptions {
  /** Which pharmacy this connector serves, e.g. "P001". Checked against the database it is pointed at. */
  pharmacyId: string;
  /** Connection to that pharmacy's own database. */
  db: Db;
  publisher: EventPublisher;
  logger: Logger;
  batchSize?: number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
}

export interface CycleResult {
  published: number;
  /** Rows that could not be turned into a valid event and were parked. */
  failed: number;
}

/**
 * Pharmacy DB (outbox) -> standardized event -> publisher.
 *
 * Delivery guarantees:
 *  - at-least-once: a row is marked published only after the publisher accepted its event, so a crash
 *    between the two re-sends the same event (same eventId). Consumers de-duplicate on eventId (M8).
 *  - in order of recording, per connector. Several connectors on one database are safe (SKIP LOCKED) but
 *    then ordering across them is not guaranteed.
 * The connector only reads the pharmacy's database and calls the publisher; it never writes MedLink state.
 */
export class InventoryConnector {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxBackoffMs: number;
  private verified = false;
  private stopping = false;
  private loopDone: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private lastCycleAt: number | null = null;
  private failures = 0;

  constructor(private readonly opts: ConnectorOptions) {
    this.batchSize = opts.batchSize ?? 50;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  }

  private get log() {
    return this.opts.logger;
  }

  /** Refuses to run against a database that belongs to a different pharmacy. */
  private async verifyIdentity(): Promise<void> {
    const { rows } = await this.opts.db.query<{ pharmacy_code: string }>("SELECT pharmacy_code FROM pharmacy_profile");
    const actual = rows[0]?.pharmacy_code;
    if (actual !== this.opts.pharmacyId) {
      throw new Error(`Database belongs to pharmacy ${actual ?? "(unknown)"}, but this connector is configured for ${this.opts.pharmacyId}`);
    }
    this.verified = true;
  }

  /** Publishes up to one batch of pending changes. Throws if the database or publisher fails. */
  async runOnce(): Promise<CycleResult> {
    if (!this.verified) await this.verifyIdentity();
    const { pharmacyId, publisher } = this.opts;
    const result: CycleResult = { published: 0, failed: 0 };
    let publishError: unknown = null;

    const client = await this.opts.db.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, event_id, event_type, medicine_code, quantity_delta, quantity_after, price, occurred_at
         FROM outbox
         WHERE published_at IS NULL AND failed_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );

      for (const row of rows) {
        let event;
        try {
          event = toEvent(row, pharmacyId);
        } catch (err) {
          // A row that can never become a valid event must not block everything behind it.
          const message = (err as Error).message;
          await client.query("UPDATE outbox SET failed_at = now(), error = $2 WHERE id = $1", [row.id, message]);
          result.failed++;
          this.log.error({ pharmacyId, outboxId: row.id, eventId: row.event_id, error: message }, "outbox row is not a valid event; parked");
          continue;
        }

        try {
          await publisher.publish(event);
        } catch (err) {
          publishError = err; // keep what was already published, retry this row and the rest next cycle
          break;
        }
        await client.query("UPDATE outbox SET published_at = now() WHERE id = $1", [row.id]);
        result.published++;
        this.log.info(
          { pharmacyId, eventId: event.eventId, eventType: event.eventType, medicineId: event.medicineId, lagMs: Date.now() - row.occurred_at.getTime() },
          "event published",
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (publishError) {
      this.log.error({ pharmacyId, published: result.published, error: (publishError as Error).message }, "publish failed; will retry");
      throw publishError;
    }
    return result;
  }

  /** How the polling loop is doing: when a cycle last succeeded and how many in a row have failed. For health reporting only. */
  get status(): { pharmacyId: string; lastCycleAt: number | null; consecutiveFailures: number } {
    return { pharmacyId: this.opts.pharmacyId, lastCycleAt: this.lastCycleAt, consecutiveFailures: this.failures };
  }

  /** Starts polling. Failures are logged and retried with exponential backoff; the loop never crashes the process. */
  start(): void {
    if (this.loopDone) return;
    this.stopping = false;
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loopDone;
    this.loopDone = null;
  }

  private async loop(): Promise<void> {
    let failures = 0;
    this.log.info({ pharmacyId: this.opts.pharmacyId, pollIntervalMs: this.pollIntervalMs }, "connector started");
    while (!this.stopping) {
      let delay = this.pollIntervalMs;
      try {
        const r = await this.runOnce();
        failures = 0;
        this.failures = 0;
        this.lastCycleAt = Date.now();
        if (r.published + r.failed >= this.batchSize) delay = 0; // more is probably waiting
      } catch (err) {
        failures++;
        this.failures = failures;
        delay = Math.min(this.maxBackoffMs, this.pollIntervalMs * 2 ** Math.min(failures, 10));
        this.log.error({ pharmacyId: this.opts.pharmacyId, failures, retryInMs: delay, error: (err as Error).message }, "connector cycle failed");
      }
      if (delay > 0 && !this.stopping) await this.sleep(delay);
    }
    this.log.info({ pharmacyId: this.opts.pharmacyId }, "connector stopped");
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
}
