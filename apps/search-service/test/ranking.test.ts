import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, normalizeWeights, type RankingConfig } from "../src/modules/ranking/config.js";
import {
  DistanceFirstStrategy,
  PriceFirstStrategy,
  RankingStrategyFactory,
  WeightedMultiCriteriaStrategy,
  rankOffers,
  type RankInput,
} from "../src/modules/ranking/rank.js";
import { loadConfig } from "../src/config.js";

const config = (over: Partial<RankingConfig> = {}): RankingConfig => ({
  weights: DEFAULT_WEIGHTS,
  maxDistanceKm: 10,
  lowStockThreshold: 5,
  ...over,
});
const offer = (id: string, o: Partial<RankInput> = {}) => ({
  id,
  groupKey: 1,
  relevance: 1,
  quantity: 20,
  price: 100,
  distanceKm: 1,
  ...o,
});
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("normalizeWeights", () => {
  it("scales weights to sum to 1", () => {
    const w = normalizeWeights({ availability: 4, distance: 3, price: 2, relevance: 1 });
    expect(w).toEqual(DEFAULT_WEIGHTS);
  });
  it("rejects negative, non-finite and all-zero weights", () => {
    expect(() => normalizeWeights({ ...DEFAULT_WEIGHTS, price: -1 })).toThrow();
    expect(() => normalizeWeights({ ...DEFAULT_WEIGHTS, price: NaN })).toThrow();
    expect(() => normalizeWeights({ availability: 0, distance: 0, price: 0, relevance: 0 })).toThrow();
  });
});

describe("rankOffers: components", () => {
  it("scores availability: in stock 1, low 0.5, out 0", () => {
    const r = rankOffers([offer("in"), offer("low", { quantity: 3 }), offer("out", { quantity: 0 })], config());
    const by = Object.fromEntries(r.map((x) => [x.id, x.breakdown.availability]));
    expect(by).toEqual({ in: 1, low: 0.5, out: 0 });
  });
  it("scores distance linearly and floors at 0 beyond maxDistanceKm", () => {
    const r = rankOffers([offer("a", { distanceKm: 0 }), offer("b", { distanceKm: 5 }), offer("c", { distanceKm: 50 })], config());
    const by = Object.fromEntries(r.map((x) => [x.id, x.breakdown.distance]));
    expect(by).toEqual({ a: 1, b: 0.5, c: 0 });
  });
  it("scores price min-max within a medicine: cheapest 1, dearest 0", () => {
    const r = rankOffers([offer("cheap", { price: 20 }), offer("mid", { price: 25 }), offer("dear", { price: 30 })], config());
    const by = Object.fromEntries(r.map((x) => [x.id, x.breakdown.price]));
    expect(by).toEqual({ cheap: 1, mid: 0.5, dear: 0 });
  });
  it("gives every offer price score 1 when prices are equal", () => {
    const r = rankOffers([offer("a"), offer("b")], config());
    expect(r.map((x) => x.breakdown.price)).toEqual([1, 1]);
  });
  it("compares prices only within the same medicine", () => {
    const r = rankOffers([offer("x1", { groupKey: 1, price: 10 }), offer("x2", { groupKey: 1, price: 20 }), offer("y1", { groupKey: 2, price: 500 })], config());
    expect(r.find((x) => x.id === "y1")!.breakdown.price).toBe(1);
  });
  it("ignores out-of-stock prices when setting the price range", () => {
    const r = rankOffers([offer("a", { price: 20 }), offer("b", { price: 30 }), offer("oos", { price: 1000, quantity: 0 })], config());
    expect(r.find((x) => x.id === "b")!.breakdown.price).toBe(0);
    expect(r.find((x) => x.id === "oos")!.breakdown.price).toBe(0); // clamped, not negative
  });
  it("still scores price when nothing is in stock", () => {
    const r = rankOffers([offer("a", { price: 20, quantity: 0 }), offer("b", { price: 30, quantity: 0 })], config());
    expect(r.map((x) => x.breakdown.price)).toEqual([1, 0]);
  });
});

