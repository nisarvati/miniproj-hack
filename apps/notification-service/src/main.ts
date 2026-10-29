import { hostname } from "node:os";
import { createPool, healthPortFor, probe, startHealthServer, type HealthCheck } from "@medlink/db";
import { createRedis, describeError, redisOptionsFromEnv } from "@medlink/redis";
import { createLogger } from "./logger.js";
import { loadEmailConfig } from "./config.js";
import { createGmailTransport } from "./mailer.js";
import { EmailNotifier, MockNotifier, type Notifier } from "./notifier.js";
import { DEFAULT_NOTIFICATION_OPTIONS, NotificationService } from "./service.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "info");
const num = (name: string, fallback: number) => (process.env[name] ? Number(process.env[name]) : fallback);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error({}, "DATABASE_URL is not set");
  process.exit(1);
}
let redisConnection: ReturnType<typeof redisOptionsFromEnv>;
try {
  redisConnection = redisOptionsFromEnv();
} catch (err) {
  logger.error({ error: describeError(err) }, "invalid Redis configuration");
  process.exit(1);
}

const db = createPool(databaseUrl);
db.on("error", (err) => logger.error({ error: describeError(err) }, "idle database client error"));
const redis = createRedis({
  ...redisConnection,
  name: "notification-service",
  onError: (err) => logger.error({ error: describeError(err) }, "redis connection error"),
});

// Email is off unless EMAIL_DELIVERY_ENABLED=true. Enabled but incomplete: nothing is sent, nothing is marked delivered, and
// the reason is logged (setting names only, never values). The in-app notifications are unaffected either way.
const email = loadEmailConfig();
let notifier: Notifier;
if (!email.enabled) {
  notifier = new MockNotifier(logger);
  logger.info({}, "email delivery is disabled (EMAIL_DELIVERY_ENABLED is not true): notifications are simulated, no email is sent");
} else if (email.problems.length) {
  notifier = new EmailNotifier(logger, { transport: null, from: email.from, appUrl: email.appUrl, problems: email.problems });
  logger.error({ problems: email.problems }, "email delivery is enabled but not configured: no email will be sent and notifications stay pending until it is");
} else {
  notifier = new EmailNotifier(logger, { transport: createGmailTransport(email), from: email.from, appUrl: email.appUrl });
  logger.info({ from: email.from, appUrl: email.appUrl }, "email delivery is enabled (Gmail SMTP)");
}

const service = new NotificationService(db, redis, notifier, logger, {
  keyPrefix: process.env.REDIS_KEY_PREFIX,
  consumer: process.env.NOTIFY_CONSUMER ?? `${hostname()}-${process.pid}`,
  sweepIntervalMs: num("NOTIFY_SWEEP_INTERVAL_MS", DEFAULT_NOTIFICATION_OPTIONS.sweepIntervalMs),
  minIdleMs: num("NOTIFY_MIN_IDLE_MS", 10_000),
  maxDeliveries: num("NOTIFY_MAX_DELIVERIES", 5),
});
service.start();

// Email mode for the health report: states and setting NAMES only, never a value.
const emailMode = !email.enabled ? "disabled" : email.problems.length ? "unconfigured" : "enabled";
const check: HealthCheck = async () => {
  const redisState = await probe(() => redis.ping());
  let pending: number | null = null;
  const postgres = await probe(async () => {
    const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM notifications WHERE delivered_at IS NULL");
    pending = Number(rows[0]!.n);
  });
  return {
    dependencies: { redis: redisState, postgres },
    details: { emailDelivery: emailMode, emailProblems: email.problems, pendingNotifications: pending, ...service.stats() },
    hints: emailMode === "unconfigured" ? [`email delivery is enabled but incomplete (${email.problems.join("; ")}): alerts stay pending until it is fixed`] : [],
  };
};
const healthPort = healthPortFor("notification-service");
if (healthPort !== null) await startHealthServer({ service: "notification-service", port: healthPort, check, onProblem: (m) => logger.warn({}, m) });
void check().then((r) => {
  const down = Object.entries(r.dependencies).filter(([, s]) => s === "down").map(([n]) => n);
  if (down.length) logger.warn({ unreachable: down }, "notification-service started, but cannot reach everything it needs: it keeps retrying");
  else logger.info({ emailDelivery: emailMode, pendingNotifications: r.details?.pendingNotifications, healthPort }, "notification-service ready: Redis and PostgreSQL answered");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    logger.info({ signal, ...service.stats() }, "shutting down");
    await service.stop();
    redis.disconnect();
    await db.end();
    process.exit(0);
  });
}
