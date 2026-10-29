import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, normalizeWeights } from "../src/modules/ranking/config.js";
import { allocatePoints, explainMatch, MATCH_MODEL_VERSION, type MatchInput } from "../src/modules/ranking/match.js";
import { rankOffers } from "../src/modules/ranking/rank.js";
import { evaluateFilters, onlyDistanceUnknown } from "../src/modules/search/rejection.js";

const RANK = { weights: DEFAULT_WEIGHTS, maxDistanceKm: 10, lowStockThreshold: 5 };
const score = (b: MatchInput["breakdown"], w = DEFAULT_WEIGHTS) => w.availability * b.availability + w.distance * b.distance + w.price * b.price + w.relevance * b.relevance;

/** An input whose score is consistent with its breakdown, as the ranking produces. */
const input = (over: Partial<MatchInput> & { breakdown?: MatchInput["breakdown"] } = {}): MatchInput => {
  const breakdown = over.breakdown ?? { availability: 1, distance: 1, price: 1, relevance: 1 };
  return { score: score(breakdown, over.weights ?? DEFAULT_WEIGHTS), weights: DEFAULT_WEIGHTS, quantity: 20, price: 25, distanceKm: 0, relevance: 1, maxDistanceKm: 10, lowStockThreshold: 5, priceRange: { min: 25, max: 40, count: 3 }, breakdown, ...over };
};
const codes = (m: ReturnType<typeof explainMatch>) => m.reasons.map((r) => r.code);
const pointsOf = (m: ReturnType<typeof explainMatch>) => m.reasons.map((r) => r.points);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocatePoints", () => {
  it("splits a total into whole numbers that add up to it exactly, giving the extra to the largest remainders", () => {
    expect(allocatePoints([10, 40, 30, 20], 100)).toEqual([10, 40, 30, 20]);
    expect(allocatePoints([3.5, 3.5, 3.5, 0], 10)).toEqual([4, 3, 3, 0]); // ties go to the earlier one
    expect(allocatePoints([0.6, 0.6, 0.6, 0.2], 2)).toEqual([1, 1, 0, 0]);
    expect(allocatePoints([0, 0, 0, 0], 0)).toEqual([0, 0, 0, 0]);
    for (const raw of [[9.4, 20.7, 30.1, 0.2], [0.49, 0.49, 0.49, 0.49], [33.33, 33.33, 33.34, 0]]) {
      const total = Math.round(sum(raw));
      expect(sum(allocatePoints(raw, total))).toBe(total);
    }
  });
});

