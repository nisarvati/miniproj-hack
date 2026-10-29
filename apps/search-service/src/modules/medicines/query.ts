import { AppError } from "../../errors.js";

export interface MedicineQuery {
  /** Free-text words that must each match brand, generic name or form. */
  terms: string[];
  /** Dosage tokens (e.g. "500mg"), each of which must appear in the medicine's dosage. */
  dosages: string[];
}

const UNIT = "(?:mg|mcg|g|ml|iu|%)";
const NUM = "\\d+(?:\\.\\d+)?";
const DOSAGE_TOKEN = new RegExp(`^${NUM}${UNIT}?(?:/${NUM}${UNIT}?)*$`);
const MAX_TERMS = 5;

/**
 * "Crocin 500mg" -> { terms: ["crocin"], dosages: ["500mg"] }.
 * Deterministic and pure; no database access.
 */
export function parseMedicineQuery(raw: string): MedicineQuery {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(new RegExp(`(\\d) (${UNIT})(?![a-z])`, "g"), "$1$2"); // "500 mg" -> "500mg"

  const terms: string[] = [];
  const dosages: string[] = [];
  for (const token of normalized.split(" ").filter(Boolean)) {
    (DOSAGE_TOKEN.test(token) ? dosages : terms).push(token);
  }
  if (terms.length + dosages.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "Search query is empty");
  }
  if (terms.length > MAX_TERMS) {
    throw new AppError(400, "VALIDATION_ERROR", `Search query has too many words (max ${MAX_TERMS})`);
  }
  return { terms, dosages };
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** Regex matching `dosage` as a whole value inside a stored dosage string like "400mg/325mg". */
export function dosagePattern(dosage: string): string {
  const escaped = dosage.replace(/[.]/g, "\\.");
  const hasUnit = /[a-z%]$/.test(dosage);
  // A bare number ("500") may be followed by its unit; a full value ("500mg") may not be followed by more of the name.
  const tail = hasUnit ? "($|[^a-z0-9])" : "($|[^0-9.])";
  return `(^|[^0-9.])${escaped}${tail}`;
}
