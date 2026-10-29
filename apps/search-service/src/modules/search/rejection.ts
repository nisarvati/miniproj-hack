import type { SearchFilters } from "./service.js";

/**
 * Why an offer was left out of the results: only ever a filter the person actually asked for, evaluated on the actual offer. A low ranking is never a
 * rejection (every offer that passes the filters is shown, however it ranks).
 *
 *   OUT_OF_STOCK            "In stock only" was on, and it has none.
 *   PRICE_LIMIT_EXCEEDED    a maximum price was set, and its price is above it.
 *   OUTSIDE_DISTANCE_LIMIT  a maximum distance was set, and its verified distance is beyond it.
 *   MISSING_REQUIRED_DATA   a filter needs a figure the offer does not have: a maximum distance with no verified distance (`field: "distance"`), or a
 *                           maximum price with no price (`field: "price"`). It cannot be shown to satisfy the filter, so it is not shown as if it did.
 *
 * There is deliberately no DOES_NOT_MATCH_QUERY: medicines that do not match the search are never candidates, so there is nothing evaluated to reject.
 */
export type RejectionCode = "OUT_OF_STOCK" | "PRICE_LIMIT_EXCEEDED" | "OUTSIDE_DISTANCE_LIMIT" | "MISSING_REQUIRED_DATA";

export interface Rejection {
  code: RejectionCode;
  /** The filter that rejected it. */
  filter: "inStock" | "maxPrice" | "maxDistanceKm";
  message: string;
  /** The limit that was requested (not set for "in stock only"). */
  limit: number | null;
  /** The offer's own value that was compared with it, or null when it has none. */
  actual: number | null;
  /** MISSING_REQUIRED_DATA only: which figure is missing. */
  field?: "distance" | "price";
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const rupees = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/**
 * Every requested filter the offer fails, not just the first, so an offer that is both sold out and too far away says both. An empty list means it is
 * eligible. Pure; this is the single place that decides eligibility, so the explanation and the result list can never disagree.
 */
export function evaluateFilters(offer: { quantity: number; price: number | null; distanceKm: number | null }, filters: SearchFilters): Rejection[] {
  const out: Rejection[] = [];
  if (filters.inStock && !(finite(offer.quantity) && offer.quantity > 0)) {
    out.push({ code: "OUT_OF_STOCK", filter: "inStock", message: "Out of stock, and you chose in-stock pharmacies only.", limit: null, actual: finite(offer.quantity) ? offer.quantity : null });
  }
  if (filters.maxPrice !== undefined) {
    if (!finite(offer.price)) {
      out.push({ code: "MISSING_REQUIRED_DATA", filter: "maxPrice", field: "price", message: `Its price is not known, so it cannot be shown to be within your limit of ${rupees(filters.maxPrice)}.`, limit: filters.maxPrice, actual: null });
    } else if (offer.price > filters.maxPrice) {
      out.push({ code: "PRICE_LIMIT_EXCEEDED", filter: "maxPrice", message: `Costs ${rupees(offer.price)}, above your limit of ${rupees(filters.maxPrice)}.`, limit: filters.maxPrice, actual: offer.price });
    }
  }
  if (filters.maxDistanceKm !== undefined) {
    if (!finite(offer.distanceKm)) {
      out.push({
        code: "MISSING_REQUIRED_DATA",
        filter: "maxDistanceKm",
        field: "distance",
        message: `Its location is not verified (or yours is not set), so it cannot be shown to be within your limit of ${filters.maxDistanceKm} km.`,
        limit: filters.maxDistanceKm,
        actual: null,
      });
    } else if (offer.distanceKm > filters.maxDistanceKm) {
      out.push({ code: "OUTSIDE_DISTANCE_LIMIT", filter: "maxDistanceKm", message: `About ${offer.distanceKm.toFixed(1)} km away, beyond your limit of ${filters.maxDistanceKm} km.`, limit: filters.maxDistanceKm, actual: offer.distanceKm });
    }
  }
  return out;
}

/** True when the only thing wrong is a distance that could not be established (the existing `unverifiedFiltered` count). */
export const onlyDistanceUnknown = (rejections: Rejection[]) => rejections.length === 1 && rejections[0]!.code === "MISSING_REQUIRED_DATA" && rejections[0]!.field === "distance";
