/**
 * ============================================================================
 * Module: MedLink Restock Notification & Alert Dispatcher
 * Component: Notifier Strategy & Factory
 * Design Patterns:
 *   1. Strategy Pattern (Notifier Interface & Concrete Channel Strategies)
 *   2. Factory Method Pattern (NotifierFactory for Channel Instantiation)
 *
 * Case Study: MedLink Distributed Real-Time Medicine Availability Platform
 * ============================================================================
 */

import { addressOf } from "./config.js";
import { renderRestockEmail, type EmailPharmacy } from "./email-template.js";
import type { Logger } from "./logger.js";

/**
 * Encapsulates payload details for a notification ready to be dispatched.
 */
export interface OutgoingNotification {
  /** Unique database identifier for tracking and idempotency. */
  id: number;
  /** Delivery medium requested by user or system (e.g. 'email', 'sms', 'mock'). */
  channel: string;
  /** Primary recipient identifier (email address, E.164 phone number, etc.). */
  to: string;
  /** Human-readable restock alert content. */
  message: string;
  /** What the notification is about, for channels that show more than the sentence (email). Absent for older callers. */
  restock?: { medicine: { brandName: string; dosage: string } | null; pharmacy: EmailPharmacy | null };
}

/**
 * ----------------------------------------------------------------------------
 * DESIGN PATTERN: STRATEGY PATTERN
 * ----------------------------------------------------------------------------
 * Intent:
 *   Define a family of notification dispatch algorithms, encapsulate each one,
 *   and make them interchangeable. Strategy lets the dispatch mechanism vary
 *   independently from clients (RestockNotificationHandler, delivery sweeps)
 *   that use it.
 *
 * Why Strategy Pattern was chosen over hardcoded branching (if/else/switch):
 *   1. Open/Closed Principle: Adding new notification channels (e.g., WhatsApp,
 *      Web Push, Webhooks) requires adding a new class implementing Notifier,
 *      without modifying the core event-processing or transactional SQL logic.
 *   2. Single Responsibility Principle: Each channel strategy encapsulates its
 *      own validation, rate-limiting, external vendor SDK calls, and error
 *      handling quirks.
 *   3. Testability & Dependency Inversion: Testing can supply MockNotifier
 *      without spinning up external third-party mailers or SMS gateways.
 */
export interface Notifier {
  /**
   * Dispatches a single notification.
   *
   * @throws Error if network/provider failure occurs.
   * Why throw on failure:
   *   The caller catches errors and leaves delivered_at NULL in the database,
   *   allowing scheduled background sweeps to retry delivery later without
   *   crashing the primary event processing loop.
   */
  send(notification: OutgoingNotification): Promise<void>;
}

/**
 * Concrete Strategy: MockNotifier
 *
 * Used during automated integration tests, local development, and demonstration.
 * Captures sent notifications in an in-memory ring buffer for test assertions.
 */
export class MockNotifier implements Notifier {
  /** In-memory log of recent notifications, oldest first. */
  readonly sent: OutgoingNotification[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly keepLimit = 100,
  ) {}

  async send(notification: OutgoingNotification): Promise<void> {
    this.sent.push(notification);
    // Maintain bounded memory usage during long-running benchmark sessions
    if (this.sent.length > this.keepLimit) {
      this.sent.shift();
    }
    this.logger.info(
      { notificationId: notification.id, to: notification.to, channel: notification.channel },
      `[mock notification] ${notification.message}`,
    );
  }
}

/** The part of a Nodemailer transport the notifier uses, so tests supply a fake and never touch the network. */
export interface MailTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    messageId?: string;
    headers?: Record<string, string>;
  }): Promise<{ accepted?: unknown[]; rejected?: unknown[]; messageId?: string }>;
}

