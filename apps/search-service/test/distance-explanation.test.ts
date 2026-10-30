/**
 * Why a result has, or lacks, a distance, and what that does to the match percentage. Same fixtures as location-ranking.test.ts: the user
 * stands at Andheri West; P090 (about 0.5 km) and P091 (about 10 km) are verified test pharmacies; P002 is shown as Roopam Medical and
 * General Stores, whose two directory map points disagree by about 450 m, so it has no verified location and must never get a distance.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seed, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { haversineKm } from "../src/modules/geo/haversine.js";
import { DEFAULT_WEIGHTS } from "../src/modules/ranking/config.js";
import { explainMatch, type MatchInput } from "../src/modules/ranking/match.js";
import { rankOffers } from "../src/modules/ranking/rank.js";

let db: Db;
let app: FastifyInstance;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
const HERE = { latitude: 19.1364, longitude: 72.8296 };

interface Result {
  matchPercent: number;
  matchReasons: { code: string; factor: string; points: number; factorValue: number | null; message: string }[];
  scoreBreakdown: { distance: number };
  pharmacy: { code: string; name: string; locationVerified: boolean };
  distanceKm: number | null;
  distanceVerified: boolean;
}

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

const search = async (qs: string) => {
  const res = await app.inject({ method: "GET", url: `/api/search?q=Crocin&${qs}` });
  return { status: res.statusCode, body: res.json() as { data: Result[]; meta: { rejected: { pharmacy: { code: string }; distanceKm: number | null }[] } } };
};
const AT = `lat=${HERE.latitude}&lng=${HERE.longitude}`;
const distanceReason = (r: Result) => r.matchReasons.find((m) => m.factor === "distance")!;

describe("the distance formula", () => {
  it("is the great-circle distance in kilometres: a degree of latitude is about 111.2 km, and the same point is 0 km", () => {
    expect(haversineKm(HERE, HERE)).toBe(0);
    expect(haversineKm({ latitude: 19, longitude: 72 }, { latitude: 20, longitude: 72 })).toBeCloseTo(111.19, 1);
    const ab = haversineKm(HERE, { latitude: 19.0596, longitude: 72.8295 });
    expect(ab).toBeGreaterThan(8);
    expect(ab).toBeLessThan(9);
    expect(haversineKm({ latitude: 19.0596, longitude: 72.8295 }, HERE)).toBeCloseTo(ab, 9); // symmetric
    expect(Number.isFinite(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 }))).toBe(true); // far side of the Earth
  });
});

describe("distance credit: 1 - distance / maximum, between 0 and 1, weighted 30%", () => {
  const offer = (distanceKm: number | null) => ({ groupKey: 1, relevance: 1, quantity: 20, price: 30, distanceKm });
  const credit = (km: number | null) => rankOffers([offer(km)], { weights: DEFAULT_WEIGHTS, maxDistanceKm: 10, lowStockThreshold: 5 })[0]!;

  it("gives a closer pharmacy more, none at the maximum or beyond it, and the whole weight at 0 km", () => {
    const at = (km: number) => credit(km).breakdown.distance;
    expect(at(0)).toBe(1);
    expect(at(2.5)).toBeCloseTo(0.75, 10);
    expect(at(2.5)).toBeGreaterThan(at(7.5));
    expect(at(10)).toBe(0);
    expect(at(10.0001)).toBe(0);
    expect(at(250)).toBe(0);
    expect(credit(0).score - credit(10).score).toBeCloseTo(DEFAULT_WEIGHTS.distance, 10);
  });

  it("gives no credit when the distance is unknown, which is not the same as 0 km", () => {
    expect(credit(null).breakdown.distance).toBe(0);
    expect(credit(null).score).toBeLessThan(credit(0).score);
  });
});

describe("explaining a missing distance", () => {
  const base = (over: Partial<MatchInput>): MatchInput => ({
    score: 0.7,
    breakdown: { availability: 1, distance: 0, price: 1, relevance: 1 },
    weights: DEFAULT_WEIGHTS,
    quantity: 20,
    price: 25,
    distanceKm: null,
    relevance: 1,
    maxDistanceKm: 10,
    lowStockThreshold: 5,
    priceRange: null,
    ...over,
  });
  const message = (over: Partial<MatchInput>) => explainMatch(base(over)).reasons[2]!;

  it("says the pharmacy's location is unverified, and that the user's location is needed, as two different things", () => {
    const unverified = message({ distanceUnavailable: "PHARMACY_UNVERIFIED" });
    const noOrigin = message({ distanceUnavailable: "ORIGIN_UNKNOWN" });
    expect(unverified.message).toMatch(/pharmacy's map location has not been verified/);
    expect(unverified.message).not.toMatch(/Your location/);
    expect(noOrigin.message).toMatch(/Your location is needed/);
    expect(noOrigin.message).not.toMatch(/verified/);
    for (const r of [unverified, noOrigin]) expect(r).toMatchObject({ code: "MISSING_DISTANCE", factor: "distance", points: 0, factorValue: null });
  });

  it("still gives the generic wording when the cause is not known, and never lets the cause change the percentage", () => {
    expect(message({}).message).toMatch(/not verified, or your location is not set/);
    const percents = [undefined, "PHARMACY_UNVERIFIED", "ORIGIN_UNKNOWN"].map((c) => explainMatch(base({ distanceUnavailable: c as MatchInput["distanceUnavailable"] })).matchPercent);
    expect(new Set(percents).size).toBe(1);
  });
});

describe("through GET /api/search", () => {
  it("gives the unverified Roopam listing no distance, no credit, and an explanation that names the pharmacy's location", async () => {
    const { status, body } = await search(AT);
    expect(status).toBe(200);
    const roopam = body.data.find((r) => r.pharmacy.code === "P002");
    expect(roopam, "P002 is in the results").toBeDefined();
    expect(roopam!.pharmacy.name).toBe("Roopam Medical and General Stores");
    expect(roopam!.pharmacy.locationVerified).toBe(false);
    expect(roopam!.distanceKm).toBeNull();
    expect(roopam!.distanceVerified).toBe(false);
    expect(roopam!.scoreBreakdown.distance).toBe(0);
    expect(distanceReason(roopam!)).toMatchObject({ code: "MISSING_DISTANCE", points: 0, factorValue: null });
    expect(distanceReason(roopam!).message).toMatch(/pharmacy's map location has not been verified/);
  });

  it("gives verified pharmacies a real distance, in order, with credit that falls as they get further", async () => {
    const { body } = await search(AT);
    const near = body.data.find((r) => r.pharmacy.code === "P090")!;
    const far = body.data.find((r) => r.pharmacy.code === "P091")!;
    expect(near.distanceKm).toBeCloseTo(haversineKm(HERE, { latitude: 19.141, longitude: 72.83 }), 1);
    expect(far.distanceKm).toBeCloseTo(haversineKm(HERE, { latitude: 19.2, longitude: 72.9 }), 1);
    expect(near.distanceKm!).toBeLessThan(far.distanceKm!);
    expect(near.distanceVerified && far.distanceVerified).toBe(true);
    expect(distanceReason(near).points).toBeGreaterThan(distanceReason(far).points);
    expect(distanceReason(near).message).toMatch(/km away/);
  });

  it("keeps the factor points adding up to the displayed percentage, with and without a distance", async () => {
    const { body } = await search(AT);
    expect(body.data.length).toBeGreaterThan(3);
    for (const r of body.data) expect(r.matchReasons.reduce((n, m) => n + m.points, 0)).toBe(r.matchPercent);
  });

  it("refuses an invalid origin instead of guessing one (so a missing location can never turn into 0 km)", async () => {
    const bad = await search("lat=abc&lng=72.8");
    expect(bad.status).toBe(400); // an invalid coordinate is refused, not guessed
    const outOfRange = await search("lat=91&lng=72.8");
    expect(outOfRange.status).toBe(400);
    const lng = await search("lat=19.1&lng=181");
    expect(lng.status).toBe(400);
  });

  it("uses the same distance for the filter and the figure shown", async () => {
    const all = (await search(AT)).body.data;
    const near = all.find((r) => r.pharmacy.code === "P090")!.distanceKm!;
    const far = all.find((r) => r.pharmacy.code === "P091")!.distanceKm!;
    const limit = (near + far) / 2;
    const { body } = await search(`${AT}&maxDistanceKm=${limit}`);
    const codes = body.data.map((r) => r.pharmacy.code);
    expect(codes).toContain("P090");
    expect(codes).not.toContain("P091");
    expect(body.data.every((r) => r.distanceKm !== null && r.distanceKm <= limit)).toBe(true);
    expect(body.meta.rejected.find((r) => r.pharmacy.code === "P091")!.distanceKm).toBe(far);
  });
});