describe("explainMatch: the percentage", () => {
  it("is 100 when every factor is full, and the weights decide each share", () => {
    const m = explainMatch(input());
    expect(m.matchPercent).toBe(100);
    expect(pointsOf(m)).toEqual([10, 40, 30, 20]); // relevance, availability, distance, price: the default 10/40/30/20 weights
    expect(codes(m)).toEqual(["NAME_MATCH", "IN_STOCK", "NEARBY", "PRICE_COMPARISON"]);
    expect(m.modelVersion).toBe(MATCH_MODEL_VERSION);
  });

  it("is 0 when no factor earns anything", () => {
    const m = explainMatch(input({ breakdown: { availability: 0, distance: 0, price: 0, relevance: 0 }, quantity: 0, distanceKm: null, relevance: 0 }));
    expect(m.matchPercent).toBe(0);
    expect(pointsOf(m)).toEqual([0, 0, 0, 0]);
  });

  it("is the ranking score written out of 100, rounded, as the response publishes that score (four decimals)", () => {
    const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
    for (const b of [
      { availability: 1, distance: 0.37, price: 0.62, relevance: 0.8 },
      { availability: 0.5, distance: 0, price: 1, relevance: 0.4 },
      { availability: 0, distance: 0.99, price: 0.01, relevance: 1 },
      { availability: 1, distance: 0.005, price: 0.5, relevance: 0.6 },
    ]) {
      const i = input({ breakdown: b });
      expect(explainMatch(i).matchPercent).toBe(Math.round(round4(i.score) * 100));
    }
  });

  it("comes out of the real ranking unchanged: the percentage is the ranking's own score", () => {
    const ranked = rankOffers(
      [
        { groupKey: 1, relevance: 1, quantity: 20, price: 30, distanceKm: 1 },
        { groupKey: 1, relevance: 0.9, quantity: 3, price: 25, distanceKm: 6 },
        { groupKey: 1, relevance: 0.6, quantity: 0, price: 40, distanceKm: null },
      ],
      RANK,
    );
    for (const r of ranked) {
      const m = explainMatch({ score: r.score, breakdown: r.breakdown, weights: DEFAULT_WEIGHTS, quantity: r.quantity, price: r.price, distanceKm: r.distanceKm, relevance: r.relevance, maxDistanceKm: 10, lowStockThreshold: 5, priceRange: { min: 25, max: 30, count: 2 } });
      expect(m.matchPercent).toBe(Math.round((Math.round(r.score * 1e4) / 1e4) * 100));
      expect(sum(pointsOf(m))).toBe(m.matchPercent);
    }
  });

  it("agrees with the published score even when the score sits right on a half percent", () => {
    // Score 0.34499999: unrounded it is 34.499999 percent (34), but the response publishes the score as 0.345, which reads as 35. They must not disagree.
    const w = { availability: 1, distance: 0, price: 0, relevance: 0 };
    const breakdown = { availability: 0.34499999, distance: 0, price: 0, relevance: 0 };
    const m = explainMatch(input({ weights: w, breakdown, score: 0.34499999 }));
    expect(Math.round(0.34499999 * 100)).toBe(34); // what the unrounded score alone would say
    expect(Math.round((Math.round(0.34499999 * 1e4) / 1e4) * 100)).toBe(35); // what a reader of the published score computes
    expect(m.matchPercent).toBe(35);
    expect(sum(pointsOf(m))).toBe(35); // and the reasons still add up to it
  });

  it("always has reasons whose points add up to the percentage, over a grid of inputs", () => {
    const levels = [0, 0.05, 0.25, 0.5, 0.5, 0.75, 0.95, 1];
    let seen = 0;
    for (const availability of [0, 0.5, 1]) for (const distance of levels) for (const price of levels) for (const relevance of [0.4, 0.6, 0.8, 0.9, 1]) {
      const m = explainMatch(input({ breakdown: { availability, distance, price, relevance } }));
      expect(sum(pointsOf(m))).toBe(m.matchPercent);
      expect(m.matchPercent).toBeGreaterThanOrEqual(0);
      expect(m.matchPercent).toBeLessThanOrEqual(100);
      expect(Number.isInteger(m.matchPercent)).toBe(true);
      expect(pointsOf(m).every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
      seen++;
    }
    expect(seen).toBe(3 * 8 * 8 * 5);
  });

  it("works with other weights, and stays between 0 and 100 even if inputs overshoot", () => {
    const w = normalizeWeights({ availability: 1, distance: 1, price: 1, relevance: 1 });
    const b = { availability: 1, distance: 0.5, price: 0, relevance: 1 };
    const m = explainMatch(input({ breakdown: b, weights: w, score: score(b, w) }));
    expect(m.matchPercent).toBe(63); // (1 + 0.5 + 0 + 1) / 4
    expect(sum(pointsOf(m))).toBe(63);
    const over = explainMatch(input({ breakdown: { availability: 5, distance: 7, price: 9, relevance: 3 } }));
    expect(over.matchPercent).toBe(100);
    const neg = explainMatch(input({ breakdown: { availability: -1, distance: -3, price: -2, relevance: -1 } }));
    expect(neg.matchPercent).toBe(0);
  });

  it("is deterministic and does not touch its input", () => {
    const i = input({ breakdown: { availability: 0.5, distance: 0.37, price: 0.62, relevance: 0.8 } });
    const copy = JSON.parse(JSON.stringify(i));
    expect(explainMatch(i)).toEqual(explainMatch(i));
    expect(JSON.stringify(explainMatch(i))).toBe(JSON.stringify(explainMatch(i)));
    expect(JSON.parse(JSON.stringify(i))).toEqual(copy);
  });
});

describe("explainMatch: the reasons", () => {
  it("describes the name match by how the name matched", () => {
    const msg = (relevance: number) => explainMatch(input({ relevance })).reasons[0]!.message;
    expect(msg(1)).toMatch(/brand name you searched exactly/);
    expect(msg(0.9)).toMatch(/generic name you searched exactly/);
    expect(msg(0.8)).toMatch(/brand name starts with/);
    expect(msg(0.6)).toMatch(/generic name starts with/);
    expect(msg(0.4)).toMatch(/Contains the words/);
  });

  it("explains stock as in stock, running low (half credit) or out of stock (none)", () => {
    expect(explainMatch(input({ quantity: 50 })).reasons[1]).toMatchObject({ code: "IN_STOCK", factor: "availability" });
    const low = explainMatch(input({ quantity: 3, breakdown: { availability: 0.5, distance: 1, price: 1, relevance: 1 } })).reasons[1]!;
    expect(low).toMatchObject({ code: "LOW_STOCK", points: 20 });
    expect(low.message).toBe("In stock but running low, so it earns half the availability credit.");
    const out = explainMatch(input({ quantity: 0, breakdown: { availability: 0, distance: 1, price: 1, relevance: 1 } })).reasons[1]!;
    expect(out).toMatchObject({ code: "OUT_OF_STOCK", points: 0 });
    expect(out.message).toMatch(/no availability credit/);
    expect(explainMatch(input({ quantity: 5 })).reasons[1]!.code).toBe("LOW_STOCK"); // exactly at the threshold
    expect(explainMatch(input({ quantity: 6 })).reasons[1]!.code).toBe("IN_STOCK");
  });

  it("never puts a unit count in a message: the public site does not show how many units a pharmacy has", () => {
    for (const quantity of [0, 1, 3, 5, 6, 40, 12345]) {
      const text = explainMatch(input({ quantity, breakdown: { availability: quantity === 0 ? 0 : 1, distance: 1, price: 1, relevance: 1 } })).reasons[1]!.message;
      expect(text).not.toMatch(/\d/);
    }
    expect(evaluateFilters({ quantity: 0, price: 5, distanceKm: 1 }, { inStock: true })[0]!.message).not.toMatch(/\d/);
  });

  it("never claims a distance it does not have, and says missing is not the same as far", () => {
    const m = explainMatch(input({ distanceKm: null, breakdown: { availability: 1, distance: 0, price: 1, relevance: 1 } })).reasons[2]!;
    expect(m).toMatchObject({ code: "MISSING_DISTANCE", points: 0, factorValue: null });
    expect(m.message).toMatch(/not verified.*no distance credit.*not the same as being far away/s);
    expect(m.message).not.toMatch(/\bkm\b/);
  });

  it("calls a pharmacy nearby only when the distance earns at least half the credit, and shows the distance to one decimal", () => {
    const near = explainMatch(input({ distanceKm: 4.96, breakdown: { availability: 1, distance: 0.5, price: 1, relevance: 1 } })).reasons[2]!;
    expect(near.code).toBe("NEARBY");
    expect(near.message).toMatch(/About 5\.0 km/);
    const far = explainMatch(input({ distanceKm: 8, breakdown: { availability: 1, distance: 0.2, price: 1, relevance: 1 } })).reasons[2]!;
    expect(far.code).toBe("DISTANCE");
    expect(far.message).toMatch(/About 8\.0 km.*none from 10 km/);
    const beyond = explainMatch(input({ distanceKm: 25, breakdown: { availability: 1, distance: 0, price: 1, relevance: 1 } })).reasons[2]!;
    expect(beyond).toMatchObject({ code: "DISTANCE", points: 0 });
  });

  it("makes a price claim only against a real comparison set", () => {
    const lowest = explainMatch(input({ price: 25, priceRange: { min: 25, max: 40, count: 3 } })).reasons[3]!;
    expect(lowest.code).toBe("PRICE_COMPARISON");
    expect(lowest.message).toBe("₹25. The lowest price in ₹25 to ₹40 across 3 pharmacies with stock in these results: a lower price earns more credit.");
    const highest = explainMatch(input({ price: 40, priceRange: { min: 25, max: 40, count: 3 }, breakdown: { availability: 1, distance: 1, price: 0, relevance: 1 } })).reasons[3]!;
    expect(highest.message).toMatch(/The highest price in/);
    const middle = explainMatch(input({ price: 30.5, priceRange: { min: 25, max: 40, count: 3 }, breakdown: { availability: 1, distance: 1, price: 0.37, relevance: 1 } })).reasons[3]!;
    expect(middle.message).toMatch(/^₹30\.50\. Between the lowest and highest price/);
    // An offer with no stock is compared with the in-stock range but never called lowest or highest.
    const sold = explainMatch(input({ quantity: 0, price: 20, priceRange: { min: 25, max: 40, count: 3 }, breakdown: { availability: 0, distance: 1, price: 1, relevance: 1 } })).reasons[3]!;
    expect(sold.message).toMatch(/Compared with the in-stock range/);
    expect(sold.message).not.toMatch(/lowest|highest/);
  });

  it.each([
    ["only one offer", { min: 25, max: 25, count: 1 }],
    ["equal prices", { min: 30, max: 30, count: 4 }],
    ["two offers at one price", { min: 30, max: 30, count: 2 }],
    ["a range of one", { min: 25, max: 40, count: 1 }],
    ["no range at all", null],
  ])("makes no cheapness claim with %s", (_name, priceRange) => {
    const r = explainMatch(input({ priceRange })).reasons[3]!;
    expect(r.code).toBe("PRICE_NO_COMPARISON");
    expect(r.message).toMatch(/no other pharmacy with stock in these results to compare it with/);
    expect(r.message).not.toMatch(/lowest|highest|cheap(er|est)|best price/i);
    expect(r.points).toBe(explainMatch(input({ priceRange })).reasons[3]!.points); // it still earns what the ranking gave it
  });

  it("says so when a price is missing, and gives it no credit", () => {
    for (const price of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = explainMatch(input({ price, breakdown: { availability: 1, distance: 1, price: 0, relevance: 1 } })).reasons[3]!;
      expect(r).toMatchObject({ code: "MISSING_PRICE", points: 0, factorValue: null });
      expect(r.message).toMatch(/No price is known/);
    }
  });

  it("treats a factor that is not a usable number as earning nothing, and never outputs NaN or Infinity", () => {
    const m = explainMatch(input({ breakdown: { availability: Number.NaN, distance: Number.POSITIVE_INFINITY, price: undefined as unknown as number, relevance: 1 }, score: Number.NaN, distanceKm: Number.NaN, quantity: Number.NaN }));
    expect(Number.isInteger(m.matchPercent)).toBe(true);
    expect(sum(pointsOf(m))).toBe(m.matchPercent);
    expect(JSON.stringify(m)).not.toMatch(/NaN|Infinity|undefined/);
    expect(m.reasons[1]!.code).toBe("OUT_OF_STOCK"); // unknown stock is never "in stock"
    expect(m.reasons[2]!.code).toBe("MISSING_DISTANCE");
  });

  it("never awards points for a figure that is missing, even if the breakdown it was given claims credit", () => {
    const full = { availability: 1, distance: 1, price: 1, relevance: 1 };
    const m = explainMatch(input({ breakdown: full, score: 1, distanceKm: null, price: null, quantity: Number.NaN }));
    expect(m.reasons.map((r) => [r.code, r.points])).toEqual([["NAME_MATCH", 10], ["OUT_OF_STOCK", 0], ["MISSING_DISTANCE", 0], ["MISSING_PRICE", 0]]);
    expect(m.matchPercent).toBe(10);
    expect(sum(pointsOf(m))).toBe(m.matchPercent);
  });

  it("has exactly one reason per ranking factor, in a fixed order", () => {
    for (const quantity of [0, 3, 50]) for (const distanceKm of [null, 0.5, 9]) {
      const m = explainMatch(input({ quantity, distanceKm }));
      expect(m.reasons.map((r) => r.factor)).toEqual(["relevance", "availability", "distance", "price"]);
    }
  });
});

describe("evaluateFilters", () => {
  const offer = { quantity: 10, price: 30, distanceKm: 2 as number | null };

  it("rejects nothing when no filter was asked for, however sold out, dear, far or unlocated the offer is", () => {
    for (const o of [offer, { quantity: 0, price: 9999, distanceKm: 400 }, { quantity: 0, price: 5, distanceKm: null }]) expect(evaluateFilters(o, {})).toEqual([]);
    expect(evaluateFilters({ quantity: 0, price: 9999, distanceKm: null }, { sort: "price" })).toEqual([]); // sorting is not filtering
  });

  it("OUT_OF_STOCK needs the in-stock filter, and low stock still counts as stock", () => {
    expect(evaluateFilters({ ...offer, quantity: 0 }, { inStock: true })).toEqual([expect.objectContaining({ code: "OUT_OF_STOCK", filter: "inStock", limit: null, actual: 0 })]);
    expect(evaluateFilters({ ...offer, quantity: 0 }, { inStock: false })).toEqual([]);
    expect(evaluateFilters({ ...offer, quantity: 1 }, { inStock: true })).toEqual([]);
  });

  it("PRICE_LIMIT_EXCEEDED is strictly above the limit", () => {
    expect(evaluateFilters({ ...offer, price: 30.01 }, { maxPrice: 30 })).toEqual([expect.objectContaining({ code: "PRICE_LIMIT_EXCEEDED", limit: 30, actual: 30.01 })]);
    expect(evaluateFilters({ ...offer, price: 30 }, { maxPrice: 30 })).toEqual([]);
    expect(evaluateFilters({ ...offer, price: 29.99 }, { maxPrice: 30 })).toEqual([]);
  });

  it("OUTSIDE_DISTANCE_LIMIT is strictly beyond the limit and needs a verified distance", () => {
    expect(evaluateFilters({ ...offer, distanceKm: 5.01 }, { maxDistanceKm: 5 })).toEqual([expect.objectContaining({ code: "OUTSIDE_DISTANCE_LIMIT", limit: 5, actual: 5.01 })]);
    expect(evaluateFilters({ ...offer, distanceKm: 5 }, { maxDistanceKm: 5 })).toEqual([]);
  });

  it("MISSING_REQUIRED_DATA when a requested limit cannot be checked, and only then", () => {
    const d = evaluateFilters({ ...offer, distanceKm: null }, { maxDistanceKm: 5 });
    expect(d).toEqual([expect.objectContaining({ code: "MISSING_REQUIRED_DATA", filter: "maxDistanceKm", field: "distance", actual: null })]);
    expect(d[0]!.message).toMatch(/cannot be shown to be within your limit of 5 km/);
    expect(evaluateFilters({ ...offer, distanceKm: null }, { maxPrice: 50, inStock: true })).toEqual([]); // no distance limit was asked for
    expect(evaluateFilters({ ...offer, price: null }, { maxPrice: 50 })).toEqual([expect.objectContaining({ code: "MISSING_REQUIRED_DATA", field: "price" })]);
    expect(evaluateFilters({ ...offer, price: Number.NaN }, { maxPrice: 50 })[0]!.code).toBe("MISSING_REQUIRED_DATA");
    expect(evaluateFilters({ ...offer, price: null }, {})).toEqual([]);
  });

  it("reports every failed filter, in a fixed order, not just the first", () => {
    const all = evaluateFilters({ quantity: 0, price: 80, distanceKm: 12 }, { inStock: true, maxPrice: 50, maxDistanceKm: 5 });
    expect(all.map((r) => r.code)).toEqual(["OUT_OF_STOCK", "PRICE_LIMIT_EXCEEDED", "OUTSIDE_DISTANCE_LIMIT"]);
    const some = evaluateFilters({ quantity: 0, price: 20, distanceKm: null }, { inStock: true, maxPrice: 50, maxDistanceKm: 5 });
    expect(some.map((r) => r.code)).toEqual(["OUT_OF_STOCK", "MISSING_REQUIRED_DATA"]);
  });

  it("only mentions the limits that were requested, with plain wording", () => {
    const m = evaluateFilters({ quantity: 0, price: 80, distanceKm: 12 }, { inStock: true }).map((r) => r.message).join(" ");
    expect(m).toMatch(/Out of stock/);
    expect(m).not.toMatch(/limit of|km|₹/);
    expect(evaluateFilters({ ...offer, price: 80 }, { maxPrice: 50 })[0]!.message).toBe("Costs ₹80, above your limit of ₹50.");
  });

  it("recognises the offers lost only because their distance is unknown", () => {
    expect(onlyDistanceUnknown(evaluateFilters({ ...offer, distanceKm: null }, { maxDistanceKm: 5 }))).toBe(true);
    expect(onlyDistanceUnknown(evaluateFilters({ ...offer, quantity: 0, distanceKm: null }, { maxDistanceKm: 5, inStock: true }))).toBe(false);
    expect(onlyDistanceUnknown(evaluateFilters({ ...offer, price: null }, { maxPrice: 5 }))).toBe(false);
    expect(onlyDistanceUnknown([])).toBe(false);
  });
});
