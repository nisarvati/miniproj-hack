/**
 * The restock-to-email workflow at its real boundaries, in an ISOLATED test environment: the `<db>_test` PostgreSQL databases
 * (never the development ones) and a random Redis key prefix (never the `medlink` keys the running services use).
 *
 *   subscribe (search API) -> persisted waiting subscription
 *   portal quantity change (portal API) -> pharmacy database + outbox (trigger)
 *   connector -> Redis stream -> notification service -> subscription match -> notification row
 *   EmailNotifier -> a FAKE SMTP transport (no mail leaves this process; nothing contacts Gmail)
 *
 * What this is and is not: the HTTP apps, the databases, Redis and the connector / notification-service classes are real; the
 * connector and notification service run inside this test process (startEmbeddedPipeline), not as the separate `npm run ...:start`
 * processes, so it cannot detect a service that was never started. That failure is covered by the "service missing" tests below,
 * which leave a component out and show what that looks like, and by `npm run services:status` on a running system.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, importCatalogue, readCatalogueBatch, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { eventStreamKey, STREAM_EVENT_FIELD } from "@medlink/event-schema";
import { EmailNotifier, silentLogger, type MailTransport } from "@medlink/notification-service";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { buildApp as buildPortal } from "../apps/pharmacy-portal/src/app.js";
import { hashPassword } from "../apps/pharmacy-portal/src/auth.js";
import { loadConfig as loadPortalConfig } from "../apps/pharmacy-portal/src/config.js";
import { startEmbeddedPipeline, type Component, type EmbeddedPipeline } from "../apps/pharmacy-simulator/src/index.js";
import { buildApp as buildSearch } from "../apps/search-service/src/app.js";
import { loadConfig as loadSearchConfig } from "../apps/search-service/src/config.js";

vi.setConfig({ testTimeout: 30_000 });

const CODES = ["P001", "P002", "P003", "P004", "P005"];
const EMAIL = "waiting@example.com";
let central: Db;
let urls: Record<string, string>;
let pools: Record<string, Db>;
let redis: Redis;
let prefix: string;
let pipeline: EmbeddedPipeline | null = null;
let search: FastifyInstance;
let portal: FastifyInstance;
let cookie: string;
let smtp: FakeSmtp;
let ids: { crocin: number; dolo: number };

class FakeSmtp implements MailTransport {
  sent: Parameters<MailTransport["sendMail"]>[0][] = [];
  failures = 0;
  async sendMail(m: Parameters<MailTransport["sendMail"]>[0]) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("SMTP unavailable (simulated)");
    }
    this.sent.push(m);
    return { accepted: [m.to], rejected: [] };
  }
}

const subscribe = (email: string, medicineId: number) => search.inject({ method: "POST", url: "/api/restock-subscriptions", payload: { email, medicineId } });
const subscriptions = async (email: string) => (await search.inject({ method: "GET", url: `/api/restock-subscriptions?email=${email}` })).json().data as { status: string; medicine: { id: number } }[];
const notifications = async (email: string) => (await search.inject({ method: "GET", url: `/api/notifications?email=${email}` })).json().data as { message: string; deliveredAt: string | null }[];
const portalPatch = (code: string, payload: object) => portal.inject({ method: "PATCH", url: `/portal/stock/${code}`, headers: { cookie }, payload });
const outbox = async (where: string) => Number((await pools.P004!.query(`SELECT count(*) AS n FROM outbox WHERE ${where}`)).rows[0].n);
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** A pipeline whose notifications go through the REAL EmailNotifier into the FAKE transport (or into none, if unconfigured). */
const boot = async (opts: { start?: Component[]; transport?: MailTransport | null } = {}) => {
  const transport = opts.transport === undefined ? smtp : opts.transport;
  const notifier = new EmailNotifier(silentLogger, { transport, from: transport ? "MedLink <medlink@example.com>" : null, appUrl: "http://localhost:3000", problems: transport ? [] : ["SMTP_PASS is not set"], backoff: { baseMs: 150, maxMs: 300 } });
  pipeline = await startEmbeddedPipeline({
    pharmacies: pools,
    central,
    notifier,
    keyPrefix: prefix,
    pollIntervalMs: 20,
    sweepIntervalMs: 100,
    sync: { blockMs: 100, minIdleMs: 300, claimIntervalMs: 100 },
    ...(opts.start && { start: opts.start }),
  });
};

