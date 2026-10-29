/**
 * ============================================================================
 * Module: MedLink Search & Discovery Engine
 * Component: Medicine Offer Ranking & Recommendation
 * Design Patterns:
 *   1. Strategy Pattern (Interchangeable ranking algorithms: Multi-Criteria,
 *      Distance-First, Price-First)
 *   2. Factory Method Pattern (Strategy instantiation based on user intent)
 *
 * Case Study: MedLink Distributed Real-Time Medicine Availability Platform
 * ============================================================================
 */

import { stockStatus } from "../inventory/stock.js";
import type { RankingConfig } from "./config.js";

/**
 * Common input structure required for evaluating any pharmacy's medicine offer.
 */
export interface RankInput {
  /**
   * Medicine identifier or group key.
   * Why groupKey is necessary:
   *   Price comparisons are strictly relative within the same medicine group.
   *   Comparing a ₹20 Paracetamol offer against a ₹600 specialized inhaler
   *   across groups would create mathematically skewed price normalizations.
   */
  groupKey: number;

  /** Textual query matching relevance score, bounded in [0, 1]. */
  relevance: number;

  /** Units currently in stock at the physical pharmacy. */
  quantity: number;

  /** Unit price in Indian Rupees (INR) at this specific pharmacy. */
  price: number;

  /**
   * Physical Haversine distance from patient to pharmacy in kilometers, or null when it cannot be claimed: the pharmacy's
   * map point is not verified, or the patient's origin is unknown. Null is never replaced by a guess.
   */
  distanceKm: number | null;
}

/**
 * Normalized multidimensional scores for transparency and UI explanation.
 */
export interface ScoreBreakdown {
  availability: number;
  distance: number;
  price: number;
  relevance: number;
}

/**
 * Augmented offer item containing final composite score and breakdown.
 */
export type Ranked<T> = T & { score: number; breakdown: ScoreBreakdown };

/**
 * Restricts values strictly to the closed unit interval [0, 1].
 * Why clamping is necessary:
 *   Prevents edge-case anomalies (e.g. distance exceeding maxDistanceKm)
 *   from producing negative values that distort linear weighted sums.
 */
const clampUnitInterval = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * ----------------------------------------------------------------------------
 * DESIGN PATTERN: STRATEGY PATTERN
 * ----------------------------------------------------------------------------
 * Intent:
 *   Define a family of ranking algorithms, encapsulate each one, and make
 *   them interchangeable at runtime.
 *
 * Why Strategy Pattern is used here:
 *   1. Context-Dependent Clinical Scenarios:
 *      - Routine prescription refill: Patients want the most balanced
 *        trade-off between distance, price, and stock (Weighted Multi-Criteria).
 *      - Acute emergency: Distance and immediate shelf stock override price.
 *      - Chronic medication on a tight budget: Price minimization takes priority.
 *   2. Open/Closed Principle:
 *      New ranking heuristics (e.g., Pharmacy Reputation, 24x7 Hours, Delivery
 *      Time) can be introduced as new Strategy classes without touching the
 *      core search controllers or SQL queries.
 */
export interface RankingStrategy<T extends RankInput = RankInput> {
  rank(items: T[], config: RankingConfig): Ranked<T>[];
}

/**
 * Helper function: Computes min and max prices within each medicine group.
 *
 * Why out-of-stock items are filtered during price range discovery:
 *   A pharmacy advertising an artificially cheap or exorbitant price for an
 *   out-of-stock item should not distort the scale for medicines patients can
 *   actually purchase. If no pharmacy has stock, all items are used as fallback.
 */
export function calculateGroupPriceRanges(items: RankInput[]): Map<number, { min: number; max: number; count: number }> {
  const groups = new Map<number, RankInput[]>();
  for (const item of items) {
    groups.set(item.groupKey, [...(groups.get(item.groupKey) ?? []), item]);
  }

  // `count` is how many offers set the range: the comparison set a price claim can honestly be made against.
  const ranges = new Map<number, { min: number; max: number; count: number }>();
  for (const [key, group] of groups) {
    const available = group.filter((g) => g.quantity > 0);
    const prices = (available.length > 0 ? available : group).map((g) => g.price);
    ranges.set(key, { min: Math.min(...prices), max: Math.max(...prices), count: prices.length });
  }
  return ranges;
}

/**
 * Concrete Strategy 1: WeightedMultiCriteriaStrategy (Default)
 *
 * Evaluates offers using a normalized multi-factor linear scoring model:
 *   Score = (w_avail * S_avail) + (w_dist * S_dist) + (w_price * S_price) + (w_rel * S_rel)
 *
 * Why in-stock offers always partition above out-of-stock offers:
 *   In healthcare e-commerce, offering a patient an out-of-stock medicine simply
 *   because it is physically nearby is unusable. Physical stock availability is
 *   a mandatory prerequisite before sorting by score.
 */
