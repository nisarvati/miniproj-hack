/**
 * A change made by pharmacy staff in the portal reaches everything that shows stock:
 *
 *   portal -> pharmacy's own database (+ outbox) -> connector -> Redis stream -> sync service
 *          -> Redis state  -> search / pharmacy page / restock notifications
 *          -> central database (the fallback search uses when live stock is unavailable)
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

type Row = { pharmacy: { code: string }; quantity: number; price: number; source: string };
const search = async (app: FastifyInstance, q: string) => (await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${WEST}` })).json().data as Row[];
const at = (rows: Row[], pharmacy: string) => rows.find((r) => r.pharmacy.code === pharmacy);
const portalCall = (method: "PATCH" | "POST" | "DELETE", url: string, payload?: unknown) =>
  portal.inject({ method, url, headers: { cookie }, ...(payload !== undefined && { payload: payload as object }) });
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
    await pools[code]!.query("TRUNCATE outbox");
    await pools[code]!.query("DELETE FROM inventory");
    await pools[code]!.query("TRUNCATE outbox");
    await setupPharmacyDatabase(code, urls[code]!);
  }
  await central.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('staff@p004.test', $1, 'P004')", [await hashPassword("pw")]);

  redis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  pipeline = await startEmbeddedPipeline({ pharmacies: pools, central, mirrorToCentral: true, keyPrefix: prefix, pollIntervalMs: 20, sync: { blockMs: 100, minIdleMs: 300, claimIntervalMs: 100 } });
  const searchConfig = loadSearchConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
  live = await buildSearch(central, searchConfig, { logger: false, live: new RedisLiveStock(redis, { keyPrefix: prefix }) });
  fallback = await buildSearch(central, searchConfig, { logger: false });
  portal = await buildPortal({ db: central, pharmacies: pools }, loadPortalConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" }), { logger: false });

  const sim = new PharmacySimulator(pools);
  for (const code of CODES) expect((await waitUntilInSync(sim, pipeline.state, code, 10_000, 25)).inSync).toBe(true);
  cookie = String((await portal.inject({ method: "POST", url: "/portal/login", payload: { email: "staff@p004.test", password: "pw" } })).headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => {
  await Promise.all([live.close(), fallback.close(), portal.close()]);
  await pipeline.stop();
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  redis.disconnect();
});

describe("a portal change reaches everywhere", () => {
  it("a restock shows in live search, in the central database, and notifies a waiting shopper", async () => {
    expect(at(await search(live, "Crocin 500mg"), "P004")).toMatchObject({ quantity: 0, source: "live" });
    const medicineId = (await central.query("SELECT id FROM medicines WHERE code = 'M001'")).rows[0].id;
    expect((await live.inject({ method: "POST", url: "/api/restock-subscriptions", payload: { email: EMAIL, medicineId: Number(medicineId) } })).statusCode).toBeLessThan(300);

    const res = await portalCall("PATCH", "/portal/stock/M001", { quantity: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.events).toEqual(["RESTOCK"]);

    await waitFor(async () => at(await search(live, "Crocin 500mg"), "P004")?.quantity === 30, "live search to show 30");
    await waitFor(async () => (await centralRow("P004", "M001"))?.quantity === 30, "the central database to show 30");
    await waitFor(async () => ((await live.inject({ method: "GET", url: `/api/notifications?email=${EMAIL}` })).json().data as unknown[]).length === 1, "the shopper to be notified");
    expect(pipeline.notifier!.sent).toHaveLength(1);
  });

  it("search still shows the change when live stock is unavailable, because the central database was kept up to date", async () => {
    await portalCall("PATCH", "/portal/stock/M001", { quantity: 12, price: 28.5 });
    // The portal applies the quantity and then the price as two changes, so wait for BOTH to reach the central database.
    await waitFor(async () => {
      const row = await centralRow("P004", "M001");
      return row?.quantity === 12 && Number(row.price) === 28.5;
    }, "the central database to show 12 at 28.50");
    expect(at(await search(fallback, "Crocin 500mg"), "P004")).toMatchObject({ quantity: 12, price: 28.5, source: "catalogue" });
  });

  it("a medicine added in the portal appears, and one removed disappears, in live search and the central database", async () => {
    expect(at(await search(live, "Cetzine"), "P004")).toBeUndefined();
    expect((await portalCall("POST", "/portal/stock", { medicineCode: "M008", quantity: 20, price: 22.88 })).statusCode).toBe(201);
    await waitFor(async () => at(await search(live, "Cetzine"), "P004")?.quantity === 20, "live search to list Cetzine");
    await waitFor(async () => (await centralRow("P004", "M008"))?.quantity === 20, "the central database to list Cetzine");

    expect((await portalCall("DELETE", "/portal/stock/M008")).statusCode).toBe(200);
    await waitFor(async () => at(await search(live, "Cetzine"), "P004") === undefined, "live search to drop Cetzine");
    await waitFor(async () => (await centralRow("P004", "M008")) === undefined, "the central database to drop Cetzine");
  });

  it("offers the expanded catalogue to add, and a newly catalogued product listed by one pharmacy reaches search for that pharmacy only", async () => {
    const offered = (await portal.inject({ method: "GET", url: "/portal/catalogue", headers: { cookie } })).json().data as { medicineCode: string; brandName: string }[];
    const retaunch = offered.find((m) => m.brandName === "Retaunch")!;
    expect(retaunch).toBeDefined();
    expect(offered.length).toBeGreaterThan(100);
    expect(at(await search(live, "Retaunch"), "P004")).toBeUndefined(); // catalogued is not stocked

    expect((await portalCall("POST", "/portal/stock", { medicineCode: retaunch.medicineCode, quantity: 7, price: 188.4 })).statusCode).toBe(201);
    await waitFor(async () => at(await search(live, "Retaunch"), "P004")?.quantity === 7, "live search to list Retaunch");
    await waitFor(async () => (await centralRow("P004", retaunch.medicineCode))?.quantity === 7, "the central database to list Retaunch");
    expect((await search(live, "Retaunch")).map((r) => r.pharmacy.code)).toEqual(["P004"]);
    expect(await search(fallback, "Retaunch")).toHaveLength(1);

    // Once this pharmacy lists it, it is no longer offered to add.
    const again = (await portal.inject({ method: "GET", url: "/portal/catalogue", headers: { cookie } })).json().data as { medicineCode: string }[];
    expect(again.some((m) => m.medicineCode === retaunch.medicineCode)).toBe(false);
    // A code outside the catalogue is refused by the portal.
    expect((await portalCall("POST", "/portal/stock", { medicineCode: "M999", quantity: 1, price: 10 })).statusCode).toBeGreaterThanOrEqual(400);
  });
});
