"use client";

import type { SearchFilters, SortKey } from "../../lib/api";
import { formatPrice } from "../../lib/format";
import { activeFilterCount, DISTANCE_OPTIONS, PRICE_OPTIONS, SORT_OPTIONS, type View } from "../../lib/search-state";
import { CheckIcon, ListIcon, MapIcon } from "../ui/icons";
import { Button, Chip, Segmented, Select } from "../ui/primitives";

export function FilterBar({
  filters,
  view,
  onFilters,
  onView,
}: {
  filters: SearchFilters;
  view: View;
  onFilters: (f: SearchFilters) => void;
  onView: (v: View) => void;
}) {
  const active = activeFilterCount(filters);
  return (
    <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center" role="group" aria-label="Filters and sorting">
      {/* On phones the filters scroll sideways in one row instead of wrapping into several. */}
      <div className="-mx-4 flex items-center gap-2.5 overflow-x-auto px-4 pb-1 [&>*]:shrink-0 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
      <Chip pressed={!!filters.inStock} onClick={() => onFilters({ ...filters, inStock: filters.inStock ? undefined : true })}>
        {filters.inStock && <CheckIcon size={14} />}
        In stock only
      </Chip>

      <label className="inline-flex items-center gap-2 text-sm text-muted">
        <span className="hidden whitespace-nowrap sm:inline">Within</span>
        <Select
          aria-label="Maximum distance"
          value={filters.maxDistanceKm ?? ""}
          onChange={(e) => onFilters({ ...filters, maxDistanceKm: e.target.value ? Number(e.target.value) : undefined })}
          className={`min-h-11 w-auto rounded-full md:h-9 md:min-h-0 ${filters.maxDistanceKm ? "border-brand bg-brand-soft text-brand-ink" : ""}`}
        >
          <option value="">Any distance</option>
          {DISTANCE_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d} km
            </option>
          ))}
        </Select>
      </label>

      <label className="inline-flex items-center gap-2 text-sm text-muted">
        <span className="hidden whitespace-nowrap sm:inline">Up to</span>
        <Select
          aria-label="Maximum price"
          value={filters.maxPrice ?? ""}
          onChange={(e) => onFilters({ ...filters, maxPrice: e.target.value ? Number(e.target.value) : undefined })}
          className={`min-h-11 w-auto rounded-full md:h-9 md:min-h-0 ${filters.maxPrice ? "border-brand bg-brand-soft text-brand-ink" : ""}`}
        >
          <option value="">Any price</option>
          {PRICE_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {formatPrice(p)}
            </option>
          ))}
        </Select>
      </label>

      {active > 0 && (
        <Button size="sm" variant="ghost" onClick={() => onFilters({ sort: filters.sort })}>
          Clear filters ({active})
        </Button>
      )}
      </div>

      <div className="flex items-center justify-between gap-2.5 sm:ml-auto sm:justify-end">
        <label className="inline-flex items-center gap-2 text-sm text-muted">
          <span className="hidden whitespace-nowrap sm:inline">Sort</span>
          <Select aria-label="Sort by" value={filters.sort ?? "best"} onChange={(e) => onFilters({ ...filters, sort: e.target.value as SortKey })} className="min-h-11 w-auto rounded-full md:h-9 md:min-h-0">
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
        <Segmented
          label="View"
          value={view}
          onChange={onView}
          options={[
            { value: "list", label: "List", icon: <ListIcon size={16} /> },
            { value: "map", label: "Map", icon: <MapIcon size={16} /> },
          ]}
        />
      </div>
    </div>
  );
}
