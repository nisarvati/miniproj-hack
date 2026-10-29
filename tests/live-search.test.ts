/**
 * What a patient sees follows what happens at the pharmacy: a change made in a pharmacy's own database (through the
 * simulator) travels connector -> Redis stream -> sync service -> Redis state, and shows up in the search API.
 * Real Postgres and Redis, no mocks between the stages.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
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

type Row = { pharmacy: { code: string }; quantity: number; price: number; stockStatus: string; source: string; medicine: { code: string } };
const search = async (q: string, extra = "") => ((await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${WEST}${extra}` })).json().data as Row[]);
const at = (rows: Row[], pharmacy: string) => rows.find((r) => r.pharmacy.code === pharmacy);

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 8000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the search results to change");
    await new Promise((r) => setTimeout(r, 40));
  }
}

beforeAll(async () => {
  central = await freshSeededDb();
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
  await central.query("TRUNCATE notifications, restock_subscriptions, users RESTART IDENTITY CASCADE");
  for (const code of CODES) {
    await pools[code]!.query("TRUNCATE outbox");
    await pools[code]!.query("DELETE FROM inventory");
    await pools[code]!.query("TRUNCATE outbox");
    await setupPharmacyDatabase(code, urls[code]!); // starting stock, announced as events
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

describe("search follows the pharmacies, live", () => {
  it("once the starting stock has synced, every result is live and matches the pharmacies", async () => {
    const rows = await search("Crocin 500mg");
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.source === "live")).toBe(true);
    expect(rows.map((r) => r.quantity).sort((a, b) => a - b)).toEqual([0, 1, 3, 25, 40]);
  });

  it("a sale at a pharmacy shows up in the results within moments", async () => {
    expect(at(await search("Crocin 500mg"), "P002")!.quantity).toBe(40);
    await sim.sell("P002", "M001", 40);
    await waitFor(async () => at(await search("Crocin 500mg"), "P002")?.stockStatus === "OUT_OF_STOCK");
    expect(at(await search("Crocin 500mg", "&inStock=true"), "P002")).toBeUndefined();
  });

  it("a restock puts an out-of-stock pharmacy back in the results", async () => {
    expect(at(await search("Crocin 500mg"), "P004")!.stockStatus).toBe("OUT_OF_STOCK");
    await sim.restock("P004", "M001", 30);
    await waitFor(async () => at(await search("Crocin 500mg"), "P004")?.quantity === 30);
    expect(at(await search("Crocin 500mg", "&inStock=true"), "P004")).toMatchObject({ stockStatus: "IN_STOCK", source: "live" });
  });

  it("a price change shows up", async () => {
    await sim.changePrice("P001", "M001", 19.99);
    await waitFor(async () => at(await search("Crocin 500mg"), "P001")?.price === 19.99);
  });

  it("a medicine a pharmacy starts stocking appears, and one it stops stocking disappears", async () => {
    expect(at(await search("Cetzine"), "P004")).toBeUndefined();
    await sim.addMedicine("P004", "M008", 20, 22.88);
    await waitFor(async () => at(await search("Cetzine"), "P004")?.quantity === 20);

    await sim.removeMedicine("P004", "M008");
    await waitFor(async () => at(await search("Cetzine"), "P004") === undefined);
  });

  it("a medicine that sold out everywhere leads to substitutes you can buy", async () => {
    for (const code of CODES) {
      const qty = (await sim.stock(code)).get("M001")?.quantity ?? 0;
      if (qty > 0) await sim.sell(code, "M001", qty);
    }
    await waitFor(async () => (await search("Crocin 500mg")).every((r) => r.quantity === 0));
    const id = (await central.query("SELECT id FROM medicines WHERE code = 'M001'")).rows[0].id;
    const res = (await app.inject({ method: "GET", url: `/api/medicines/${id}/substitutes?${WEST}` })).json();
    expect(res.data.map((s: { medicine: { brandName: string } }) => s.medicine.brandName)).toContain("Dolo");
    expect(res.meta.live).toBe(true);
  });

  it("the pharmacy page shows the same live stock", async () => {
    await sim.sell("P001", "M001", 1);
    const pid = (await central.query("SELECT id FROM pharmacies WHERE code = 'P001'")).rows[0].id;
    await waitFor(async () => {
      const body = (await app.inject({ method: "GET", url: `/api/pharmacies/${pid}/stock?q=crocin` })).json();
      return body.data[0]?.quantity === 0 && body.data[0]?.source === "live";
    });
  });
});