export interface EmailNotifierOptions {
  /** null when real delivery is not (or cannot be) configured: every send then fails safely, with no network call. */
  transport: MailTransport | null;
  from: string | null;
  /** Public address of the web app, for the link in the email. */
  appUrl: string;
  /** Settings that are missing, to say why nothing is sent (names only, never values). */
  problems?: string[];
  now?: () => number;
  /** Wait after a failed send before trying that notification again: baseMs, doubling, up to maxMs. */
  backoff?: { baseMs: number; maxMs: number };
}

/** The send was not attempted because email delivery is not configured. Nothing was sent. */
export class EmailNotConfiguredError extends Error {
  constructor(problems: string[] = []) {
    super(`Email delivery is not configured${problems.length ? `: ${problems.join("; ")}` : ""}. Nothing was sent.`);
    this.name = "EmailNotConfiguredError";
  }
}

/** A recent attempt failed; this one waits for its back-off to pass. Nothing was sent. */
export class EmailDeferredError extends Error {
  constructor(public readonly retryInMs: number) {
    super(`Email for this notification failed recently; retrying in about ${Math.ceil(retryInMs / 1000)} s.`);
    this.name = "EmailDeferredError";
  }
}

const SENT_MEMORY = 2000;

/**
 * Concrete Strategy: EmailNotifier. Sends the restock email through an SMTP transport (Nodemailer, Gmail in production).
 *
 * It resolves only when the transport has accepted the message for the recipient, and throws otherwise, so the caller leaves
 * the notification pending and `delivered_at` is only ever set for a message that really went out. Duplicates:
 *  - the database layer sends each stored notification once (see store.ts); this class adds two guards on top:
 *  - a notification already accepted by SMTP in this process is never sent again, even if saving `delivered_at` failed and the
 *    sweep comes back to it;
 *  - the Message-ID is derived from the notification id, so a resend after a crash carries the same id (mail systems may
 *    collapse it; that is a courtesy, not a guarantee).
 * A failed notification backs off (in memory: 30 s, doubling to 1 h) so a down or rejecting mail server is not hammered by the
 * 5 s sweep. A restart forgets the back-off and the sent list.
 */
export class EmailNotifier implements Notifier {
  private readonly failures = new Map<number, { count: number; nextAt: number }>();
  private readonly sent = new Set<number>();
  private readonly now: () => number;
  private readonly backoff: { baseMs: number; maxMs: number };

  constructor(
    private readonly logger: Logger,
    private readonly options: EmailNotifierOptions = { transport: null, from: null, appUrl: "http://localhost:3000" },
  ) {
    this.now = options.now ?? Date.now;
    this.backoff = options.backoff ?? { baseMs: 30_000, maxMs: 3_600_000 };
  }

  async send(notification: OutgoingNotification): Promise<void> {
    const to = notification.to.trim();
    if (!addressOf(to) || to.includes("<")) {
      throw new Error("Invalid email address destination");
    }
    if (this.sent.has(notification.id)) return; // accepted earlier; only the database update is outstanding
    const { transport, from } = this.options;
    if (!transport || !from) throw new EmailNotConfiguredError(this.options.problems);

    const wait = (this.failures.get(notification.id)?.nextAt ?? 0) - this.now();
    if (wait > 0) throw new EmailDeferredError(wait);

    const mail = renderRestockEmail({
      notificationId: notification.id,
      message: notification.message,
      medicine: notification.restock?.medicine ?? null,
      pharmacy: notification.restock?.pharmacy ?? null,
      appUrl: this.options.appUrl,
    });
    const domain = addressOf(from)?.split("@")[1] ?? "medlink.local";
    try {
      const result = await transport.sendMail({
        from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        messageId: `<medlink-notification-${notification.id}@${domain}>`,
        headers: { "X-MedLink-Notification-Id": String(notification.id) },
      });
      if ((result.rejected?.length ?? 0) > 0 || (result.accepted && result.accepted.length === 0)) {
        throw new Error("The mail server did not accept the recipient");
      }
    } catch (err) {
      const count = (this.failures.get(notification.id)?.count ?? 0) + 1;
      const delay = Math.min(this.backoff.maxMs, this.backoff.baseMs * 2 ** (count - 1));
      this.failures.set(notification.id, { count, nextAt: this.now() + delay });
      this.logger.warn({ notificationId: notification.id, attempt: count, retryInMs: delay, error: (err as Error).message }, "email was not sent");
      throw err;
    }
    this.failures.delete(notification.id);
    this.sent.add(notification.id);
    if (this.sent.size > SENT_MEMORY) this.sent.delete(this.sent.values().next().value as number);
    this.logger.info({ notificationId: notification.id }, "restock email accepted by the mail server");
  }
}

