import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seed, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let db: Db;
let app: FastifyInstance;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });

// Pharmacy A (Andheri West) sits at 19.1364, 72.8296.
const AT_A = "lat=19.1364&lng=72.8296";

beforeAll(async () => {
  db = await freshSeededDb();
  app = await buildApp(db, config, { logger: false });
});
beforeEach(async () => {
  await seed(db);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const search = async (qs: string) => {
  const res = await app.inject({ method: "GET", url: `/api/search?${qs}` });
  return { status: res.statusCode, body: res.json(), raw: res.body };
};

interface Result {
  rank: number;
  score: number;
  stockStatus: string;
  distanceKm: number;
  price: number;
  quantity: number;
  pharmacy: { name: string; code: string; locationVerified: boolean };
  medicine: { brandName: string };
  scoreBreakdown: Record<string, number>;
}

describe("GET /api/search: ranked, location-aware", () => {
  it("returns Crocin offers with distance, price, stock and score", async () => {
    const { status, body } = await search(`q=Crocin&${AT_A}`);
    expect(status).toBe(200);
    const results: Result[] = body.data;
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r).toMatchObject({
        price: expect.any(Number),
        score: expect.any(Number),
        stockStatus: expect.stringMatching(/IN_STOCK|LOW_STOCK|OUT_OF_STOCK/),
      });
    }
    // A distance is claimed only for a verified location (P004); the others have none.
    for (const r of results) {
      const code = (r.pharmacy as unknown as { code: string }).code;
      if (code === "P004") expect(r).toMatchObject({ distanceKm: expect.any(Number), distanceVerified: true });
      else expect(r).toMatchObject({ distanceKm: null, distanceVerified: false });
    }
    expect(body.meta.weights).toEqual({ availability: 0.4, distance: 0.3, price: 0.2, relevance: 0.1 });
  });

  it("sorts correctly: ranks are sequential, in-stock before out-of-stock, score descending within a tier", async () => {
    const { body } = await search(`q=Crocin&${AT_A}`);
    const results: Result[] = body.data;
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    const inStock = results.filter((r) => r.quantity > 0);
    const out = results.filter((r) => r.quantity === 0);
    expect(results.slice(0, inStock.length)).toEqual(inStock);
    expect(results.slice(inStock.length)).toEqual(out);
    for (const tier of [inStock, out]) {
      const scores = tier.map((r) => r.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    }
  });

  it("puts the sold-out pharmacy last and computes distances from the user's location", async () => {
    const { body } = await search(`q=Crocin&${AT_A}`);
    const results: Result[] = body.data;
    // Shown under their directory identities: P004 is "Bandra Medical Stores" (its verified point is used), P001 "Paras Medical and General Store".
    expect(results.at(-1)!.pharmacy.name).toBe("Bandra Medical Stores");
    expect(results.at(-1)!.stockStatus).toBe("OUT_OF_STOCK");
    const a = results.find((r) => r.pharmacy.code === "P001")!;
    const d = results.find((r) => r.pharmacy.code === "P004")!;
    expect(a.distanceKm).toBeNull(); // its internal demo point sits at the origin, but that is not the shop: no distance is claimed
    expect(a.pharmacy.locationVerified).toBe(false);
    expect(d.pharmacy.locationVerified).toBe(true);
    expect(d.distanceKm).toBeCloseTo(9.0, 1); // from Andheri West to the VERIFIED Hill Road point (was 8.54 to the demo point)
  });

  it("ranks the nearby, cheap, well-stocked P002 first from Andheri West", async () => {
    const { body } = await search(`q=Crocin&${AT_A}`);
    expect(body.data[0].pharmacy.code).toBe("P002");
  });

  it("the user's position matters only for verified locations", async () => {
    // Standing at P005's internal demo point (19.1176, 72.906): P005 is not "nearest", because that point is not the shop.
    const { body } = await search("q=Crocin&lat=19.1176&lng=72.906");
    const p005 = body.data.find((r: { pharmacy: { code: string } }) => r.pharmacy.code === "P005");
    expect(p005.distanceKm).toBeNull();
    expect(body.data.filter((r: { distanceKm: number | null }) => r.distanceKm !== null).map((r: { pharmacy: { code: string } }) => r.pharmacy.code)).toEqual(["P004"]);
  });

  it("reflects inventory changes immediately (sold out becomes out of stock)", async () => {
    await db.query(
      "UPDATE inventory SET quantity = 0 WHERE pharmacy_id = (SELECT id FROM pharmacies WHERE name LIKE 'Pharmacy B%') AND medicine_id = (SELECT id FROM medicines WHERE brand_name = 'Crocin')",
    );
    const { body } = await search(`q=Crocin&${AT_A}`);
    const b = body.data.find((r: Result) => (r.pharmacy as unknown as { code: string }).code === "P002");
    expect(b.stockStatus).toBe("OUT_OF_STOCK");
    expect(b.rank).toBeGreaterThan(3);
  });

  it("ranks multiple medicines in one list, with breakdown values in 0..1", async () => {
    const { body } = await search(`q=paracetamol&${AT_A}`);
    const results: Result[] = body.data;
    expect(new Set(results.map((r) => r.medicine.brandName)).size).toBeGreaterThan(1);
    for (const r of results) {
      for (const v of Object.values(r.scoreBreakdown)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("scores an exact brand match higher on relevance than a loose generic match", async () => {
    const { body } = await search(`q=paracetamol&${AT_A}`);
    const rel = (brand: string) => body.data.find((r: Result) => r.medicine.brandName === brand).scoreBreakdown.relevance;
    expect(rel("Crocin")).toBeGreaterThan(rel("Combiflam"));
  });

  it("returns an empty list for unknown medicines", async () => {
    const { status, body } = await search(`q=notamedicine&${AT_A}`);
    expect(status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("does not leak the user's exact location in the response", async () => {
    const { raw } = await search(`q=Crocin&lat=19.123456&lng=72.654321`);
    expect(raw).not.toContain("19.123456");
    expect(raw).not.toContain("72.654321");
  });
});

describe("GET /api/search: validation", () => {
  const bad: [string, string][] = [
    ["missing location", "q=Crocin"],
    ["missing lng", "q=Crocin&lat=19.1"],
    ["missing lat", "q=Crocin&lng=72.8"],
    ["latitude out of range", "q=Crocin&lat=91&lng=72"],
    ["longitude out of range", "q=Crocin&lat=19&lng=-181"],
    ["non-numeric lat", "q=Crocin&lat=abc&lng=72"],
    ["empty lat", "q=Crocin&lat=&lng=72"],
    ["hex-looking lat", "q=Crocin&lat=0x10&lng=72"],
    ["missing q", "lat=19&lng=72"],
    ["bad limit", "q=Crocin&lat=19&lng=72&limit=0"],
  ];
  it.each(bad)("rejects %s with 400", async (_name, qs) => {
    const { status, body } = await search(qs);
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("names the offending field for a missing location", async () => {
    const { body } = await search("q=Crocin");
    expect(body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(["lat", "lng"]);
  });

  it("accepts boundary coordinates", async () => {
    expect((await search("q=Crocin&lat=-90&lng=180")).status).toBe(200);
    expect((await search("q=Crocin&lat=90&lng=-180")).status).toBe(200);
  });
});
