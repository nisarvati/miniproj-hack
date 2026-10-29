import { toSearchParams } from "../../../lib/search-state";

export const EMPTY_QUERY_MESSAGE = "Enter a medicine name, e.g. Crocin 500mg or Paracetamol.";

/** Where a landing-page search goes: the existing search page, at /search, whose URL is its state (`/search?q=...`). */
export function buildSearchHref(query: string): string {
  const qs = toSearchParams({ q: query.trim().slice(0, 100), filters: {}, view: "list" }).toString();
  return qs ? `/search?${qs}` : "/search";
}

/** Null when the query can be searched, otherwise what to tell the person. */
export function validateQuery(query: string): string | null {
  return query.trim() ? null : EMPTY_QUERY_MESSAGE;
}