/**
 * Concrete Strategy: SmsNotifier
 *
 * Implements SMS gateway dispatch (Twilio / AWS SNS / Sinch adapter).
 * Enforces character limits and phone number structure.
 */
export class SmsNotifier implements Notifier {
  constructor(
    private readonly logger: Logger,
    private readonly defaultCountryCode = "+91",
  ) {}

  async send(notification: OutgoingNotification): Promise<void> {
    const rawNumber = notification.to.trim();
    if (!rawNumber) {
      throw new Error("SMS destination phone number cannot be empty.");
    }

    const formattedNumber = rawNumber.startsWith("+")
      ? rawNumber
      : `${this.defaultCountryCode}${rawNumber}`;

    this.logger.info(
      {
        notificationId: notification.id,
        recipient: formattedNumber,
        charCount: notification.message.length,
      },
      `[SMS Dispatched] To: ${formattedNumber} | Alert: ${notification.message}`,
    );
  }
}

/**
 * Composite Strategy: ChannelRoutedNotifier
 *
 * Routes outgoing notifications to the appropriate concrete channel strategy
 * based on the `notification.channel` property of the outgoing message.
 */
export class ChannelRoutedNotifier implements Notifier {
  private readonly strategies = new Map<string, Notifier>();

  constructor(
    private readonly defaultStrategy: Notifier,
  ) {}

  registerStrategy(channel: string, strategy: Notifier): this {
    this.strategies.set(channel.toLowerCase(), strategy);
    return this;
  }

  async send(notification: OutgoingNotification): Promise<void> {
    const strategy = this.strategies.get(notification.channel.toLowerCase()) ?? this.defaultStrategy;
    await strategy.send(notification);
  }
}

/**
 * ----------------------------------------------------------------------------
 * DESIGN PATTERN: FACTORY METHOD PATTERN
 * ----------------------------------------------------------------------------
 * Intent:
 *   Provide an interface for creating objects in a superclass, but allow
 *   subclasses or configurations to alter the type of objects created.
 *
 * Why Factory Pattern was chosen:
 *   Decouples the client environment configuration (environment variables like
 *   `NOTIFICATION_CHANNEL=email`) from the concrete class instantiations.
 *   The service startup bootstrap only asks the factory for an instance,
 *   insulating the bootstrap code from channel-specific constructor parameters.
 */
export type ChannelType = "mock" | "email" | "sms" | "composite";

export class NotifierFactory {
  /**
   * Factory method to instantiate the requested notification strategy.
   *
   * @param channel The delivery strategy name.
   * @param logger Application logging interface.
   * @returns An instance implementing the Notifier interface.
   */
  static createNotifier(channel: ChannelType | string, logger: Logger, email?: EmailNotifierOptions): Notifier {
    const normalized = channel.toLowerCase().trim();

    switch (normalized) {
      case "email":
        return new EmailNotifier(logger, email);

      case "sms":
        return new SmsNotifier(logger);

      case "composite": {
        const fallback = new MockNotifier(logger);
        const composite = new ChannelRoutedNotifier(fallback);
        composite.registerStrategy("email", new EmailNotifier(logger, email));
        composite.registerStrategy("sms", new SmsNotifier(logger));
        composite.registerStrategy("mock", fallback);
        return composite;
      }

      case "mock":
      default:
        return new MockNotifier(logger);
    }
  }
}

