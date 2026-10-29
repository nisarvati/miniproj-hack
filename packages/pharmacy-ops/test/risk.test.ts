import { describe, expect, it } from "vitest";
import { assessStockRisk, riskLevel, RISK_FORMULA_VERSION } from "../src/risk.js";

const at = (quantity: number, threshold = 5) => assessStockRisk({ quantity, threshold });

describe("assessStockRisk: the score", () => {
  it("is 100 for zero stock, whatever the threshold", () => {
    for (const t of [1, 2, 5, 50, 1000]) expect(at(0, t)).toMatchObject({ score: 100, level: "CRITICAL", belowThreshold: true });
  });

  it("is exactly 60 at the threshold and falls from 100 to 60 as stock approaches it", () => {
    expect(at(5).score).toBe(60);
    expect([0, 1, 2, 3, 4, 5].map((q) => at(q).score)).toEqual([100, 92, 84, 76, 68, 60]);
    expect(at(1, 1).score).toBe(60); // threshold 1: one unit is AT the threshold
    expect(at(0, 1).score).toBe(100);
  });

  it("drops below 60 as soon as stock is above the threshold, and keeps falling", () => {
    expect([6, 7, 8, 10, 15, 25, 50].map((q) => at(q).score)).toEqual([42, 31, 23, 15, 7, 2, 1]);
    const scores = Array.from({ length: 80 }, (_, i) => at(i).score!);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!); // never rises as stock grows
  });

  it("is a low-stock breach exactly when the score is 60 or more, for any threshold", () => {
    for (const t of [1, 2, 3, 5, 10, 37, 100, 1000]) {
      for (const q of [0, 1, Math.max(0, t - 1), t, t + 1, t * 2, t * 20]) {
        const a = at(q, t);
        expect(a.belowThreshold).toBe(q <= t);
        expect(a.score! >= 60).toBe(q <= t);
      }
    }
    // Rounding can never push stock above the threshold into the breach range.
    expect(at(1001, 1000).score).toBe(59);
  });

  it("reaches 0 for very healthy stock, and stays within 0 to 100 as an integer everywhere", () => {
    expect(at(55).score).toBe(0);
    expect(at(1_000_000).score).toBe(0);
    for (const [q, t] of [[0, 1], [1, 1], [2, 1], [3, 7], [999_999_999, 1], [1_000_000_000, 1_000_000_000], [7, 1_000_000_000]] as const) {
      const s = at(q, t).score!;
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it("is deterministic", () => {
    expect(at(3)).toEqual(at(3));
    expect(JSON.stringify(at(3, 9))).toBe(JSON.stringify(at(3, 9)));
  });
});

describe("assessStockRisk: levels", () => {
  it("maps score ranges to levels at their boundaries", () => {
    expect([0, 24, 25, 49, 50, 74, 75, 100].map(riskLevel)).toEqual(["LOW", "LOW", "MODERATE", "MODERATE", "HIGH", "HIGH", "CRITICAL", "CRITICAL"]);
  });

  it("gives healthy stock a LOW level without a high score, and a breach at least HIGH", () => {
    expect(at(30).level).toBe("LOW");
    expect(at(5).level).toBe("HIGH"); // at the threshold
    expect(at(6).level).toBe("MODERATE"); // just above it
    expect(at(3).level).toBe("CRITICAL");
  });
});

describe("assessStockRisk: explanation", () => {
  it("returns the factors, whose points add up to the score", () => {
    for (const q of [0, 1, 4, 5, 6, 12, 40]) {
      const a = at(q);
      const used = a.factors.filter((f) => f.available);
      expect(used.map((f) => f.id)).toEqual(["position", "depth"]);
      expect(used.reduce((n, f) => n + f.points!, 0)).toBe(a.score);
      for (const f of a.factors) expect(f.detail.length).toBeGreaterThan(10);
    }
  });

  it("explains a breach, zero stock and healthy stock in plain words, with the numbers used", () => {
    expect(at(3).summary).toBe("3 units left, at or below the threshold of 5: risk 76, critical.");
    expect(at(1).summary).toMatch(/^1 unit left/);
    expect(at(0).summary).toBe("Out of stock (threshold 5): risk 100, critical.");
    expect(at(0).factors[1]!.detail).toMatch(/Out of stock.*full 40 points/);
    expect(at(3).factors[0]!.detail).toMatch(/3 units on hand is at or below the low-stock threshold of 5/);
    expect(at(3).factors[1]!.detail).toMatch(/2 units short of the threshold of 5 \(40% of it\) adds 16 points/);
    expect(at(20).factors[0]!.detail).toMatch(/4\.0 times the low-stock threshold of 5/);
    expect(at(20).factors[1]!.points).toBe(0);
  });

  it("says plainly that sales speed is not used, with the reason, and never counts it", () => {
    for (const q of [0, 5, 50, null]) {
      const demand = assessStockRisk({ quantity: q, threshold: 5 }).factors.find((f) => f.id === "demand")!;
      expect(demand).toMatchObject({ available: false, points: null });
      expect(demand.detail).toMatch(/Not used/);
    }
  });

  it("carries the inputs and the formula version", () => {
    expect(at(3, 9)).toMatchObject({ quantity: 3, threshold: 9, formulaVersion: RISK_FORMULA_VERSION });
  });
});

describe("assessStockRisk: missing and invalid input", () => {
  it.each([
    ["no stock figure", { quantity: null, threshold: 5 }],
    ["undefined stock", { quantity: undefined, threshold: 5 }],
    ["negative stock", { quantity: -1, threshold: 5 }],
    ["fractional stock", { quantity: 2.5, threshold: 5 }],
    ["NaN stock", { quantity: Number.NaN, threshold: 5 }],
    ["infinite stock", { quantity: Number.POSITIVE_INFINITY, threshold: 5 }],
    ["absurd stock", { quantity: 1e12, threshold: 5 }],
    ["zero threshold", { quantity: 3, threshold: 0 }],
    ["negative threshold", { quantity: 3, threshold: -2 }],
    ["fractional threshold", { quantity: 3, threshold: 1.5 }],
    ["NaN threshold", { quantity: 3, threshold: Number.NaN }],
    ["no threshold", { quantity: 3, threshold: null }],
    ["a string", { quantity: "3" as unknown as number, threshold: 5 }],
  ])("%s: no score, level UNKNOWN, and an explanation (never 0, never 100)", (_name, input) => {
    const a = assessStockRisk(input);
    expect(a.score).toBeNull();
    expect(a.level).toBe("UNKNOWN");
    expect(a.belowThreshold).toBeNull();
    expect(a.summary).toMatch(/^No risk score:/);
    expect(a.factors[0]).toMatchObject({ available: false, points: null });
    expect(a.factors[0]!.detail).toMatch(/Cannot be assessed/);
    expect(JSON.stringify(a)).not.toMatch(/NaN|Infinity/);
  });

  it("names which input is unusable", () => {
    expect(assessStockRisk({ quantity: null, threshold: 5 }).summary).toMatch(/current stock is not available/);
    expect(assessStockRisk({ quantity: 3, threshold: 0 }).summary).toMatch(/threshold is not a valid/);
    expect(assessStockRisk({ quantity: null, threshold: 0 }).summary).toMatch(/stock is not available and the low-stock threshold/);
  });

  it("accepts the largest sizes it supports", () => {
    expect(at(1_000_000_000, 1_000_000_000).score).toBe(60);
    expect(at(0, 1_000_000_000).score).toBe(100);
  });
});