/** Nearer first; an unknown distance sorts after every known one and ties with another unknown. */
export function compareDistance(a: number | null, b: number | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a - b;
}

export class WeightedMultiCriteriaStrategy implements RankingStrategy {
  rank<T extends RankInput>(items: T[], config: RankingConfig): Ranked<T>[] {
    const { weights, maxDistanceKm, lowStockThreshold } = config;
    const priceRanges = calculateGroupPriceRanges(items);

    const scored = items.map((item, originalIndex) => {
      const status = stockStatus(item.quantity, lowStockThreshold);
      const range = priceRanges.get(item.groupKey)!;

      // Min-max normalization: cheapest gets 1.0, highest gets 0.0
      const priceScore =
        range.max === range.min
          ? 1
          : clampUnitInterval((range.max - item.price) / (range.max - range.min));

      const breakdown: ScoreBreakdown = {
        availability: status === "IN_STOCK" ? 1 : status === "LOW_STOCK" ? 0.5 : 0,
        // Unknown distance earns no distance credit.
        distance: item.distanceKm === null ? 0 : clampUnitInterval(1 - item.distanceKm / maxDistanceKm),
        price: priceScore,
        relevance: clampUnitInterval(item.relevance),
      };

      // No verified distance means no distance credit (the distance term is 0), never a borrowed or guessed one. The other
      // criteria count in full, so an unverified pharmacy is still found, but it cannot outrank an equal verified neighbour.
      const compositeScore =
        weights.availability * breakdown.availability +
        weights.distance * breakdown.distance +
        weights.price * breakdown.price +
        weights.relevance * breakdown.relevance;

      return {
        item: { ...item, score: compositeScore, breakdown } as Ranked<T>,
        isAvailable: item.quantity > 0,
        originalIndex,
      };
    });

    // Deterministic tiered sort:
    // 1. Available offers always outrank out-of-stock offers.
    // 2. Higher composite score first.
    // 3. Distance tie-breaker (nearer first).
    // 4. Price tie-breaker (cheaper first).
    // 5. Stable input order preservation.
    scored.sort(
      (a, b) =>
        Number(b.isAvailable) - Number(a.isAvailable) ||
        b.item.score - a.item.score ||
        compareDistance(a.item.distanceKm, b.item.distanceKm) ||
        a.item.price - b.item.price ||
        a.originalIndex - b.originalIndex,
    );

    return scored.map((s) => s.item);
  }
}

/**
 * Concrete Strategy 2: DistanceFirstStrategy
 *
 * Emergency Mode: Maximizes proximity to the patient.
 */
export class DistanceFirstStrategy implements RankingStrategy {
  private readonly delegate = new WeightedMultiCriteriaStrategy();

  rank<T extends RankInput>(items: T[], config: RankingConfig): Ranked<T>[] {
    // Override weights to prioritize distance
    return this.delegate.rank(items, {
      ...config,
      weights: { availability: 0.2, distance: 0.7, price: 0.05, relevance: 0.05 },
    });
  }
}

/**
 * Concrete Strategy 3: PriceFirstStrategy
 *
 * Affordability Mode: Maximizes savings for price-sensitive patients.
 */
export class PriceFirstStrategy implements RankingStrategy {
  private readonly delegate = new WeightedMultiCriteriaStrategy();

  rank<T extends RankInput>(items: T[], config: RankingConfig): Ranked<T>[] {
    // Override weights to prioritize lowest unit price
    return this.delegate.rank(items, {
      ...config,
      weights: { availability: 0.2, distance: 0.1, price: 0.65, relevance: 0.05 },
    });
  }
}

/**
 * ----------------------------------------------------------------------------
 * DESIGN PATTERN: FACTORY METHOD PATTERN
 * ----------------------------------------------------------------------------
 * Instantiates the appropriate RankingStrategy based on user intent/sorting preference.
 */
export type RankingMode = "balanced" | "distance" | "price";

export class RankingStrategyFactory {
  static getStrategy(mode: RankingMode | string = "balanced"): RankingStrategy {
    switch (mode.toLowerCase().trim()) {
      case "distance":
        return new DistanceFirstStrategy();
      case "price":
        return new PriceFirstStrategy();
      case "balanced":
      default:
        return new WeightedMultiCriteriaStrategy();
    }
  }
}

/**
 * Public facade function matching legacy API signature.
 * Delegates execution to the default WeightedMultiCriteriaStrategy.
 */
export function rankOffers<T extends RankInput>(items: T[], config: RankingConfig): Ranked<T>[] {
  const strategy = new WeightedMultiCriteriaStrategy();
  return strategy.rank(items, config);
}

