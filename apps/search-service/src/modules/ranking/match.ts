import type { RankingWeights } from "./config.js";
import type { ScoreBreakdown } from "./rank.js";

/**
 * Why an offer scored what it did, as a percentage with reasons. Pure (no I/O): the same inputs always give the same answer.
 *
 * The percentage is the EXISTING ranking score (rank.ts: the weighted sum of four factors, each in [0, 1], with weights that sum to 1,
 * so the score is itself in [0, 1]) written out of 100. It is not a new score and it does not change the ordering. It means "how well this
 * offer satisfies MedLink's ranking rules for this search": how well the name matches, whether it is in stock, how near it is and how it is priced.
 * It is NOT a probability, not a clinical suitability, not a recommendation to substitute one medicine for another, and not a promise of availability.
 *
 *   score        = wAvailability·availability + wDistance·distance + wPrice·price + wRelevance·relevance      (rank.ts, in [0, 1])
 *   matchPercent = round(100 × score), with `score` taken at the four decimals the search API publishes it with, so the number a reader
 *                  checks (round(score × 100)) is always the number shown
 * Each factor's share of that is 100 × weight × factor, shown as whole `points`. They are rounded together (largest remainder), so the points of
 * the four factor reasons add up to exactly `matchPercent`: the explanation can never disagree with the number.
 */
export const MATCH_MODEL_VERSION = 1;

export type MatchReasonCode =
  | "NAME_MATCH"
  | "IN_STOCK"
  | "LOW_STOCK"
  | "OUT_OF_STOCK"
  | "NEARBY"
  | "DISTANCE"
  | "MISSING_DISTANCE"
  | "PRICE_COMPARISON"
  | "PRICE_NO_COMPARISON"
  | "MISSING_PRICE";

export interface MatchReason {
  code: MatchReasonCode;
  /** Which of the four ranking factors this explains. */
  factor: "relevance" | "availability" | "distance" | "price";
  /** Whole points this factor adds to `matchPercent`. 0 is a real answer (it earned nothing); the four factors always add up to the percentage. */
  points: number;
  /** The factor's value on its 0 to 1 scale before weighting, or null when it could not be worked out. */
  factorValue: number | null;
  message: string;
}

export interface MatchExplanation {
  /** 0 to 100, a whole number. */
  matchPercent: number;
  /** One reason per ranking factor, in a fixed order: name, stock, distance, price. */
  reasons: MatchReason[];
  modelVersion: typeof MATCH_MODEL_VERSION;
}

export interface MatchInput {
  /** The ranking score, 0 to 1. For reference: the percentage is rebuilt from `breakdown` and `weights` so that it always agrees with the reasons. */
  score: number;
  breakdown: ScoreBreakdown;
  weights: RankingWeights;
  quantity: number;
  price: number | null;
  /** null: no distance can be claimed (the pharmacy's location is not verified, or the origin is unknown). */
  distanceKm: number | null;
  /**
   * Why `distanceKm` is null, when the caller knows: the pharmacy's map point is not verified, or the origin (the user's location) is unknown.
   * Only changes the wording; the factor earns nothing either way.
   */
  distanceUnavailable?: "PHARMACY_UNVERIFIED" | "ORIGIN_UNKNOWN";
  /** How well the name matched: 1 exact brand, 0.9 exact generic, 0.8 brand prefix, 0.6 generic prefix, 0.4 other (medicines/repo.ts). */
  relevance: number;
  maxDistanceKm: number;
  lowStockThreshold: number;
  /** The in-stock offers of this medicine among the eligible results that set the price range. null: unknown. */
  priceRange: { min: number; max: number; count: number } | null;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const rupees = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;
const FACTORS = ["relevance", "availability", "distance", "price"] as const;

/** Splits `total` over `raw` (non-negative shares) as whole numbers that add up to exactly `total`: floors first, then the largest remainders get the rest. */
export function allocatePoints(raw: number[], total: number): number[] {
  const floors = raw.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left--;
  }
  return floors;
}

function relevanceMessage(relevance: number): string {
  if (relevance >= 1) return "Matches the brand name you searched exactly.";
  if (relevance >= 0.9) return "Matches the generic name you searched exactly.";
  if (relevance >= 0.8) return "The brand name starts with what you searched.";
  if (relevance >= 0.6) return "The generic name starts with what you searched.";
  return "Contains the words you searched for.";
}

