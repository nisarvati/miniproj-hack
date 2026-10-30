"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, searchMedicines, type SearchFilters } from "../../lib/api";
import { formatPrice, pluralise } from "../../lib/format";
import { useLiveStream } from "../../lib/live";
import { unavailableMedicines } from "../../lib/restock";
import { activeFilterCount, parseSearchParams, toSearchParams, type SearchState, type View } from "../../lib/search-state";
import { useAsync } from "../../lib/use-async";
import { useLocation } from "../providers/location";
import { LocationNotice } from "./LocationNotice";
import { AlertIcon, SearchIcon } from "../ui/icons";
import { Alert, Button, EmptyState, LiveDot, Skeleton } from "../ui/primitives";
import { FilterBar } from "./FilterBar";
import { Hero } from "./Hero";
import { RejectedSection } from "./RejectedSection";
import { ResultCard } from "./ResultCard";
import { SearchForm } from "./SearchForm";
import { UnavailableMedicine } from "./UnavailableMedicine";
import { UnlistedMedicines } from "./UnlistedMedicines";

// Leaflet touches `window`, so the map is only ever loaded in the browser, and only when asked for.
const ResultsMap = dynamic(() => import("./ResultsMap"), { ssr: false, loading: () => <Skeleton className="h-[24rem] sm:h-[30rem]" /> });

