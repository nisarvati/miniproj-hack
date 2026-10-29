/**
 * Distance is claimed only between a valid origin and a VERIFIED pharmacy point. P004 (Bandra Medical Stores) is the only
 * verified directory identity; P001-P003 and P005 sit at internal demo coordinates that must never make them look nearby.
 * Test-only pharmacies P090/P091 (not in the directory, so their stored point is used) stand in for verified shops.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seed, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { searchOffers } from "../src/modules/search/service.js";
import { compareDistance, rankOffers } from "../src/modules/ranking/rank.js";
import { DEFAULT_WEIGHTS } from "../src/modules/ranking/config.js";

let db: Db;
let app: FastifyInstance;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
// The user stands at Andheri West. P090 is about 0.5 km away, P091 about 10 km, P004 (Hill Road) about 9 km.
const HERE = { latitude: 19.1364, longitude: 72.8296 };
const AT = `lat=${HERE.latitude}&lng=${HERE.longitude}`;

type R = { pharmacy: { code: string; locationVerified: boolean }; distanceKm: number | null; distanceVerified: boolean; quantity: number; price: number; stockStatus: string; rank: number; score: number };
const codes = (rows: R[]) => rows.map((r) => r.pharmacy.code);

beforeAll(async () => {
  db = await freshSeededDb();
  app = await buildApp(db, config, { logger: false });
});
beforeEach(async () => {
  await seed(db);
  await db.query("DELETE FROM pharmacies WHERE code > 'P005'");
  for (const [code, name, lat, lng] of [
    ["P090", "Test Chemist Near", 19.141, 72.83],
    ["P091", "Test Chemist Far", 19.2, 72.9],
  ] as const) {
    await db.query("INSERT INTO pharmacies (code, name, address, latitude, longitude) VALUES ($1, $2, 'Test Road', $3, $4)", [code, name, lat, lng]);
  }
  const crocin = (await db.query<{ id: string }>("SELECT id FROM medicines WHERE code = 'M001'")).rows[0]!.id;
  for (const [code, qty, price] of [["P090", 20, 31], ["P091", 20, 29]] as const) {
    await db.query("INSERT INTO inventory (pharmacy_id, medicine_id, quantity, price) SELECT id, $2, $3, $4 FROM pharmacies WHERE code = $1", [code, crocin, qty, price]);
  }
});
afterAll(async () => {
  await db.query("DELETE FROM pharmacies WHERE code > 'P005'");
  await app.close();
  await db.end();
});

const get = async (qs: string) => {
  const res = await app.inject({ method: "GET", url: `/api/search?q=Crocin&${AT}${qs ? "&" + qs : ""}` });
  return { rows: res.json().data as R[], meta: res.json().meta };
};

describe("distance is claimed only for verified locations", () => {
  it("measures verified pharmacies and gives the others no distance at all", async () => {
    const { rows } = await get("");
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      const verified = r.pharmacy.locationVerified;
      expect(verified).toBe(["P004", "P090", "P091"].includes(r.pharmacy.code));
      expect(r.distanceVerified).toBe(verified);
      if (verified) expect(r.distanceKm).toEqual(expect.any(Number));
      else expect(r.distanceKm).toBeNull();
    }
    const by = Object.fromEntries(rows.map((r) => [r.pharmacy.code, r]));
    expect(by.P090!.distanceKm!).toBeLessThan(1);
    expect(by.P004!.distanceKm!).toBeCloseTo(9.0, 1);
    expect(by.P091!.distanceKm!).toBeGreaterThan(9);
  });

  it("never lets an unverified pharmacy's internal point make it nearest, even standing exactly on that point", async () => {
    // P001's internal demo point IS the origin (distance 0 if it were used).
    const { rows, meta } = await get("sort=distance");
    const p001 = rows.find((r) => r.pharmacy.code === "P001")!;
    expect(p001.distanceKm).toBeNull();
    expect(rows[0]!.pharmacy.code).not.toBe("P001");
    expect(meta.unverifiedCount).toBe(4);
  });
});

describe("nearest-first ordering", () => {
  it("puts verified pharmacies by real distance first, then those without a verified distance", async () => {
    const { rows, meta } = await get("sort=distance");
    expect(meta.sortApplied).toBe("distance");
    expect(meta.sortNote).toBeNull();
    const inStock = rows.filter((r) => r.quantity > 0);
    const verified = inStock.filter((r) => r.distanceKm !== null);
    expect(codes(verified)).toEqual(["P090", "P091"]); // nearest to farthest
    expect(verified.map((r) => r.distanceKm)).toEqual([...verified.map((r) => r.distanceKm!)].sort((a, b) => a - b));
    // Every in-stock result without a distance comes after every in-stock result with one.
    const firstNull = inStock.findIndex((r) => r.distanceKm === null);
    expect(inStock.slice(firstNull).every((r) => r.distanceKm === null)).toBe(true);
    // Sold-out pharmacies stay last, as before.
    const firstSoldOut = rows.findIndex((r) => r.quantity === 0);
    expect(rows.slice(firstSoldOut).every((r) => r.quantity === 0)).toBe(true);
    expect(rows.map((r) => r.rank)).toEqual(rows.map((_, i) => i + 1));
  });

  it("with no verified location among the results, says it is not ordering by distance and orders by availability, price and relevance", async () => {
    await db.query("DELETE FROM inventory WHERE pharmacy_id IN (SELECT id FROM pharmacies WHERE code IN ('P004', 'P090', 'P091'))");
    const { rows, meta } = await get("sort=distance");
    expect(codes(rows).sort()).toEqual(["P001", "P002", "P003", "P005"]);
    expect(rows.every((r) => r.distanceKm === null && !r.distanceVerified)).toBe(true);
    expect(meta.sortApplied).toBe("best");
    expect(meta.sortNote).toMatch(/not ordered by distance/);
    expect(meta.sortNote).toMatch(/availability, price and relevance/);
    // The same results as the default ordering, not a different one dressed up as "nearest".
    expect(codes(rows)).toEqual(codes((await get("")).rows));
  });

  it("does not add the note when distance was not asked for", async () => {
    await db.query("DELETE FROM inventory WHERE pharmacy_id IN (SELECT id FROM pharmacies WHERE code IN ('P004', 'P090', 'P091'))");
    const { meta } = await get("");
    expect(meta.sortApplied).toBe("best");
    expect(meta.sortNote).toBeNull();
  });
});

describe("other criteria and filters are preserved", () => {
  it("still orders by price or stock, whatever the location", async () => {
    const byPrice = (await get("sort=price")).rows.filter((r) => r.quantity > 0);
    expect(byPrice.map((r) => r.price)).toEqual([...byPrice.map((r) => r.price)].sort((a, b) => a - b));
    const byStock = (await get("sort=stock")).rows.filter((r) => r.quantity > 0);
    expect(byStock.map((r) => r.quantity)).toEqual([...byStock.map((r) => r.quantity)].sort((a, b) => b - a));
  });

  it("gives an unverified pharmacy full credit for availability, price and relevance but none for distance", async () => {
    const { rows } = await get("");
    for (const r of rows) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    const p002 = rows.find((r) => r.pharmacy.code === "P002")!; // 40 in stock, a low price, no verified distance
    expect(p002.score).toBeGreaterThan(0.5);
    expect(p002.score).toBeLessThanOrEqual(0.7); // 1 - the distance weight (0.3)
    const soldOut = rows.filter((r) => r.stockStatus === "OUT_OF_STOCK");
    expect(rows.slice(0, rows.length - soldOut.length).every((r) => r.quantity > 0)).toBe(true); // in stock still outranks sold out
  });

  it("applies inStock and maxPrice as before", async () => {
    expect((await get("inStock=true")).rows.every((r) => r.quantity > 0)).toBe(true);
    const cheap = (await get("maxPrice=30")).rows;
    expect(cheap.length).toBeGreaterThan(0);
    expect(cheap.every((r) => r.price <= 30)).toBe(true);
    expect(cheap.some((r) => r.distanceKm === null)).toBe(true); // unverified pharmacies are not dropped by a price filter
  });

  it("applies maxDistanceKm to verified pharmacies only and reports what it could not measure", async () => {
    const { rows, meta } = await get("maxDistanceKm=2");
    expect(codes(rows)).toEqual(["P090"]);
    expect(meta.unverifiedFiltered).toBe(4); // P001-P003, P005: distance cannot be established
    const wide = await get("maxDistanceKm=50");
    expect(codes(wide.rows).sort()).toEqual(["P004", "P090", "P091"]);
  });
});

describe("without a usable origin", () => {
  const deps = () => ({ db, config });

  it("measures no distance and does not pretend to order by it", async () => {
    const out = await searchOffers(deps(), { q: "Crocin", location: null, limit: 20, filters: { sort: "distance" } });
    expect(out.results).toHaveLength(7);
    expect(out.results.every((r) => r.distanceKm === null && !r.distanceVerified)).toBe(true);
    expect(out.sortApplied).toBe("best");
    expect(out.sortNote).toMatch(/location is not known/);
    expect(out.unverifiedCount).toBe(7);
  });

  it("treats a non-finite origin the same way", async () => {
    const out = await searchOffers(deps(), { q: "Crocin", location: { latitude: Number.NaN, longitude: 72.8 }, limit: 20 });
    expect(out.results.every((r) => r.distanceKm === null)).toBe(true);
  });
});

describe("the ranking itself", () => {
  const config2 = { weights: DEFAULT_WEIGHTS, maxDistanceKm: 20, lowStockThreshold: 5 };
  const item = (id: string, distanceKm: number | null, price = 100, quantity = 50) => ({ id, groupKey: 1, relevance: 1, quantity, price, distanceKm });

  it("compares distances with unknown ones last", () => {
    expect(compareDistance(1, 2)).toBeLessThan(0);
    expect(compareDistance(null, 2)).toBeGreaterThan(0);
    expect(compareDistance(2, null)).toBeLessThan(0);
    expect(compareDistance(null, null)).toBe(0);
  });

  it("gives an unknown distance no credit, so it never outranks an otherwise equal verified neighbour", () => {
    const [a, b] = rankOffers([item("unknown", null), item("known", 0.5)], config2);
    expect(a!.id).toBe("known");
    expect(a!.score).toBeGreaterThan(b!.score);
    expect(b!.breakdown.distance).toBe(0);
    expect(b!.score).toBeCloseTo(0.7, 5); // availability + price + relevance at full marks, no distance term
  });

  it("does let a clearly better unverified offer beat a worse verified one (it is not hidden)", () => {
    const [first] = rankOffers([item("known-dear-far", 30, 300, 0), item("unknown-good", null, 50, 80)], config2);
    expect(first!.id).toBe("unknown-good");
  });

  it("still ranks in-stock before sold-out and cheaper before dearer when no distance is known", () => {
    const ranked = rankOffers([item("dear", null, 200), item("out", null, 50, 0), item("cheap", null, 80)], config2);
    expect(ranked.map((r) => r.id)).toEqual(["cheap", "dear", "out"]);
  });
});