export function explainMatch(input: MatchInput): MatchExplanation {
  const { breakdown, weights } = input;
  // A factor that is not a usable number earns nothing (never a borrowed value), and the percentage is built from what is usable.
  const value = (n: unknown) => (finite(n) ? clamp01(n) : 0);
  // And a factor whose underlying figure is missing earns nothing whatever the breakdown says, so a reason that says "no credit" can never sit beside points.
  const f = {
    relevance: value(breakdown.relevance),
    availability: finite(input.quantity) ? value(breakdown.availability) : 0,
    distance: finite(input.distanceKm) ? value(breakdown.distance) : 0,
    price: finite(input.price) ? value(breakdown.price) : 0,
  };
  const w = (k: (typeof FACTORS)[number]) => (finite(weights[k]) ? weights[k] : 0);
  const raw = FACTORS.map((k) => 100 * w(k) * f[k]);
  // The same sum and the same four-decimal rounding as rank.ts and the response's `score`, so the percentage and the published score agree.
  const composite = w("availability") * f.availability + w("distance") * f.distance + w("price") * f.price + w("relevance") * f.relevance;
  const matchPercent = Math.min(100, Math.max(0, Math.round((Math.round(composite * 1e4) / 1e4) * 100)));
  const points = allocatePoints(raw, matchPercent);
  const pts = Object.fromEntries(FACTORS.map((k, i) => [k, points[i]!])) as Record<(typeof FACTORS)[number], number>;

  const reasons: MatchReason[] = [
    { code: "NAME_MATCH", factor: "relevance", points: pts.relevance, factorValue: f.relevance, message: relevanceMessage(input.relevance) },
    availability(input, f.availability, pts.availability),
    distance(input, f.distance, pts.distance),
    price(input, f.price, pts.price),
  ];
  return { matchPercent, reasons, modelVersion: MATCH_MODEL_VERSION };
}

function availability(i: MatchInput, f: number, points: number): MatchReason {
  if (!finite(i.quantity)) return { code: "OUT_OF_STOCK", factor: "availability", points, factorValue: null, message: "Stock is not known, so it earns no availability credit." };
  if (i.quantity <= 0) return { code: "OUT_OF_STOCK", factor: "availability", points, factorValue: f, message: "Out of stock here, so it earns no availability credit." };
  if (i.quantity <= i.lowStockThreshold) return { code: "LOW_STOCK", factor: "availability", points, factorValue: f, message: "In stock but running low, so it earns half the availability credit." };
  return { code: "IN_STOCK", factor: "availability", points, factorValue: f, message: "In stock, which earns the full availability credit." };
}

function distance(i: MatchInput, f: number, points: number): MatchReason {
  if (!finite(i.distanceKm)) {
    const message =
      i.distanceUnavailable === "PHARMACY_UNVERIFIED"
        ? "This pharmacy's map location has not been verified, so its distance cannot be calculated and it earns no distance credit. That is not the same as being far away."
        : i.distanceUnavailable === "ORIGIN_UNKNOWN"
          ? "Your location is needed to calculate the distance, so it earns no distance credit. That is not the same as being far away."
          : "No distance is known (this pharmacy's map location is not verified, or your location is not set), so it earns no distance credit. That is not the same as being far away.";
    return { code: "MISSING_DISTANCE", factor: "distance", points, factorValue: null, message };
  }
  const km = i.distanceKm.toFixed(1);
  if (f >= 0.5) return { code: "NEARBY", factor: "distance", points, factorValue: f, message: `About ${km} km away: close enough to earn most of the distance credit.` };
  return { code: "DISTANCE", factor: "distance", points, factorValue: f, message: `About ${km} km away: the further away, the less distance credit (none from ${i.maxDistanceKm} km).` };
}

function price(i: MatchInput, f: number, points: number): MatchReason {
  if (!finite(i.price)) return { code: "MISSING_PRICE", factor: "price", points, factorValue: null, message: "No price is known, so it earns no price credit." };
  const range = i.priceRange;
  const comparable = range !== null && finite(range.min) && finite(range.max) && range.count >= 2 && range.max > range.min;
  if (!comparable) {
    return {
      code: "PRICE_NO_COMPARISON",
      factor: "price",
      points,
      factorValue: f,
      message: `${rupees(i.price)}. There is no other pharmacy with stock in these results to compare it with, so it counts in full and is not described as high or low.`,
    };
  }
  const span = `${rupees(range.min)} to ${rupees(range.max)} across ${range.count} pharmacies with stock in these results`;
  const inStock = finite(i.quantity) && i.quantity > 0;
  const where = !inStock ? `Compared with the in-stock range of ${span}` : f >= 1 ? `The lowest price in ${span}` : f <= 0 ? `The highest price in ${span}` : `Between the lowest and highest price in ${span}`;
  return { code: "PRICE_COMPARISON", factor: "price", points, factorValue: f, message: `${rupees(i.price)}. ${where}: a lower price earns more credit.` };
}
