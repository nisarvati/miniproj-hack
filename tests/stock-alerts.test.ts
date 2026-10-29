/**
 * Low-stock alerts follow the stock that travels the pipeline, stay staff-only, and never become patient notifications:
 *
 *   portal sale / restock -> pharmacy database (stock, outbox, movement) -> [connector -> Redis -> sync -> live search, restock notifications]
 *                         -> low-stock alert opened or resolved in the same pharmacy database (staff-only, read through the portal)
 *
 * Real Postgres and Redis, no mocks between the stages.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, importCatalogue, readCatalogueBatch, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { buildApp as buildPortal } from "../apps/pharmacy-portal/src/app.js";
import { hashPassword } from "../apps/pharmacy-portal/src/auth.js";
import { loadConfig as loadPortalConfig } from "../apps/pharmacy-portal/src/config.js";
import { PharmacySimulator, startEmbeddedPipeline, waitUntilInSync, type EmbeddedPipeline } from "../apps/pharmacy-simulator/src/index.js";
import { buildApp as buildSearch } from "../apps/search-service/src/app.js";
import { loadConfig as loadSearchConfig } from "../apps/search-service/src/config.js";
import { RedisLiveStock } from "../apps/search-service/src/modules/live/live-stock.js";
import { RedisStockFeed, type StockChange } from "../apps/search-service/src/modules/stream/feed.js";

vi.setConfig({ testTimeout: 30_000 });

const CODES = ["P001", "P002", "P003", "P004", "P005"];
const WEST = "lat=19.1364&lng=72.8296";
const EMAIL = "waiting@example.com";
let central: Db;
let urls: Record<string, string>;
let pools: Record<string, Db>;
let redis: Redis;
let prefix: string;
let pipeline: EmbeddedPipeline;
let portal: FastifyInstance;
let live: FastifyInstance;
let fallback: FastifyInstance; // search with no live stock: answers from the central database alone
let cookie: string;
let feed: RedisStockFeed;

type Row = { pharmacy: { code: string }; quantity: number; price: number; source: string };
const search = async (app: FastifyInstance, q: string) => (await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${WEST}` })).json().data as Row[];
const at = (rows: Row[], pharmacy: string) => rows.find((r) => r.pharmacy.code === pharmacy);
const portalCall = (method: "GET" | "PATCH" | "POST" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  portal.inject({ method, url, headers: { cookie, ...headers }, ...(payload !== undefined && { payload: payload as object }) });
/** Stock changes the live stream would announce, collected until `n` have arrived. */
async function streamed(n: number): Promise<StockChange[]> {
  const seen: StockChange[] = [];
  await waitFor(async () => (seen.push(...(await feed.poll())), seen.length >= n), `${n} stock event(s) on the live stream`);
  return seen;
}
async function waitFor(cond: () => Promise<boolean>, what: string, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

beforeAll(async () => {
  central = await freshSeededDb();
  await importCatalogue(central, readCatalogueBatch());
  urls = await freshPharmacyDbs(central);
  pools = Object.fromEntries(CODES.map((c) => [c, createPool(urls[c]!)]));
});
afterAll(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await central.end();
});
beforeEach(async () => {
  prefix = `test-${randomUUID().slice(0, 8)}`;
  await central.query("TRUNCATE notifications, restock_subscriptions, users, pharmacy_users RESTART IDENTITY CASCADE");
  for (const code of CODES) {
    await pools[code]!.query("TRUNCATE outbox, inventory_movements, stock_alerts");
    await pools[code]!.query("DELETE FROM inventory");
    await pools[code]!.query("TRUNCATE outbox, inventory_movements, stock_alerts");
    await setupPharmacyDatabase(code, urls[code]!);
    // A known baseline: every medicine healthy except Crocin 500mg (M001), which these tests bring up and down. (The seeded stock has several low items.)
    await pools[code]!.query("UPDATE inventory SET quantity = CASE WHEN medicine_code = 'M001' THEN 0 ELSE 12 END");
  }
  await central.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('staff@p004.test', $1, 'P004')", [await hashPassword("pw")]);

  redis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  pipeline = await startEmbeddedPipeline({ pharmacies: pools, central, mirrorToCentral: true, keyPrefix: prefix, pollIntervalMs: 20, sync: { blockMs: 100, minIdleMs: 300, claimIntervalMs: 100 } });
  const searchConfig = loadSearchConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
  live = await buildSearch(central, searchConfig, { logger: false, live: new RedisLiveStock(redis, { keyPrefix: prefix }) });
  fallback = await buildSearch(central, searchConfig, { logger: false });
  portal = await buildPortal({ db: central, pharmacies: pools }, loadPortalConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" }), { logger: false });

  feed = new RedisStockFeed(redis, { pharmacyCodes: () => CODES, keyPrefix: prefix });
  const sim = new PharmacySimulator(pools);
  for (const code of CODES) expect((await waitUntilInSync(sim, pipeline.state, code, 10_000, 25)).inSync).toBe(true);
  await feed.poll(); // the stream feed starts from "now"
  cookie = String((await portal.inject({ method: "POST", url: "/portal/login", payload: { email: "staff@p004.test", password: "pw" } })).headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => {
  await Promise.all([live.close(), fallback.close(), portal.close()]);
  await pipeline.stop();
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  redis.disconnect();
});

describe("low-stock alerts in the whole system", () => {
  const subscribe = async () => {
    const medicineId = (await central.query("SELECT id FROM medicines WHERE code = 'M001'")).rows[0].id;
    expect((await live.inject({ method: "POST", url: "/api/restock-subscriptions", payload: { email: EMAIL, medicineId: Number(medicineId) } })).statusCode).toBeLessThan(300);
  };
  const notified = async () => ((await live.inject({ method: "GET", url: `/api/notifications?email=${EMAIL}` })).json().data as unknown[]).length;
  const alerts = async (state = "ACTIVE") => (await portalCall("GET", `/portal/alerts?state=${state}`)).json().data as { medicineCode: string; state: string; quantityAtCreation: number; quantityAtResolution: number | null }[];

  it("a sale that makes stock low opens an alert and notifies no patient; the restock that recovers it resolves the alert and, as always, notifies the waiting shopper", async () => {
    await subscribe();
    await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 12 }); // P004 starts with none: 12 on the shelf
    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 12, "live search to show 12");
    await waitFor(async () => (await notified()) === 1, "the shopper to hear about the first restock");
    expect(await alerts()).toEqual([]);

    // The sale: stock 12 -> 4, below the threshold of 5.
    expect((await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 8 })).statusCode).toBe(201);
    expect((await alerts()).map((a) => [a.medicineCode, a.state, a.quantityAtCreation])).toEqual([["M001", "ACTIVE", 4]]);
    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 4, "live search to show 4");
    // The public search still labels it as low stock, consistent with the alert's threshold.
    expect((await live.inject({ method: "GET", url: `/api/search?q=Crocin&${WEST}` })).json().data.find((r: Row & { stockStatus: string }) => r.pharmacy.code === "P004").stockStatus).toBe("LOW_STOCK");
    await new Promise((r) => setTimeout(r, 400));
    expect(await notified()).toBe(1); // no low-stock notification went to a patient
    expect(pipeline.notifier!.sent).toHaveLength(1);

    // Staff-only: nothing about alerts or risk exists on the public API.
    for (const url of ["/api/alerts", "/api/risk", "/api/stock-alerts", "/api/pharmacies/4/alerts"]) expect((await live.inject({ method: "GET", url })).statusCode).toBe(404);
    expect(JSON.stringify((await live.inject({ method: "GET", url: `/api/search?q=Crocin&${WEST}` })).json())).not.toMatch(/riskScore|stock_alert|LOW_STOCK_ALERT/i);

    // The restock that takes it back above the threshold: the alert resolves, and (the existing, separate rule) a restock notifies a waiting shopper.
    await subscribe();
    await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 10 }); // 14
    expect(await alerts()).toEqual([]);
    expect((await alerts("RESOLVED")).map((a) => [a.state, a.quantityAtCreation, a.quantityAtResolution])).toEqual([["RESOLVED", 4, 14]]);
    await waitFor(async () => (await notified()) === 2, "the shopper to hear about the second restock");
  });

  it("the live stream announces stock only: no alert event, and no staff alert data", async () => {
    await feed.poll();
    await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 6 });
    await streamed(1);
    await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 5 }); // 1 left: an alert opens
    const events = await streamed(1);
    expect(events).toEqual([expect.objectContaining({ eventType: "SALE", quantity: 1, pharmacyCode: "P004", medicineCode: "M001" })]);
    expect(JSON.stringify(events)).not.toMatch(/alert|risk|threshold/i);
    expect((await alerts()).length).toBe(1);
  });

  it("a refused or rolled-back sale opens no alert, and a retry of a recorded one does not open a second", async () => {
    await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 6 });
    expect((await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 99 })).statusCode).toBe(409);
    expect(await alerts("ALL")).toEqual([]);
    const key = { "idempotency-key": "alert-key-000001" };
    await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 4 }, key); // 2 left
    await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 4 }, key); // the retry
    expect((await alerts("ALL")).length).toBe(1);
  });

  it("another pharmacy's low stock is not visible to this pharmacy's staff, and the pipeline's duplicate protections are untouched", async () => {
    await central.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('staff@p001.test', $1, 'P001')", [await hashPassword("pw")]);
    const other = String((await portal.inject({ method: "POST", url: "/portal/login", payload: { email: "staff@p001.test", password: "pw" } })).headers["set-cookie"]).split(";")[0]!;
    await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 3 }); // P004: 3, which is low
    await portalCall("GET", "/portal/alerts");
    expect((await alerts()).length).toBe(1);
    const theirs = (await portal.inject({ method: "GET", url: "/portal/alerts?state=ALL", headers: { cookie: other } })).json().data as { pharmacyCode: string; medicineCode: string }[];
    expect(theirs.every((a) => a.pharmacyCode === "P001")).toBe(true);
    expect(theirs.some((a) => a.pharmacyCode === "P004")).toBe(false);
    // Duplicate delivery of events to the sync service still changes nothing: the search figure is exact, not doubled.
    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 3, "live search to show 3");
  });
});
