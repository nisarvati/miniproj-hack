/**
 * A product from the expanded catalogue travels the real pipeline: pharmacy database -> outbox -> connector -> Redis
 * Stream -> sync service -> Redis state -> search API. Importing the catalogue only makes the product findable; the
 * product appears in results only for the pharmacies that list it, with what they report. Real Postgres and Redis.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, importCatalogue, readCatalogueBatch, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { eventStreamKey, parseInventoryEvent, STREAM_EVENT_FIELD } from "@medlink/event-schema";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { PharmacySimulator, startEmbeddedPipeline, waitUntilInSync, type EmbeddedPipeline } from "../apps/pharmacy-simulator/src/index.js";
import { buildApp } from "../apps/search-service/src/app.js";
import { loadConfig } from "../apps/search-service/src/config.js";
import { RedisLiveStock } from "../apps/search-service/src/modules/live/live-stock.js";

vi.setConfig({ testTimeout: 30_000 });

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

type Row = { pharmacy: { code: string }; quantity: number; price: number; stockStatus: string; source: string; updatedAt: string; medicine: { code: string; brandName: string } };
const search = async (q: string, extra = "") => (await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${WEST}${extra}` })).json() as { data: Row[]; meta: { live: boolean } };
const rows = async (q: string) => (await search(q)).data;
const at = (r: Row[], pharmacy: string) => r.find((x) => x.pharmacy.code === pharmacy);
const codeOf = async (brand: string, dosage?: string) =>
  (await central.query<{ code: string }>("SELECT code FROM medicines WHERE brand_name = $1 AND ($2::text IS NULL OR dosage = $2)", [brand, dosage ?? null])).rows[0]!.code;

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the search results to change");
    await new Promise((r) => setTimeout(r, 40));
  }
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
  pipeline = await startEmbeddedPipeline({ pharmacies: pools, keyPrefix: prefix, pollIntervalMs: 20, sync: { blockMs: 100, minIdleMs: 300, claimIntervalMs: 100 } });
  app = await buildApp(central, loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" }), { logger: false, live: new RedisLiveStock(redis, { keyPrefix: prefix }) });
  for (const code of CODES) expect((await waitUntilInSync(sim, pipeline.state, code, 10_000, 25)).inSync).toBe(true);
});
afterEach(async () => {
  await app.close();
  await pipeline.stop();
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  redis.disconnect();
});

describe("a newly catalogued product, end to end", () => {
  it("is findable but absent from results until a pharmacy lists it", async () => {
    const before = await search("Retaunch");
    expect(before.data).toEqual([]);
    expect(before.meta.live).toBe(true);
    expect(await rows("Viotace")).toEqual([]);
  });

  it("shows only the pharmacies that list it, each with its own live quantity and price", async () => {
    const code = await codeOf("Retaunch");
    await sim.addMedicine("P001", code, 14, 190.0);
    await sim.addMedicine("P003", code, 0, 205.5);
    await waitFor(async () => (await rows("Retaunch")).length === 2);

    const r = await rows("Retaunch");
    expect(r.map((x) => x.pharmacy.code).sort()).toEqual(["P001", "P003"]);
    expect(at(r, "P001")).toMatchObject({ quantity: 14, price: 190, stockStatus: "IN_STOCK", source: "live" });
    // Freshness: the timestamp is the pharmacy's own change time, i.e. just now, not the catalogue import.
    for (const row of r) expect(Math.abs(Date.now() - new Date(row.updatedAt).getTime())).toBeLessThan(60_000);
    expect(at(r, "P003")).toMatchObject({ quantity: 0, price: 205.5, stockStatus: "OUT_OF_STOCK", source: "live" });
    for (const other of ["P002", "P004", "P005"]) expect(at(r, other)).toBeUndefined();
    // The same product is not mixed up with the other brands of that formula.
    expect(await rows("Nefrosave")).toEqual([]);
    // Nothing else changed: the demo medicines still show their starting stock.
    expect((await rows("Crocin 500mg")).map((x) => x.quantity).sort((a, b) => a - b)).toEqual([0, 1, 3, 25, 40]);
  });

  it("follows later changes at the pharmacy: sale, restock, price, stop stocking", async () => {
    const code = await codeOf("Veenat");
    await sim.addMedicine("P002", code, 6, 400);
    await waitFor(async () => at(await rows("Veenat"), "P002")?.quantity === 6);

    await sim.sell("P002", code, 6);
    await waitFor(async () => at(await rows("Veenat"), "P002")?.stockStatus === "OUT_OF_STOCK");
    await sim.restock("P002", code, 40);
    await sim.changePrice("P002", code, 389.9);
    await waitFor(async () => {
      const row = at(await rows("Veenat"), "P002");
      return row?.quantity === 40 && row.price === 389.9 && row.stockStatus === "IN_STOCK";
    });
    await sim.removeMedicine("P002", code);
    await waitFor(async () => (await rows("Veenat")).length === 0);
  });

  it("publishes valid events on the pharmacy's own stream, and a duplicate delivery changes nothing", async () => {
    const code = await codeOf("Mintop");
    const change = await sim.addMedicine("P004", code, 9, 515);
    expect(change.events.map((e) => e.eventType)).toEqual(["MEDICINE_ADDED"]);
    await waitFor(async () => at(await rows("Mintop"), "P004")?.quantity === 9);

    const entries = await redis.xrange(eventStreamKey("P004", prefix), "-", "+");
    const added = entries.map(([, f]) => JSON.parse(f[1]!)).filter((e) => e.medicineId === code);
    expect(added).toHaveLength(1);
    const parsed = parseInventoryEvent(added[0]);
    expect(parsed.success).toBe(true);
    expect(added[0]).toMatchObject({ pharmacyId: "P004", medicineId: code, eventType: "MEDICINE_ADDED", quantityAfter: 9, price: 515, eventId: change.events[0]!.eventId });
    // No other pharmacy's stream carries it.
    for (const other of ["P001", "P002", "P003", "P005"]) {
      const theirs = (await redis.xrange(eventStreamKey(other, prefix), "-", "+")).map(([, f]) => JSON.parse(f[1]!));
      expect(theirs.some((e) => e.medicineId === code)).toBe(false);
    }

    // Redeliver the same event (same eventId), then make a real change: the duplicate must not have been applied again.
    await redis.xadd(eventStreamKey("P004", prefix), "*", STREAM_EVENT_FIELD, JSON.stringify(added[0]));
    await sim.restock("P004", code, 5);
    await waitFor(async () => at(await rows("Mintop"), "P004")?.quantity === 14);
    await new Promise((r) => setTimeout(r, 400));
    expect(at(await rows("Mintop"), "P004")?.quantity).toBe(14);
  });

  it("refuses a code that is not in the catalogue", async () => {
    expect(() => sim.addMedicine("P001", "M999", 1, 10)).toThrow(/not in the MedLink catalogue/);
  });
});
