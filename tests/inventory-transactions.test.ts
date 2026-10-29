/**
 * Inventory transactions (a sale, a restock) recorded in the portal travel the whole pipeline:
 *
 *   portal -> pharmacy's own database (stock + outbox + movement history, one transaction) -> connector -> Redis stream
 *          -> sync service -> Redis state -> live search, central database, restock notifications, and the live stream's stock events
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
const centralRow = async (pharmacy: string, medicine: string) =>
  (
    await central.query<{ quantity: number; price: string }>(
      `SELECT i.quantity, i.price FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id JOIN medicines m ON m.id = i.medicine_id WHERE p.code = $1 AND m.code = $2`,
      [pharmacy, medicine],
    )
  ).rows[0];

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
    await pools[code]!.query("TRUNCATE outbox, inventory_movements");
    await pools[code]!.query("DELETE FROM inventory");
    await pools[code]!.query("TRUNCATE outbox, inventory_movements");
    await setupPharmacyDatabase(code, urls[code]!);
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

describe("a sale and a restock recorded in the portal", () => {
  const subscribe = async () => {
    const medicineId = (await central.query("SELECT id FROM medicines WHERE code = 'M001'")).rows[0].id;
    expect((await live.inject({ method: "POST", url: "/api/restock-subscriptions", payload: { email: EMAIL, medicineId: Number(medicineId) } })).statusCode).toBeLessThan(300);
  };
  const notified = async () => ((await live.inject({ method: "GET", url: `/api/notifications?email=${EMAIL}` })).json().data as unknown[]).length;

  it("reach live search, the central database, restock notifications and the live stream, and a sale never notifies anyone", async () => {
    await subscribe();
    // P004 starts with none of M001. A restock brings 20, which is what a waiting shopper hears about.
    const restock = await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 20 });
    expect(restock.statusCode).toBe(201);
    expect(restock.json().data).toMatchObject({ operation: "RESTOCK", quantityBefore: 0, quantityAfter: 20 });
    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 20, "live search to show 20");
    await waitFor(async () => (await centralRow("P004", "M001"))?.quantity === 20, "the central database to show 20");
    await waitFor(async () => (await notified()) === 1, "the waiting shopper to be notified of the restock");
    expect(await streamed(1)).toEqual([expect.objectContaining({ pharmacyCode: "P004", medicineCode: "M001", eventType: "RESTOCK", quantity: 20 })]);

    // A sale of 7: stock falls everywhere, the stream announces it, nobody is notified.
    const sale = await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 7 });
    expect(sale.statusCode).toBe(201);
    expect(sale.json().data).toMatchObject({ operation: "SALE", quantity: 7, quantityBefore: 20, quantityAfter: 13 });
    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 13, "live search to show 13");
    await waitFor(async () => (await centralRow("P004", "M001"))?.quantity === 13, "the central database to show 13");
    const events = await streamed(1);
    expect(events[0]).toMatchObject({ pharmacyCode: "P004", eventType: "SALE", quantity: 13, eventId: sale.json().data.eventId });
    expect(JSON.stringify(events)).not.toMatch(/quantityDelta/);
    await new Promise((r) => setTimeout(r, 300));
    expect(await notified()).toBe(1);
    expect(pipeline.notifier!.sent).toHaveLength(1);

    // The history is the pharmacy's own record, newest first, and each entry points at the event that went downstream.
    const history = (await portalCall("GET", "/portal/history")).json().data as { operation: string; quantityAfter: number; eventId: string }[];
    expect(history.map((m) => [m.operation, m.quantityAfter])).toEqual([["SALE", 13], ["RESTOCK", 20]]);
    expect(history[0]!.eventId).toBe(sale.json().data.eventId);
  });

  it("a refused sale changes nothing anywhere and announces nothing", async () => {
    await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 5 });
    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 5, "live search to show 5");
    await streamed(1);

    const refused = await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 6 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("INSUFFICIENT_STOCK");
    expect((await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 0 })).statusCode).toBe(400);
    await new Promise((r) => setTimeout(r, 400));
    expect(await feed.poll()).toEqual([]);
    expect(at(await search(live, "Crocin 500mg"), "P004")?.quantity).toBe(5);
    expect((await centralRow("P004", "M001"))?.quantity).toBe(5);
    expect(((await portalCall("GET", "/portal/history")).json().data as unknown[]).length).toBe(1);
    expect((await pools.P004!.query("SELECT count(*) AS n FROM outbox WHERE event_type = 'SALE'")).rows[0].n).toBe("0");
  });

  it("a retried request with the same key is one sale: one event through the pipeline, one change in search", async () => {
    await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 10 });
    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 10, "live search to show 10");
    await streamed(1);

    const key = { "idempotency-key": "integration-key-0001" };
    const first = await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 4 }, key);
    const retry = await portalCall("POST", "/portal/sales", { medicineCode: "M001", quantity: 4 }, key);
    expect([first.statusCode, retry.statusCode]).toEqual([201, 200]);
    expect(retry.json().data.movementId).toBe(first.json().data.movementId);
    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 6, "live search to show 6");
    await new Promise((r) => setTimeout(r, 400));
    expect(at(await search(live, "Crocin 500mg"), "P004")?.quantity).toBe(6); // not 2
    expect((await streamed(1)).length).toBe(1);
    expect(await feed.poll()).toEqual([]);
    expect((await pools.P004!.query("SELECT count(*) AS n FROM outbox WHERE event_type = 'SALE'")).rows[0].n).toBe("1");
  });

  it("another pharmacy's staff see none of it", async () => {
    await central.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('staff@p001.test', $1, 'P001')", [await hashPassword("pw")]);
    const other = String((await portal.inject({ method: "POST", url: "/portal/login", payload: { email: "staff@p001.test", password: "pw" } })).headers["set-cookie"]).split(";")[0]!;
    await portalCall("POST", "/portal/restocks", { medicineCode: "M001", quantity: 3 });
    expect(((await portal.inject({ method: "GET", url: "/portal/history", headers: { cookie: other } })).json().data as unknown[]).length).toBe(0);
    const before = (await pools.P001!.query("SELECT quantity FROM inventory WHERE medicine_code = 'M001'")).rows[0].quantity as number;
    const mine = await portal.inject({ method: "POST", url: "/portal/sales", headers: { cookie: other }, payload: { medicineCode: "M001", quantity: 1 } });
    expect(mine.statusCode).toBe(201);
    expect(mine.json().data.pharmacyCode).toBe("P001");
    expect((await pools.P004!.query("SELECT quantity FROM inventory WHERE medicine_code = 'M001'")).rows[0].quantity).toBe(3); // untouched by P001's sale
    expect((await pools.P001!.query("SELECT quantity FROM inventory WHERE medicine_code = 'M001'")).rows[0].quantity).toBe(before - 1);
  });
});
