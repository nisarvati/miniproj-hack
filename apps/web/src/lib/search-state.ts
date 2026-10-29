import type { SearchFilters, SortKey } from "./api";

export type View = "list" | "map";

export interface SearchState {
  q: string;
  filters: SearchFilters;
  view: View;
}

export const DISTANCE_OPTIONS = [1, 2, 5, 10] as const;
export const PRICE_OPTIONS = [25, 50, 100, 250] as const;
export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "best", label: "Best match" },
  { value: "distance", label: "Nearest" },
  { value: "price", label: "Lowest price" },
  { value: "stock", label: "Most in stock" },
];

const SORTS = new Set<string>(SORT_OPTIONS.map((s) => s.value));
const positive = (v: string | null, max: number): number | undefined => {
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
};

/** The page's URL is its state, so a search can be shared, bookmarked and survives a reload. Bad values are ignored. */
export function parseSearchParams(params: URLSearchParams): SearchState {
  const sort = params.get("sort");
  return {
    q: (params.get("q") ?? "").trim().slice(0, 100),
    filters: {
      inStock: params.get("stock") === "1" ? true : undefined,
      maxDistanceKm: positive(params.get("dist"), 500),
      maxPrice: positive(params.get("price"), 1_000_000),
      sort: sort && SORTS.has(sort) ? (sort as SortKey) : undefined,
    },
    view: params.get("view") === "map" ? "map" : "list",
  };
}

/** Only what differs from the defaults goes in the URL. */
export function toSearchParams(state: SearchState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.filters.inStock) p.set("stock", "1");
  if (state.filters.maxDistanceKm !== undefined) p.set("dist", String(state.filters.maxDistanceKm));
  if (state.filters.maxPrice !== undefined) p.set("price", String(state.filters.maxPrice));
  if (state.filters.sort && state.filters.sort !== "best") p.set("sort", state.filters.sort);
  if (state.view === "map") p.set("view", "map");
  return p;
}

export function activeFilterCount(f: SearchFilters): number {
  return Number(!!f.inStock) + Number(f.maxDistanceKm !== undefined) + Number(f.maxPrice !== undefined);
}