describe("rankOffers: scoring and ordering", () => {
  it("combines components with the configured weights", () => {
    const [r] = rankOffers([offer("a", { quantity: 3, distanceKm: 5, relevance: 0.5 })], config());
    // availability .5*.4 + distance .5*.3 + price 1*.2 + relevance .5*.1
    expect(r!.score).toBeCloseTo(0.2 + 0.15 + 0.2 + 0.05, 10);
  });
  it("sorts by score descending", () => {
    const r = rankOffers([offer("far", { distanceKm: 9 }), offer("near", { distanceKm: 1 }), offer("mid", { distanceKm: 5 })], config());
    expect(ids(r)).toEqual(["near", "mid", "far"]);
  });
  it("changing weights changes the order", () => {
    const items = [offer("cheapFar", { price: 10, distanceKm: 9 }), offer("dearNear", { price: 50, distanceKm: 0.5 })];
    const byDistance = rankOffers(items, config({ weights: { availability: 0, distance: 1, price: 0, relevance: 0 } }));
    const byPrice = rankOffers(items, config({ weights: { availability: 0, distance: 0, price: 1, relevance: 0 } }));
    expect(ids(byDistance)).toEqual(["dearNear", "cheapFar"]);
    expect(ids(byPrice)).toEqual(["cheapFar", "dearNear"]);
  });
  it("always ranks in-stock offers above out-of-stock ones, even if the latter score higher", () => {
    const r = rankOffers(
      [offer("oosPerfect", { quantity: 0, distanceKm: 0, price: 1 }), offer("farLow", { quantity: 1, distanceKm: 100, price: 999 })],
      config({ weights: { availability: 0, distance: 1, price: 0, relevance: 0 } }),
    );
    expect(ids(r)).toEqual(["farLow", "oosPerfect"]);
  });
  it("breaks ties by distance, then price, then input order", () => {
    const zero = { availability: 1, distance: 0, price: 0, relevance: 0 };
    const r = rankOffers(
      [offer("c", { distanceKm: 2, price: 5 }), offer("b", { distanceKm: 1, price: 9 }), offer("a", { distanceKm: 1, price: 4 }), offer("d", { distanceKm: 2, price: 5 })],
      config({ weights: zero }),
    );
    expect(ids(r)).toEqual(["a", "b", "c", "d"]);
  });
  it("is deterministic and does not mutate its input", () => {
    const items = [offer("a", { distanceKm: 3 }), offer("b", { distanceKm: 1 })];
    const copy = structuredClone(items);
    expect(ids(rankOffers(items, config()))).toEqual(ids(rankOffers(items, config())));
    expect(items).toEqual(copy);
  });
  it("handles an empty list", () => {
    expect(rankOffers([], config())).toEqual([]);
  });
});

describe("config: ranking weights", () => {
  const base = { DATABASE_URL: "x" };
  it("defaults to 40/30/20/10", () => {
    expect(loadConfig(base).ranking.weights).toEqual(DEFAULT_WEIGHTS);
  });
  it("reads and normalises weights from the environment", () => {
    const w = loadConfig({ ...base, RANK_WEIGHT_AVAILABILITY: "1", RANK_WEIGHT_DISTANCE: "1", RANK_WEIGHT_PRICE: "0", RANK_WEIGHT_RELEVANCE: "0" }).ranking.weights;
    expect(w).toEqual({ availability: 0.5, distance: 0.5, price: 0, relevance: 0 });
  });
  it("rejects invalid weights", () => {
    expect(() => loadConfig({ ...base, RANK_WEIGHT_PRICE: "-1" })).toThrow(/Invalid configuration/);
    const zeros = { RANK_WEIGHT_AVAILABILITY: "0", RANK_WEIGHT_DISTANCE: "0", RANK_WEIGHT_PRICE: "0", RANK_WEIGHT_RELEVANCE: "0" };
    expect(() => loadConfig({ ...base, ...zeros })).toThrow(/Invalid configuration/);
  });
});

describe("Design Pattern: Ranking Strategy & Factory", () => {
  const items = [
    offer("near-expensive", { distanceKm: 1, price: 500, quantity: 10 }),
    offer("far-cheap", { distanceKm: 8, price: 50, quantity: 10 }),
  ];

  it("DistanceFirstStrategy ranks closer physical pharmacy higher", () => {
    const strategy = new DistanceFirstStrategy();
    const ranked = strategy.rank(items, config());
    expect(ranked[0]?.id).toBe("near-expensive");
  });

  it("PriceFirstStrategy ranks cheaper pharmacy higher", () => {
    const strategy = new PriceFirstStrategy();
    const ranked = strategy.rank(items, config());
    expect(ranked[0]?.id).toBe("far-cheap");
  });

  it("RankingStrategyFactory instantiates appropriate strategy based on mode", () => {
    expect(RankingStrategyFactory.getStrategy("distance")).toBeInstanceOf(DistanceFirstStrategy);
    expect(RankingStrategyFactory.getStrategy("price")).toBeInstanceOf(PriceFirstStrategy);
    expect(RankingStrategyFactory.getStrategy("balanced")).toBeInstanceOf(WeightedMultiCriteriaStrategy);
    expect(RankingStrategyFactory.getStrategy("unknown")).toBeInstanceOf(WeightedMultiCriteriaStrategy);
  });
});

