export interface RankingWeights {
  availability: number;
  distance: number;
  price: number;
  relevance: number;
}

export interface RankingConfig {
  /** Normalised so the four weights sum to 1. */
  weights: RankingWeights;
  /** Distance at (and beyond) which a pharmacy gets a distance score of 0. */
  maxDistanceKm: number;
  /** Quantity at or below which stock is "LOW_STOCK". */
  lowStockThreshold: number;
}

/** Initial product ranking strategy. Not derived from any medical or empirical optimisation. */
export const DEFAULT_WEIGHTS: RankingWeights = { availability: 0.4, distance: 0.3, price: 0.2, relevance: 0.1 };

export function normalizeWeights(w: RankingWeights): RankingWeights {
  const values = Object.values(w);
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    throw new Error("Ranking weights must be finite and non-negative");
  }
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("Ranking weights must not all be zero");
  // Rounded so float drift (0.4 + 0.3 + 0.2 + 0.1 !== 1) doesn't leak into API output.
  const n = (v: number) => Math.round((v / sum) * 1e12) / 1e12;
  return { availability: n(w.availability), distance: n(w.distance), price: n(w.price), relevance: n(w.relevance) };
}
