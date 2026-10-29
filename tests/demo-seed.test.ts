/**
 * The demo seeder through the real inventory path: each pharmacy's own database -> outbox -> connector -> Redis Stream ->
 * sync service -> search API. Isolated `_test` databases and a random Redis key prefix; the development data is never touched.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, importCatalogue, readCatalogueBatch, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { eventStreamKey, parseInventoryEvent } from "@medlink/event-schema";
import { loadCandidates, planDemoSeed, runDemoSeed, summarise } from "@medlink/pharmacy-ops";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { PharmacySimulator, startEmbeddedPipeline, waitUntilInSync, type EmbeddedPipeline } from "../apps/pharmacy-simulator/src/index.js";
import { buildApp } from "../apps/search-service/src/app.js";
import { loadConfig } from "../apps/search-service/src/config.js";
import { RedisLiveStock } from "../apps/search-service/src/modules/live/live-stock.js";

vi.setConfig({ testTimeout: 60_000 });

const CODES = ["P001", "P002", "P003", "P004", "P005"];
const WEST = "lat=19.1364&lng=72.8296";
let central: Db;
let urls: Record<string, string>;
let pools: Record<string, Db>;
let sim: PharmacySimulator;
let redis: Redis;
let prefix: string;
let pipeline: EmbeddedPipeline;
let app: FastifyInstance;

type Row = { pharmacy: { code: string }; quantity: number; price: number; stockStatus: string; source: string; updatedAt: string };
type Match = { medicine: { code: string }; listed: boolean };
const api = async (q: string) => {
  const res = (await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${WEST}&limit=50` })).json();
  return { rows: res.data as Row[], matches: res.meta.matches as Match[] };
};
const codeOf = async (brand: string) => (await central.query<{ code: string }>("SELECT code FROM medicines WHERE brand_name = $1", [brand])).rows[0]!.code;
const snapshot = async () => Object.fromEntries(await Promise.all(CODES.map(async (c) => [c, (await pools[c]!.query("SELECT medicine_code, quantity, price::text AS price, updated_at FROM inventory ORDER BY medicine_code")).rows])));
const outboxCounts = async () => Object.fromEntries(await Promise.all(CODES.map(async (c) => [c, Number((await pools[c]!.query("SELECT count(*) AS n FROM outbox")).rows[0].n)])));
const catalogueSnapshot = async () => (await central.query("SELECT id, code, brand_name, generic_name, dosage, form FROM medicines ORDER BY id")).rows;
const plan = async (seed?: string) => planDemoSeed(await loadCandidates(central), seed);

async function inSync() {
  for (const code of CODES) expect((await waitUntilInSync(sim, pipeline.state, code, 20_000, 25)).inSync).toBe(true);
}

beforeAll(async () => {
  central = await freshSeededDb();
  await importCatalogue(central, readCatalogueBatch());
  urls = await freshPharmacyDbs(central);
  pools = Object.fromEntries(CODES.map((c) => [c, createPool(urls[c]!)]));
  sim = new PharmacySimulator(pools);
});
afterAll(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await central.end();
});
beforeEach(async () => {
  prefix = `test-${randomUUID().slice(0, 8)}`;
  await central.query("DELETE FROM inventory WHERE medicine_id IN (SELECT id FROM medicines WHERE code > 'M015')");
  for (const code of CODES) {
    await pools[code]!.query("TRUNCATE outbox");
    await pools[code]!.query("DELETE FROM inventory");
    await pools[code]!.query("TRUNCATE outbox");
    await setupPharmacyDatabase(code, urls[code]!);
  }
  redis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  pipeline = await startEmbeddedPipeline({ pharmacies: pools, central, keyPrefix: prefix, pollIntervalMs: 20, sync: { blockMs: 100, minIdleMs: 300, claimIntervalMs: 100 } });
  app = await buildApp(central, loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" }), { logger: false, live: new RedisLiveStock(redis, { keyPrefix: prefix }) });
  await inSync();
});
afterEach(async () => {
  await app.close();
  await pipeline.stop();
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  redis.disconnect();
});

describe("a dry run", () => {
  it("changes nothing: no inventory, no outbox events, no catalogue change, and reports the plan", async () => {
    const before = { stock: await snapshot(), outbox: await outboxCounts(), catalogue: await catalogueSnapshot() };
    const p = await plan();
    const report = await runDemoSeed(sim, p, { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.added).toHaveLength(p.rows.length); // nothing of the plan is listed yet
    expect(report.added.length).toBeGreaterThan(100);
    expect({ stock: await snapshot(), outbox: await outboxCounts(), catalogue: await catalogueSnapshot() }).toEqual(before);
    expect((await central.query("SELECT count(*) AS n FROM inventory WHERE medicine_id IN (SELECT id FROM medicines WHERE code > 'M015')")).rows[0].n).toBe("0");
  });
});

describe("writing the demo stock", () => {
  it("adds exactly the plan, each row to its own pharmacy's database with its own quantity and price, through the outbox", async () => {
    const p = await plan();
    const stockBefore = await snapshot();
    const outboxBefore = await outboxCounts();
    const catalogueBefore = await catalogueSnapshot();
    const report = await runDemoSeed(sim, p, { dryRun: false });
    expect(report.added).toHaveLength(p.rows.length);

    const after = await snapshot();
    for (const code of CODES) {
      const mine = p.rows.filter((r) => r.pharmacy === code);
      const added = (after[code] as { medicine_code: string; quantity: number; price: string }[]).filter((r) => mine.some((m) => m.medicineCode === r.medicine_code));
      expect(added.map((r) => [r.medicine_code, r.quantity, Number(r.price)]).sort()).toEqual(mine.map((m) => [m.medicineCode, m.quantity, m.price]).sort());
      // The pharmacy's earlier stock is exactly as it was.
      const untouched = (after[code] as { medicine_code: string }[]).filter((r) => !mine.some((m) => m.medicineCode === r.medicine_code));
      expect(untouched).toEqual(stockBefore[code]);
      // One MEDICINE_ADDED event per new row, recorded in the same database.
      expect((await outboxCounts())[code]).toBe(outboxBefore[code]! + mine.length);
      const events = (await pools[code]!.query("SELECT event_type FROM outbox ORDER BY id DESC LIMIT $1", [mine.length])).rows;
      expect(events.every((e) => e.event_type === "MEDICINE_ADDED")).toBe(true);
    }
    expect(await catalogueSnapshot()).toEqual(catalogueBefore); // the central catalogue gained nothing
    expect(summarise(report.added).byPharmacy.P001!.rows).toBeGreaterThan(0);
  });

  it("is idempotent: a second run, and a run with the same seed, add nothing", async () => {
    const p = await plan();
    await runDemoSeed(sim, p, { dryRun: false });
    const stock = await snapshot();
    const outbox = await outboxCounts();
    const again = await runDemoSeed(sim, await plan(), { dryRun: false });
    expect(again.added).toEqual([]);
    expect(again.skipped).toHaveLength(p.rows.length);
    expect(await snapshot()).toEqual(stock);
    expect(await outboxCounts()).toEqual(outbox);
  });

  it("never overwrites stock a pharmacy already has, even for a planned medicine", async () => {
    const p = await plan();
    const target = p.rows.find((r) => r.scenario === "random" && r.pharmacy === "P003")!;
    await sim.addMedicine("P003", target.medicineCode, 77, 12.34); // someone entered this by hand
    const report = await runDemoSeed(sim, p, { dryRun: false });
    expect(report.skipped.map((r) => `${r.pharmacy}|${r.medicineCode}`)).toEqual([`P003|${target.medicineCode}`]);
    expect((await sim.stock("P003")).get(target.medicineCode)).toEqual({ quantity: 77, price: 12.34 });
  });

  it("another seed adds only what that plan has and the first leaves untouched", async () => {
    await runDemoSeed(sim, await plan("one"), { dryRun: false });
    const first = await snapshot();
    const second = await runDemoSeed(sim, await plan("two"), { dryRun: false });
    const secondRows = new Set(second.added.map((r) => `${r.pharmacy}|${r.medicineCode}`));
    for (const code of CODES) {
      for (const row of first[code] as { medicine_code: string; quantity: number; price: string }[]) {
        const now = (await sim.stock(code)).get(row.medicine_code)!;
        expect(now).toEqual({ quantity: row.quantity, price: Number(row.price) }); // nothing already listed changed
      }
    }
    expect(secondRows.size).toBe(second.added.length); // no pair was added twice
  });
});

describe("what a patient sees afterwards, through the normal pipeline", () => {
  it("search shows each stocked pharmacy's own price, quantity and freshness, and tells zero stock from unlisted", async () => {
    const p = await plan();
    await runDemoSeed(sim, p, { dryRun: false });
    await inSync();

    const amlong = await api("Amlong");
    expect(amlong.rows.map((r) => r.pharmacy.code).sort()).toEqual(CODES);
    expect(new Set(amlong.rows.map((r) => r.price)).size).toBe(5);
    for (const row of amlong.rows) {
      const planned = p.rows.find((x) => x.pharmacy === row.pharmacy.code && x.medicineCode === amlong.matches[0]!.medicine.code)!;
      expect(row).toMatchObject({ quantity: planned.quantity, price: planned.price, source: "live" });
      expect(Math.abs(Date.now() - Date.parse(row.updatedAt))).toBeLessThan(120_000);
    }

    const retaunch = await api("Retaunch");
    expect(retaunch.rows).toHaveLength(1);
    expect(retaunch.rows[0]).toMatchObject({ pharmacy: { code: "P002" }, quantity: 14, stockStatus: "IN_STOCK" });

    const cabgolin = await api("Cabgolin");
    expect(cabgolin.rows).toHaveLength(1);
    expect(cabgolin.rows[0]).toMatchObject({ pharmacy: { code: "P004" }, quantity: 0, stockStatus: "OUT_OF_STOCK", source: "live" });
    expect(cabgolin.matches).toMatchObject([{ listed: true }]); // listed, but sold out

    for (const brand of ["Nefrozon", "Dutas"]) {
      const none = await api(brand);
      expect(none.rows).toEqual([]);
      expect(none.matches).toMatchObject([{ listed: false, medicine: { code: await codeOf(brand) } }]); // in the catalogue, nobody lists it
    }
    expect((await api("Viotace")).matches).toEqual([]); // not in the catalogue at all

    // The demo medicines are exactly as before.
    expect((await api("Crocin 500mg")).rows.map((r) => r.quantity).sort((a, b) => a - b)).toEqual([0, 1, 3, 25, 40]);
  });

  it("events carry the right pharmacy identity on that pharmacy's own stream", async () => {
    await runDemoSeed(sim, await plan(), { dryRun: false });
    await inSync();
    const retaunch = await codeOf("Retaunch");
    for (const code of CODES) {
      const events = (await redis.xrange(eventStreamKey(code, prefix), "-", "+")).map(([, f]) => JSON.parse(f[1]!));
      expect(events.every((e) => parseInventoryEvent(e).success)).toBe(true);
      expect(events.every((e) => e.pharmacyId === code)).toBe(true);
      expect(events.some((e) => e.medicineId === retaunch && e.eventType === "MEDICINE_ADDED")).toBe(code === "P002");
    }
  });
});
