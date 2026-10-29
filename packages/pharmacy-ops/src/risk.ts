/**
 * The stock-risk indicator: a number from 0 to 100 that says how pressing it is to look at one medicine's stock, with the reasons behind it.
 * It is an OPERATIONAL indicator for pharmacy staff, not a forecast and not medical advice. It is pure (no I/O, same input, same answer).
 *
 * What it uses: the units on hand and the low-stock threshold (the configured LOW_STOCK_THRESHOLD, also used for the public "low stock" label).
 * What it does NOT use, on purpose: sales speed or "days of stock left". The only sales history MedLink holds is the portal's movement history,
 * which covers just the sales recorded there since tracking began; a consumption rate computed from it would be a guess. Expiry is out of scope.
 *
 * Formula (version 1). With q units on hand and threshold T (a whole number of at least 1):
 *
 *   q <= T  (the low-stock condition, the same one the alert uses)
 *       base  = 60                       "position": being at or under the threshold is always HIGH or worse
 *       depth = 40 * (T - q) / T         "depth": how much of the threshold level is already gone (q = 0 adds the full 40)
 *       score = round(base + depth)      60 at the threshold, 100 at zero stock
 *   q >  T
 *       cover = q / T
 *       score = min(59, round(60 / cover^2))   falls quickly as stock grows past the threshold, and can never reach the 60 of a breach
 *
 * So a low-stock breach (q <= T) is exactly the scores 60 and above, zero stock is always 100, and stock about 11 times the threshold or more is 0.
 * Levels: 0-24 LOW, 25-49 MODERATE, 50-74 HIGH, 75-100 CRITICAL. Missing or invalid input gives score null and level UNKNOWN: never 0, never 100.
 */
export const RISK_FORMULA_VERSION = 1;

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "UNKNOWN";

export interface RiskFactor {
  id: "position" | "depth" | "demand";
  label: string;
  /** Points this factor contributes to the score. null: the factor is not used (see `available`). */
  points: number | null;
  /** false: MedLink has no reliable data for this factor, so it is not part of the score. */
  available: boolean;
  /** One plain-language sentence. */
  detail: string;
}

export interface RiskAssessment {
  /** 0 to 100, or null when the inputs are missing or invalid. */
  score: number | null;
  level: RiskLevel;
  quantity: number | null;
  threshold: number | null;
  /** quantity <= threshold: the low-stock condition. null when the inputs are unusable. Not the same thing as a high score. */
  belowThreshold: boolean | null;
  factors: RiskFactor[];
  /** One sentence for a list view. */
  summary: string;
  formulaVersion: typeof RISK_FORMULA_VERSION;
}

/** Bounds that keep every intermediate value a safe integer; far above any real stock level. */
const MAX_UNITS = 1_000_000_000;
const BREACH_BASE = 60;
const DEPTH_MAX = 40;
const ABOVE_CAP = BREACH_BASE - 1;

export const riskLevel = (score: number): Exclude<RiskLevel, "UNKNOWN"> => (score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "MODERATE" : "LOW");

const units = (n: number) => `${n} unit${n === 1 ? "" : "s"}`;
const DEMAND_UNUSED: RiskFactor = {
  id: "demand",
  label: "Sales speed",
  points: null,
  available: false,
  detail: "Not used: the only sales history MedLink has is what was recorded in this portal since tracking began, which is too incomplete to estimate how fast it sells.",
};

const validUnits = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= MAX_UNITS;

export function assessStockRisk(input: { quantity: number | null | undefined; threshold: number | null | undefined }): RiskAssessment {
  const { quantity, threshold } = input;
  if (!validUnits(quantity, 0) || !validUnits(threshold, 1)) {
    const why = [
      !validUnits(quantity, 0) && "the current stock is not available",
      !validUnits(threshold, 1) && "the low-stock threshold is not a valid whole number of at least 1",
    ].filter(Boolean);
    return {
      score: null,
      level: "UNKNOWN",
      quantity: validUnits(quantity, 0) ? quantity : null,
      threshold: validUnits(threshold, 1) ? threshold : null,
      belowThreshold: null,
      factors: [{ id: "position", label: "Stock against the threshold", points: null, available: false, detail: `Cannot be assessed: ${why.join(" and ")}.` }, DEMAND_UNUSED],
      summary: `No risk score: ${why.join(" and ")}.`,
      formulaVersion: RISK_FORMULA_VERSION,
    };
  }

  const below = quantity <= threshold;
  const depthRaw = below ? (DEPTH_MAX * (threshold - quantity)) / threshold : 0;
  const score = below ? Math.round(BREACH_BASE + depthRaw) : Math.min(ABOVE_CAP, Math.round(BREACH_BASE / (quantity / threshold) ** 2));
  const depthPoints = below ? Math.round(depthRaw) : 0;
  const level = riskLevel(score);

  const position: RiskFactor = below
    ? {
        id: "position",
        label: "Stock against the threshold",
        points: score - depthPoints,
        available: true,
        detail: `${units(quantity)} on hand is at or below the low-stock threshold of ${threshold}, which starts at ${BREACH_BASE} points.`,
      }
    : {
        id: "position",
        label: "Stock against the threshold",
        points: score,
        available: true,
        detail: `${units(quantity)} on hand is ${(quantity / threshold).toFixed(1)} times the low-stock threshold of ${threshold}, so it scores ${score} of a possible ${ABOVE_CAP} while above it.`,
      };
  const depth: RiskFactor = below
    ? {
        id: "depth",
        label: "How far below the threshold",
        points: depthPoints,
        available: true,
        detail:
          quantity === 0
            ? `Out of stock: all ${units(threshold)} of the threshold level are gone, which adds the full ${DEPTH_MAX} points.`
            : `${units(threshold - quantity)} short of the threshold of ${threshold} (${Math.round(((threshold - quantity) / threshold) * 100)}% of it) adds ${depthPoints} points.`,
      }
    : { id: "depth", label: "How far below the threshold", points: 0, available: true, detail: "Not below the threshold, so this adds nothing." };

  const summary = below
    ? quantity === 0
      ? `Out of stock (threshold ${threshold}): risk ${score}, ${level.toLowerCase()}.`
      : `${units(quantity)} left, at or below the threshold of ${threshold}: risk ${score}, ${level.toLowerCase()}.`
    : `${units(quantity)} on hand, above the threshold of ${threshold}: risk ${score}, ${level.toLowerCase()}.`;

  return { score, level, quantity, threshold, belowThreshold: below, factors: [position, depth, DEMAND_UNUSED], summary, formulaVersion: RISK_FORMULA_VERSION };
}
