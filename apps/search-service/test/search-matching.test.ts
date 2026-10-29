/**
 * Match percentages, match reasons and rejected candidates through GET /api/search, on the same fixtures as location-ranking.test.ts:
 * the user stands at Andheri West; test pharmacies P090 (about 0.5 km, 20 at 31) and P091 (about 10 km, 20 at 29) have verified locations,
 * P004 (Bandra, verified, about 9 km) has none of M001 in stock, and P001-P003 and P005 have no verified location, so no distance.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seed, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { REJECTED_SHOWN } from "../src/modules/search/service.js";

let db: Db;
let app: FastifyInstance;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
const AT = "lat=19.1364&lng=72.8296";

interface Reason { code: string; factor: string; points: number; factorValue: number | null; message: string }
interface Result {
  rank: number;
  score: number;
  matchPercent: number;
  matchReasons: Reason[];
  scoreBreakdown: Record<string, number>;
  pharmacy: { code: string; locationVerified: boolean };
  medicine: { id: number; code: string; brandName: string };
  quantity: number;
  price: number;
  stockStatus: string;
  distanceKm: number | null;
}
interface Rejected {
  pharmacy: { code: string };
  medicine: { id: number; code: string };
  quantity: number;
  price: number;
  distanceKm: number | null;
  distanceVerified: boolean;
  reasons: { code: string; filter: string; limit: number | null; actual: number | null; field?: string; message: string }[];
}
interface Summary { total: number; byReason: Record<string, number>; shown: number; truncated: boolean }

beforeAll(async () => {
  db = await freshSeededDb();
  app = await buildApp(db, config, { logger: false });
});
beforeEach(async () => {
  await seed(db);
  await db.query("DELETE FROM pharmacies WHERE code > 'P005'");
  for (const [code, name, lat, lng] of [["P090", "Test Chemist Near", 19.141, 72.83], ["P091", "Test Chemist Far", 19.2, 72.9]] as const) {
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

const get = async (qs = "", q = "Crocin 500mg") => {
  const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${AT}${qs ? "&" + qs : ""}` });
  const body = res.json();
  return { status: res.statusCode, data: body.data as Result[], meta: body.meta, rejected: (body.meta?.rejected ?? []) as Rejected[], summary: body.meta?.rejectionSummary as Summary };
};
const key = (r: { pharmacy: { code: string }; medicine: { code: string } }) => `${r.pharmacy.code}|${r.medicine.code}`;
const byPharmacy = (rows: Result[], code: string) => rows.find((r) => r.pharmacy.code === code)!;
const reasonOf = (r: Result, factor: string) => r.matchReasons.find((x) => x.factor === factor)!;

describe("eligible results carry a match percentage and its reasons", () => {
  it("adds matchPercent (the ranking score out of 100) and one reason per factor, adding up to it", async () => {
    const { data } = await get();
    expect(data).toHaveLength(7);
    for (const r of data) {
      expect(Number.isInteger(r.matchPercent)).toBe(true);
      expect(r.matchPercent).toBeGreaterThanOrEqual(0);
      expect(r.matchPercent).toBeLessThanOrEqual(100);
      expect(r.matchPercent).toBe(Math.round(r.score * 100)); // the same score, not a second one (score is rounded to 4 places)
      expect(r.matchReasons.map((x) => x.factor)).toEqual(["relevance", "availability", "distance", "price"]);
      expect(r.matchReasons.reduce((n, x) => n + x.points, 0)).toBe(r.matchPercent);
      for (const x of r.matchReasons) expect(x.message.length).toBeGreaterThan(10);
    }
  });

  it("keeps the existing fields and the existing order untouched", async () => {
    const { data, meta } = await get();
    expect(data.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const r of data) expect(r.scoreBreakdown).toEqual({ availability: expect.any(Number), distance: expect.any(Number), price: expect.any(Number), relevance: expect.any(Number) });
    for (let i = 1; i < data.length; i++) {
      const [a, b] = [data[i - 1]!, data[i]!];
      expect(Number(a.quantity > 0) >= Number(b.quantity > 0)).toBe(true); // in stock always before out of stock
      if (Number(a.quantity > 0) === Number(b.quantity > 0)) expect(a.score).toBeGreaterThanOrEqual(b.score);
    }
    expect(meta).toMatchObject({ count: 7, weights: { availability: 0.4, distance: 0.3, price: 0.2, relevance: 0.1 }, matchModelVersion: 1 });
    // Same ordering as the same search without any explanation fields being looked at: rank 1 is the best score among in-stock offers.
    expect(data[0]!.matchPercent).toBe(Math.max(...data.filter((r) => r.quantity > 0).map((r) => r.matchPercent)));
  });

  it("explains each factor from the actual data, never claiming what is not known", async () => {
    const { data } = await get();
    // A verified pharmacy 0.5 km away.
    const near = byPharmacy(data, "P090");
    expect(reasonOf(near, "distance")).toMatchObject({ code: "NEARBY" });
    expect(reasonOf(near, "distance").message).toMatch(/About 0\.[4-6] km/);
    expect(reasonOf(near, "availability")).toMatchObject({ code: "IN_STOCK" });
    // Pharmacies without a verified location get no distance, no "nearby", and no points for it.
    for (const code of ["P001", "P002", "P003", "P005"]) {
      const r = byPharmacy(data, code);
      expect(r.distanceKm).toBeNull();
      expect(reasonOf(r, "distance")).toMatchObject({ code: "MISSING_DISTANCE", points: 0, factorValue: null });
      expect(r.matchReasons.map((x) => x.code)).not.toContain("NEARBY");
    }
    // Sold out: no availability credit.
    expect(reasonOf(byPharmacy(data, "P004"), "availability")).toMatchObject({ code: "OUT_OF_STOCK", points: 0 });
    // Low stock earns half.
    expect(reasonOf(byPharmacy(data, "P001"), "availability")).toMatchObject({ code: "LOW_STOCK", points: 20 });
    expect(reasonOf(byPharmacy(data, "P003"), "availability").code).toBe("LOW_STOCK");
    // A real price comparison among the in-stock offers.
    expect(data.filter((r) => r.matchReasons.some((x) => x.code === "PRICE_COMPARISON")).length).toBe(data.length);
    const cheapest = [...data].filter((r) => r.quantity > 0).sort((a, b) => a.price - b.price)[0]!;
    expect(reasonOf(cheapest, "price").message).toMatch(/The lowest price in/);
    const dearest = [...data].filter((r) => r.quantity > 0).sort((a, b) => b.price - a.price)[0]!;
    expect(reasonOf(dearest, "price").message).toMatch(/The highest price in/);
    // The exact-name search matched the brand exactly.
    expect(reasonOf(near, "relevance")).toMatchObject({ code: "NAME_MATCH", points: 10 });
  });

  it("calls the match after the filters: with one eligible offer there is nothing to compare, so no cheapness claim", async () => {
    const { data } = await get("maxDistanceKm=1");
    expect(data.map((r) => r.pharmacy.code)).toEqual(["P090"]);
    const price = reasonOf(data[0]!, "price");
    expect(price.code).toBe("PRICE_NO_COMPARISON");
    expect(price.message).not.toMatch(/lowest|highest|cheap/i);
    expect(price.message).toMatch(/no other pharmacy with stock in these results/);
    expect(data[0]!.matchReasons.reduce((n, x) => n + x.points, 0)).toBe(data[0]!.matchPercent);
  });

  it("gives an out-of-stock offer a percentage too, lower than a comparable one in stock", async () => {
    const { data } = await get();
    const sold = byPharmacy(data, "P004");
    const near = byPharmacy(data, "P090");
    expect(sold.matchPercent).toBeLessThan(near.matchPercent);
    expect(data.at(-1)!.pharmacy.code).toBe("P004");
  });
});

describe("rejected candidates", () => {
  it("are empty when no filter was asked for: a low ranking is never a rejection", async () => {
    const { data, rejected, summary, meta } = await get();
    expect(rejected).toEqual([]);
    expect(summary).toEqual({ total: 0, byReason: {}, shown: 0, truncated: false });
    expect(data.at(-1)!.matchPercent).toBeLessThan(data[0]!.matchPercent); // the lowest-ranked offer is still an eligible result
    expect(meta.count).toBe(data.length);
  });

  it("explain a sold-out offer when in-stock-only is on, with the offer's details and stock", async () => {
    const { data, rejected, summary } = await get("inStock=true");
    expect(data.map((r) => r.pharmacy.code)).not.toContain("P004");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ pharmacy: { code: "P004" }, quantity: 0, distanceVerified: true });
    expect(rejected[0]!.reasons).toEqual([expect.objectContaining({ code: "OUT_OF_STOCK", filter: "inStock", limit: null, actual: 0 })]);
    expect(summary).toEqual({ total: 1, byReason: { OUT_OF_STOCK: 1 }, shown: 1, truncated: false });
  });

  it("explain a verified offer beyond the distance limit, and one whose distance is unknown", async () => {
    const { data, rejected, summary, meta } = await get("maxDistanceKm=2");
    expect(data.map((r) => r.pharmacy.code)).toEqual(["P090"]);
    const far = rejected.find((r) => r.pharmacy.code === "P091")!;
    expect(far.reasons).toEqual([expect.objectContaining({ code: "OUTSIDE_DISTANCE_LIMIT", filter: "maxDistanceKm", limit: 2 })]);
    expect(far.reasons[0]!.actual).toBeGreaterThan(2);
    expect(far.reasons[0]!.message).toMatch(/km away, beyond your limit of 2 km/);
    for (const code of ["P001", "P002", "P003", "P005"]) {
      const r = rejected.find((x) => x.pharmacy.code === code)!;
      expect(r.reasons).toEqual([expect.objectContaining({ code: "MISSING_REQUIRED_DATA", field: "distance", actual: null })]);
      expect(r.distanceKm).toBeNull();
    }
    // P004 (verified, about 9 km) is outside too.
    expect(rejected.find((r) => r.pharmacy.code === "P004")!.reasons[0]!.code).toBe("OUTSIDE_DISTANCE_LIMIT");
    expect(summary).toMatchObject({ total: 6, byReason: { OUTSIDE_DISTANCE_LIMIT: 2, MISSING_REQUIRED_DATA: 4 } });
    // The existing counter keeps its meaning: offers lost ONLY because no distance could be established.
    expect(meta.unverifiedFiltered).toBe(4);
  });

  it("explain a price over the limit, and nothing about price when none was set", async () => {
    const { data, rejected } = await get("maxPrice=30");
    const over = rejected.filter((r) => r.reasons.some((x) => x.code === "PRICE_LIMIT_EXCEEDED"));
    expect(over.map((r) => r.pharmacy.code)).toContain("P090"); // costs 31
    expect(data.map((r) => r.pharmacy.code)).toContain("P091"); // costs 29
    for (const r of over) {
      const reason = r.reasons.find((x) => x.code === "PRICE_LIMIT_EXCEEDED")!;
      expect(reason.limit).toBe(30);
      expect(reason.actual).toBe(r.price);
      expect(r.price).toBeGreaterThan(30);
    }
    const stockOnly = await get("inStock=true");
    expect(stockOnly.rejected.flatMap((r) => r.reasons.map((x) => x.code))).toEqual(["OUT_OF_STOCK"]); // price was never asked for
  });

  it("list every requested filter an offer fails", async () => {
    const { rejected } = await get("inStock=true&maxDistanceKm=5&maxPrice=1000");
    const bandra = rejected.find((r) => r.pharmacy.code === "P004")!;
    expect(bandra.reasons.map((r) => r.code)).toEqual(["OUT_OF_STOCK", "OUTSIDE_DISTANCE_LIMIT"]); // sold out AND about 9 km away; price was fine
  });

  it("partition the candidates exactly: every offer is either a result or rejected, never both, and the rules match what each filter says", async () => {
    const baseline = await get("limit=50", "Crocin");
    const all = baseline.data;
    expect(baseline.rejected).toEqual([]);
    for (const qs of ["inStock=true", "maxPrice=30", "maxDistanceKm=2", "maxDistanceKm=9.5", "inStock=true&maxPrice=29", "inStock=true&maxDistanceKm=1&maxPrice=40", "maxPrice=0.5"]) {
      const f = Object.fromEntries(new URLSearchParams(qs));
      const out = await get(`${qs}&limit=50`, "Crocin");
      const shown = new Set(out.data.map(key));
      const rejected = new Set(out.rejected.map(key));
      expect(out.summary.total).toBe(out.rejected.length); // all fit under the cap in these fixtures
      for (const r of out.data) expect(rejected.has(key(r))).toBe(false); // never both
      expect(shown.size + rejected.size).toBe(all.length); // and nothing is lost
      // The rules, written out independently of the implementation.
      for (const o of all) {
        const fails =
          (f.inStock === "true" && o.quantity <= 0) ||
          (f.maxPrice !== undefined && o.price > Number(f.maxPrice)) ||
          (f.maxDistanceKm !== undefined && (o.distanceKm === null || o.distanceKm > Number(f.maxDistanceKm)));
        expect(rejected.has(key(o)), `${qs}: ${key(o)}`).toBe(fails);
        expect(shown.has(key(o)), `${qs}: ${key(o)}`).toBe(!fails);
      }
      expect(out.meta.count).toBe(out.data.length); // rejected offers never change the count of results
      const counts: Record<string, number> = {};
      for (const r of out.rejected) for (const c of new Set(r.reasons.map((x) => x.code))) counts[c] = (counts[c] ?? 0) + 1;
      expect(out.summary.byReason).toEqual(counts);
    }
  });

  it("never include a rejected offer among the results, and keep the results in their usual order", async () => {
    const withFilter = await get("maxDistanceKm=9.5");
    const without = await get();
    const kept = without.data.filter((r) => withFilter.data.some((x) => key(x) === key(r))).map(key);
    expect(withFilter.data.map(key).sort()).toEqual([...kept].sort());
    expect(withFilter.rejected.every((r) => !withFilter.data.some((x) => key(x) === key(r)))).toBe(true);
  });

  it("are listed in a fixed order, capped, with exact counts in the summary", async () => {
    const out = await get("maxPrice=0.01&limit=50", "tablet");
    expect(out.data).toEqual([]);
    expect(out.summary.total).toBeGreaterThan(REJECTED_SHOWN);
    expect(out.rejected).toHaveLength(REJECTED_SHOWN);
    expect(out.summary).toMatchObject({ shown: REJECTED_SHOWN, truncated: true, byReason: { PRICE_LIMIT_EXCEEDED: out.summary.total } });
    const again = await get("maxPrice=0.01&limit=50", "tablet");
    expect(again.rejected.map(key)).toEqual(out.rejected.map(key));
    const ids = out.rejected.map((r) => r.medicine.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids); // by medicine first
  });

  it("with no eligible result still explain what was evaluated", async () => {
    const out = await get("inStock=true&maxDistanceKm=0.1");
    expect(out.data).toEqual([]);
    expect(out.rejected.length).toBeGreaterThan(0);
    expect(out.summary.total).toBe(7);
    expect(out.meta.matches[0]).toMatchObject({ listed: true }); // the medicine exists and is listed; the filters excluded every offer
  });

  it("are not made up for a medicine that does not match the query, or one nobody lists", async () => {
    const none = await get("maxPrice=1", "zzzznotamedicine");
    expect(none.data).toEqual([]);
    expect(none.rejected).toEqual([]);
    expect(none.summary.total).toBe(0);
  });

  it("carry only public details", async () => {
    const out = await get("inStock=true&maxDistanceKm=2");
    expect(JSON.stringify(out.rejected)).not.toMatch(/riskScore|stock_alert|password|credential|email/i);
    expect(JSON.stringify(out.data)).not.toMatch(/riskScore|stock_alert|password|credential/i);
  });
});

describe("the rest of the search is unchanged", () => {
  it("still validates its inputs", async () => {
    for (const qs of ["maxPrice=0", "maxDistanceKm=-1", "inStock=maybe", "limit=0", "limit=51"]) expect((await get(qs)).status).toBe(400);
  });

  it("leaves the substitutes list as it was: no match percentage, and the same notice", async () => {
    const medicineId = (await db.query<{ id: string }>("SELECT id FROM medicines WHERE code = 'M001'")).rows[0]!.id;
    const res = await app.inject({ method: "GET", url: `/api/medicines/${medicineId}/substitutes?${AT}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.notice).toMatch(/Check with a pharmacist or your doctor/);
    for (const s of res.json().data) {
      expect(s.best).not.toHaveProperty("matchPercent");
      expect(s.best).not.toHaveProperty("matchReasons");
      expect(Object.keys(s).sort()).toEqual(["best", "medicine", "pharmaciesInStock", "sameForm", "sameStrength"]);
    }
  });
});
