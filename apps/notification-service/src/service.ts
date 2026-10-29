import type { Db } from "@medlink/db";
import { SyncService, type SyncOptions } from "@medlink/inventory-sync";
import type { Redis } from "@medlink/redis";
import { RestockNotificationHandler } from "./handler.js";
import type { Logger } from "./logger.js";
import type { Notifier } from "./notifier.js";
import { deliverPending } from "./store.js";

/**
 * The notifier reads the same per-pharmacy streams as inventory-sync, through its OWN consumer group: every event
 * reaches both, and neither slows or retries the other.
 */
export const NOTIFIER_GROUP = "restock-notifier";

export interface NotificationOptions {
  /** How often stored-but-unsent notifications are sent (covers a crash between "stored" and "sent"). */
  sweepIntervalMs: number;
}

export const DEFAULT_NOTIFICATION_OPTIONS: NotificationOptions = { sweepIntervalMs: 5000 };

export class NotificationService {
  readonly handler: RestockNotificationHandler;
  private readonly sync: SyncService;
  private readonly opts: NotificationOptions;
  private timer: NodeJS.Timeout | null = null;
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    redis: Redis,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    opts: Partial<NotificationOptions & SyncOptions> = {},
  ) {
    const { sweepIntervalMs, ...syncOpts } = opts;
    this.opts = { sweepIntervalMs: sweepIntervalMs ?? DEFAULT_NOTIFICATION_OPTIONS.sweepIntervalMs };
    this.handler = new RestockNotificationHandler(db, notifier, logger);
    this.sync = new SyncService(redis, this.handler, logger, { group: NOTIFIER_GROUP, ...syncOpts });
  }

  start(): void {
    if (this.timer) return;
    this.sync.start();
    void this.sweep(); // anything left over from before a restart
    this.timer = setInterval(() => void this.sweep(), this.opts.sweepIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.sync.stop();
    await this.sweeping;
  }

  stats() {
    return { ...this.sync.stats(), ...this.handler.stats };
  }

  /** One pass over the stored-but-unsent notifications. Passes never overlap. */
  sweep(): Promise<void> {
    this.sweeping ??= (async () => {
      try {
        const n = await deliverPending(this.db, this.notifier, this.logger);
        if (n > 0) this.logger.info({ delivered: n }, "sent pending notifications");
      } catch (err) {
        this.logger.warn({ error: (err as Error).message }, "sweep failed; will retry");
      } finally {
        this.sweeping = null;
      }
    })();
    return this.sweeping;
  }
}