beforeAll(async () => {
  central = await freshSeededDb();
  await importCatalogue(central, readCatalogueBatch());
  urls = await freshPharmacyDbs(central);
  pools = Object.fromEntries(CODES.map((c) => [c, createPool(urls[c]!)]));
  ids = {
    crocin: Number((await central.query("SELECT id FROM medicines WHERE code = 'M001'")).rows[0].id),
    dolo: Number((await central.query("SELECT id FROM medicines WHERE code = 'M002'")).rows[0].id),
  };
});
afterAll(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await central.end();
});
beforeEach(async () => {
  prefix = `test-${randomUUID().slice(0, 8)}`;
  smtp = new FakeSmtp();
  await central.query("TRUNCATE notifications, restock_subscriptions, users, pharmacy_users RESTART IDENTITY CASCADE");
  for (const code of CODES) {
    await pools[code]!.query("TRUNCATE outbox");
    await pools[code]!.query("DELETE FROM inventory");
    await pools[code]!.query("TRUNCATE outbox");
    await setupPharmacyDatabase(code, urls[code]!); // starting stock: P004 has no Crocin 500mg (quantity 0)
  }
  await pools.P004!.query("TRUNCATE outbox"); // the starting-stock snapshot is not part of what is being tested
  await central.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('staff@p004.test', $1, 'P004')", [await hashPassword("pw")]);
  redis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  const searchConfig = loadSearchConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
  search = await buildSearch(central, searchConfig, { logger: false });
  portal = await buildPortal({ db: central, pharmacies: pools }, loadPortalConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" }), { logger: false });
  cookie = String((await portal.inject({ method: "POST", url: "/portal/login", payload: { email: "staff@p004.test", password: "pw" } })).headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => {
  await pipeline?.stop();
  pipeline = null;
  await Promise.all([search.close(), portal.close()]);
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  redis.disconnect();
});

describe("subscription through the API", () => {
  it("a valid subscription is accepted and persisted as a waiting subscription; an invalid one is refused", async () => {
    expect((await subscribe(EMAIL, ids.crocin)).statusCode).toBe(201);
    expect(await subscriptions(EMAIL)).toMatchObject([{ status: "ACTIVE", medicine: { id: ids.crocin } }]);
    expect((await subscribe("not-an-email", ids.crocin)).statusCode).toBe(400);
    expect((await subscribe(EMAIL, 999_999)).statusCode).toBe(404);
  });
});

describe("a portal restock reaches the subscriber's email (fake SMTP)", () => {
  it("zero to positive: one RESTOCK, one email naming the medicine and the pharmacy, and delivery recorded only after SMTP accepted it", async () => {
    await boot();
    await subscribe(EMAIL, ids.crocin);
    await settle(60);

    const res = await portalPatch("M001", { quantity: 12 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.events).toEqual(["RESTOCK"]);
    expect(await outbox("event_type = 'RESTOCK'")).toBe(1);

    await waitFor(() => smtp.sent.length === 1, "the email");
    expect(smtp.sent[0]).toMatchObject({ to: EMAIL, subject: "Crocin 500mg is back in stock on MedLink" });
    expect(smtp.sent[0]!.text).toContain("Bandra Medical Stores");
    expect(smtp.sent[0]!.text).toContain("Inventory shown is simulated");
    expect(smtp.sent[0]!.html).toContain("Stock changes quickly");

    await waitFor(async () => (await notifications(EMAIL))[0]?.deliveredAt != null, "delivery to be recorded");
    expect(await subscriptions(EMAIL)).toMatchObject([{ status: "NOTIFIED" }]);
    await waitFor(async () => (await outbox("event_type = 'RESTOCK' AND published_at IS NOT NULL")) === 1, "the connector to mark the event published");
  });

  it("a sale, or an unrelated medicine, does not trigger a restock email", async () => {
    await boot();
    await portalPatch("M001", { quantity: 12 });
    await settle(400);
    smtp.sent.length = 0;
    await subscribe(EMAIL, ids.crocin);
    await settle(60);
    expect((await portalPatch("M001", { quantity: 5 })).json().data.events).toEqual(["SALE"]);
    await settle(700);
    expect(smtp.sent).toHaveLength(0);
    expect(await subscriptions(EMAIL)).toMatchObject([{ status: "ACTIVE" }]);
  });

  it("a subscription for a different medicine does not match", async () => {
    await boot();
    await subscribe(EMAIL, ids.dolo);
    await settle(60);
    await portalPatch("M001", { quantity: 12 });
    await settle(900);
    expect(smtp.sent).toHaveLength(0);
    expect(await subscriptions(EMAIL)).toMatchObject([{ status: "ACTIVE" }]);
  });

  it("someone who subscribes after a restock is not sent that old restock, but is sent the next one", async () => {
    await boot();
    await portalPatch("M001", { quantity: 12 });
    await settle(500);
    await subscribe(EMAIL, ids.crocin);
    await settle(700);
    expect(smtp.sent).toHaveLength(0);
    await portalPatch("M001", { quantity: 0 });
    await settle(150);
    await portalPatch("M001", { quantity: 6 });
    await waitFor(() => smtp.sent.length === 1, "the email for the next restock");
  });

  it("a duplicated stream entry (retry or replay) does not send a second email", async () => {
    await boot();
    await subscribe(EMAIL, ids.crocin);
    await settle(60);
    await portalPatch("M001", { quantity: 12 });
    await waitFor(() => smtp.sent.length === 1, "the first email");
    const entries = await redis.xrange(eventStreamKey("P004", prefix), "-", "+");
    const restock = entries.map(([, f]) => f[1]!).find((e) => JSON.parse(e).eventType === "RESTOCK")!;
    await redis.xadd(eventStreamKey("P004", prefix), "*", STREAM_EVENT_FIELD, restock); // the same eventId again, in the TEST prefix only
    await settle(900);
    expect(smtp.sent).toHaveLength(1);
    expect(await notifications(EMAIL)).toHaveLength(1);
  });
});

describe("delivery failures and configuration", () => {
  it("an SMTP failure leaves the notification pending, then it is sent once after the back-off", async () => {
    smtp.failures = 1;
    await boot();
    await subscribe(EMAIL, ids.crocin);
    await settle(60);
    await portalPatch("M001", { quantity: 12 });
    await waitFor(async () => (await notifications(EMAIL)).length === 1, "the notification to be stored");
    expect(smtp.sent).toHaveLength(0);
    expect((await notifications(EMAIL))[0]!.deliveredAt).toBeNull(); // pending, not "delivered"
    await waitFor(() => smtp.sent.length === 1, "the retry");
    await waitFor(async () => (await notifications(EMAIL))[0]?.deliveredAt != null, "delivery to be recorded");
    await settle(600);
    expect(smtp.sent).toHaveLength(1); // never twice
  });

  it("with email unconfigured nothing is sent and the alert stays pending, never reported as delivered", async () => {
    await boot({ transport: null });
    await subscribe(EMAIL, ids.crocin);
    await settle(60);
    await portalPatch("M001", { quantity: 12 });
    await waitFor(async () => (await notifications(EMAIL)).length === 1, "the notification to be stored");
    await settle(700);
    expect(smtp.sent).toHaveLength(0);
    expect((await notifications(EMAIL))[0]!.deliveredAt).toBeNull();
  });
});

describe("a service that is not running is visible, and nothing is lost", () => {
  it("with no connector, the event stays unpublished in the pharmacy's outbox and nothing is emailed; starting it delivers", async () => {
    await boot({ start: ["sync", "notifications"] });
    await subscribe(EMAIL, ids.crocin);
    await settle(60);
    await portalPatch("M001", { quantity: 12 });
    await settle(900);
    expect(await outbox("event_type = 'RESTOCK' AND published_at IS NULL")).toBe(1); // the symptom `services:status` reports as events waiting
    expect(await redis.xlen(eventStreamKey("P004", prefix))).toBe(0);
    expect(smtp.sent).toHaveLength(0);

    pipeline!.startComponent("connector");
    await waitFor(() => smtp.sent.length === 1, "the email after the connector started");
    expect(await outbox("event_type = 'RESTOCK' AND published_at IS NULL")).toBe(0);
  });

  it("with no notification service, the event is published and waits in the stream; starting it delivers once", async () => {
    await boot({ start: ["connector", "sync"] });
    await subscribe(EMAIL, ids.crocin);
    await settle(60);
    await portalPatch("M001", { quantity: 12 });
    await waitFor(async () => (await outbox("event_type = 'RESTOCK' AND published_at IS NOT NULL")) === 1, "the connector to publish");
    await settle(600);
    expect(smtp.sent).toHaveLength(0);
    expect(await notifications(EMAIL)).toEqual([]);

    pipeline!.startComponent("notifications");
    await waitFor(() => smtp.sent.length === 1, "the email after the notification service started");
    await settle(500);
    expect(smtp.sent).toHaveLength(1);
  });
});