export function SearchPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { picked, ready, explicit } = useLocation();
  const state = useMemo(() => parseSearchParams(new URLSearchParams(params.toString())), [params]);
  const { location } = picked;

  const go = useCallback(
    (next: SearchState, mode: "push" | "replace") => {
      const qs = toSearchParams(next).toString();
      router[mode](qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const setFilters = (filters: SearchFilters) => go({ ...state, filters }, "push");
  const setView = (view: View) => go({ ...state, view }, "push");
  const newSearch = (q: string) => go({ ...state, q }, "push");

  const hasQuery = state.q.length > 0;
  const filtersKey = JSON.stringify(state.filters);
  const search = useAsync(
    (signal) => searchMedicines(state.q, location, { signal, filters: state.filters }),
    [state.q, filtersKey, location.latitude, location.longitude],
    ready && hasQuery,
  );

  // Whether a medicine is unavailable must not depend on the filters: "in stock only" would otherwise hide the very
  // medicines we want to offer a restock notification for. With filters on, ask once more without them.
  const narrowed = !!state.filters.inStock || state.filters.maxDistanceKm !== undefined || state.filters.maxPrice !== undefined;
  const everything = useAsync(
    (signal) => searchMedicines(state.q, location, { signal }),
    [state.q, location.latitude, location.longitude],
    ready && hasQuery && narrowed,
  );
  const [stockAnnouncement, setStockAnnouncement] = useState("");
  const previousStock = useRef("");
  useEffect(() => {
    if (!hasQuery || !ready) return;
    let inFlight = false;
    const refresh = () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      search.reload();
      if (narrowed) everything.reload();
      window.setTimeout(() => { inFlight = false; }, 1000);
    };
    const timer = window.setInterval(refresh, 20000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [hasQuery, ready, narrowed, search.reload, everything.reload]);
  const availability = (narrowed ? everything.data : search.data)?.results ?? [];
  const unavailable = useMemo(() => unavailableMedicines(availability), [availability]);

  // Live updates (GET /api/stream): when a stock change arrives for a medicine in these results, read the same query again, once, a moment
  // later (several changes in a row are one reload). Unrelated changes are ignored. The 20 s refresh above stays as the fallback.
  const shownMedicines = useRef(new Set<string>());
  shownMedicines.current = new Set(availability.map((r) => r.medicine.code));
  const reloadResults = useRef(() => {});
  reloadResults.current = () => {
    search.reload();
    if (narrowed) everything.reload();
  };
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      reloadResults.current();
    }, 800);
  }, []);
  useEffect(() => () => { if (liveTimer.current) clearTimeout(liveTimer.current); }, []);
  useLiveStream({ onStock: (e) => { if (shownMedicines.current.has(e.medicineCode)) scheduleReload(); }, onResync: scheduleReload }, hasQuery && ready);
  const results = search.data?.results ?? [];
  const matchingMedicines = useMemo(
    () => Array.from(new Map(results.map((result) => [result.medicine.id, result.medicine])).values()),
    [results],
  );
  // Catalogue matches no pharmacy lists. null: an older API that does not say, so keep the generic empty state.
  const matches = search.data?.matches ?? null;
  const unlisted = useMemo(() => (matches ?? []).filter((m) => !m.listed).map((m) => m.medicine), [matches]);
  const allUnlisted = matches !== null && matches.length > 0 && unlisted.length === matches.length;
  const notInCatalogue = matches !== null && matches.length === 0;
  const contextMedicine = matchingMedicines.length === 1 ? matchingMedicines[0] : null;
  const pharmacyCount = useMemo(() => new Set(results.map((result) => result.pharmacy.id)).size, [results]);
  const priceRange = useMemo(() => {
    if (!results.length) return null;
    const prices = results.map((result) => result.price);
    return { min: Math.min(...prices), max: Math.max(...prices) };
  }, [results]);
  const loading = search.status === "loading" || search.status === "idle";
  const first = loading && !search.data;
  const filters = activeFilterCount(state.filters);
  // "Live" must mean something was actually synced, not just that Redis answered.
  const anyLive = results.some((r) => r.source === "live");
  useEffect(() => {
    const next = results.map((r) => `${r.medicine.id}:${r.pharmacy.id}:${r.stockStatus}`).join("|");
    if (previousStock.current && previousStock.current !== next) setStockAnnouncement("Live stock has changed. Search results have been updated.");
    previousStock.current = next;
  }, [results]);

  if (!hasQuery) return <Hero onSearch={newSearch} />;

  return (
    <div className="search-results-view space-y-4">
      <div>
        <h1 className="editorial-title mb-3 text-2xl leading-tight">Find your medicine</h1>
        <SearchForm initial={state.q} onSearch={newSearch} />
      </div>
      <FilterBar filters={state.filters} view={state.view} onFilters={setFilters} onView={setView} />

      <section aria-busy={loading} className="space-y-4">
        <p className="sr-only" role="status" aria-live="polite">{stockAnnouncement}</p>
        {search.status === "error" && (
          <Alert tone="bad" title="We couldn't load the results" action={<Button size="sm" variant="secondary" onClick={search.reload}>Try again</Button>}>
            {search.error instanceof ApiError ? search.error.message : "Something went wrong. Please try again."}
          </Alert>
        )}

        {search.data && results.length > 0 && !anyLive && (
          <Alert tone="warn" title="Showing last known stock">
            {search.data.live
              ? "No live updates have reached MedLink for these pharmacies yet, so these figures may be out of date. Call ahead to confirm."
              : "Live stock is unavailable right now, so these figures may be out of date. Call ahead to confirm."}
          </Alert>
        )}

        {first && (
          <>
          <p role="status" className="sr-only">Loading results for {state.q}</p>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Loading results">
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Skeleton className="h-64" />
              </li>
            ))}
          </ul>
          </>
        )}

        {search.data && (
          <>
            {results.length > 0 && (
              <div className="medicine-context flex flex-wrap items-start justify-between gap-x-8 gap-y-2 border-y border-line py-3">
                <div className="min-w-0">
                  <h2 className="editorial-title truncate text-xl text-ink">
                    {contextMedicine ? `${contextMedicine.brandName} ${contextMedicine.dosage}` : state.q}
                  </h2>
                  <p className="text-sm text-muted">
                    {contextMedicine
                      ? `${contextMedicine.genericName} · ${contextMedicine.form}`
                      : `${matchingMedicines.length} matching medicine options`}
                  </p>
                </div>
                <p className="text-sm">
                  <span className="text-muted">Typical price range</span>{" "}
                  <span className="font-semibold tabular-nums text-ink">
                    {priceRange
                      ? priceRange.min === priceRange.max
                        ? formatPrice(priceRange.min)
                        : `${formatPrice(priceRange.min)} – ${formatPrice(priceRange.max)}`
                      : "Price varies"}
                  </span>
                </p>
                {matchingMedicines.length > 1 && (
                  <details className="mx-details">
                    <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-brand hover:underline">
                      More medicine details
                    </summary>
                    <ul className="mt-2 space-y-2 text-sm">
                      {matchingMedicines.map((medicine) => (
                        <li key={medicine.id}>
                          <span className="font-medium">{medicine.brandName} {medicine.dosage}</span>
                          <span className="block text-muted">{medicine.genericName} · {medicine.form}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}

            {results.length > 0 && <LocationNotice />}

            {results.length > 0 && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted" aria-live="polite" aria-atomic="true">
              <span className="font-medium text-ink">
                {contextMedicine
                  ? `${pharmacyCount} ${pharmacyCount === 1 ? "pharmacy" : "pharmacies"} near ${picked.label.replace(/, Mumbai$/, "")} ${pharmacyCount === 1 ? "has" : "have"} ${contextMedicine.brandName} ${contextMedicine.dosage}`
                  : `${pluralise(results.length, "offer")} across ${pluralise(pharmacyCount, "pharmacy")} near ${picked.label.replace(/, Mumbai$/, "")} for ${state.q}`}
              </span>
              {anyLive && (
                <span className="inline-flex items-center gap-1.5 font-medium text-ok">
                  <LiveDot /> Live stock
                </span>
              )}
              {search.status === "loading" && <span className="text-xs">Updating…</span>}
            </p>
            )}

            {unavailable.map(({ medicine, pharmacyCount }) => (
              <UnavailableMedicine key={medicine.id} medicine={medicine} pharmacyCount={pharmacyCount} location={location} />
            ))}

            {results.length > 0 && <UnlistedMedicines medicines={unlisted} alsoFound />}

            {results.length === 0 && allUnlisted && <UnlistedMedicines medicines={unlisted} />}

            {results.length === 0 && !allUnlisted && (
              <EmptyState
                icon={filters > 0 && !notInCatalogue ? <AlertIcon /> : <SearchIcon />}
                title={notInCatalogue ? `“${state.q}” isn't in the MedLink catalogue` : filters > 0 ? "No pharmacies match your filters" : `No medicines found for “${state.q}”`}
                action={filters > 0 && !notInCatalogue ? <Button onClick={() => setFilters({ sort: state.filters.sort })}>Clear filters</Button> : undefined}
              >
                {filters > 0 && !notInCatalogue ? "Try a wider distance or price, or turn off “In stock only”." : "Check the spelling, or try the generic name (e.g. Paracetamol)."}
              </EmptyState>
            )}

            {results.length > 0 && search.data?.sortNote && (
              <Alert tone="warn" title="Not ordered by distance">{search.data.sortNote}</Alert>
            )}

            {results.length > 0 && state.view === "list" && (
              <ol className="results-list grid gap-3">
                {results.map((r, i) => (
                  <Fragment key={`${r.medicine.id}-${r.pharmacy.id}`}>
                    {/* Nearest first: verified distances come first, and the rest are set apart so they are not read as "near". */}
                    {state.filters.sort === "distance" && !search.data?.sortNote && r.distanceKm === null && i > 0 && results[i - 1]!.distanceKm !== null && (
                      <li role="presentation" className="pt-2 text-sm font-semibold text-muted">Location not verified: no distance shown, ordered by availability, price and relevance</li>
                    )}
                    <ResultCard result={r} origin={explicit ? location : null} best={(state.filters.sort ?? "best") === "best" && r.rank === 1 && r.stockStatus !== "OUT_OF_STOCK"} />
                  </Fragment>
                ))}
              </ol>
            )}

            {results.length > 0 && state.view === "map" && (
              <>
                {results.some((r) => r.pharmacy.locationVerified === false) && (
                  <p className="text-xs text-muted">Pharmacies whose map location is not verified are not pinned on the map. Use their list entry for directions by address.</p>
                )}
              <ResultsMap results={results} origin={location} directionsOrigin={explicit ? location : null} originLabel={picked.label} onOpenPharmacy={(id) => router.push(`/pharmacies/${id}`)} />
              </>
            )}

            {/* Only filters the person chose can leave anything out, and only what the API evaluated is listed. Set apart from the results. */}
            {filters > 0 && !notInCatalogue && <RejectedSection rejected={search.data.rejected} summary={search.data.rejectionSummary} />}
          </>
        )}
      </section>

      <p className="border-t border-line pt-3 text-xs leading-relaxed text-muted">
        <strong className="text-ink">Live</strong> figures are synced from each pharmacy&apos;s own system and update within seconds. <strong className="text-ink">Last known</strong> figures come from MedLink&apos;s database and can be older. Call ahead to confirm.
      </p>
    </div>
  );
}
