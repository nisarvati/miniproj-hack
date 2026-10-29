"use client";

import { useState } from "react";
import { ApiError, searchMedicines, type StockStatus } from "../../../lib/api";
import { formatAge, formatDistance, formatPrice } from "../../../lib/format";
import { useAsync } from "../../../lib/use-async";
import { useNow } from "../../../lib/use-now";
import { useLocation } from "../../providers/location";
import { SAMPLE_QUERY } from "./content";

type Mode = "live" | "illustrative";

interface Row {
  key: string;
  medicine: string;
  detail: string;
  pharmacy: string;
  code: string;
  distance: string;
  status: StockStatus;
  quantity?: number;
  price: string;
  freshness: { kind: "live" | "last-known"; updatedAt: string } | { kind: "example"; text: string };
}

const STOCK: Record<StockStatus, { glyph: string; label: string }> = {
  IN_STOCK: { glyph: "●", label: "In stock" },
  LOW_STOCK: { glyph: "◐", label: "Low stock" },
  OUT_OF_STOCK: { glyph: "○", label: "Out of stock" },
};

/** Invented rows, shown only when a reviewer picks "Illustrative preview". Every one says so. */
const ILLUSTRATIVE: Row[] = [
  { key: "i1", medicine: "Example medicine", detail: "strength · form", pharmacy: "Example Pharmacy A", code: "P00x", distance: "0.4 km away", status: "IN_STOCK", quantity: 24, price: "₹00", freshness: { kind: "example", text: "Example: updated 2 min ago" } },
  { key: "i2", medicine: "Example medicine", detail: "strength · form", pharmacy: "Example Pharmacy B", code: "P00x", distance: "1.8 km away", status: "LOW_STOCK", quantity: 3, price: "₹00", freshness: { kind: "example", text: "Example: updated 11 min ago" } },
  { key: "i3", medicine: "Example medicine", detail: "strength · form", pharmacy: "Example Pharmacy C", code: "P00x", distance: "3.2 km away", status: "OUT_OF_STOCK", price: "₹00", freshness: { kind: "example", text: "Example: updated 1 hr ago" } },
];

/**
 * Availability across pharmacies, from the real search API. Loading, empty and error states are honest: nothing is
 * ever substituted silently. A reviewer without the API can pick "Illustrative preview" themselves, and everything
 * shown in that mode is labelled as invented. Directions style it through the `data-av` hooks.
 */
export function AvailabilitySample({ query = SAMPLE_QUERY, limit = 5 }: { query?: string; limit?: number }) {
  const { picked, ready } = useLocation();
  const [mode, setMode] = useState<Mode>("live");
  const search = useAsync((signal) => searchMedicines(query, picked.location, { signal }), [query, picked.location.latitude, picked.location.longitude], ready && mode === "live");
  const now = useNow();
  const place = picked.label.replace(/, Mumbai$/, "");

  const liveRows: Row[] = (search.data?.results ?? []).slice(0, limit).map((r) => ({
    key: `${r.pharmacy.id}-${r.medicine.id}`,
    medicine: `${r.medicine.brandName} ${r.medicine.dosage}`.trim(),
    detail: `${r.medicine.form} · ${r.medicine.genericName}`,
    pharmacy: r.pharmacy.name,
    code: r.pharmacy.code,
    distance: r.distanceKm === null ? "Distance not shown" : formatDistance(r.distanceKm),
    status: r.stockStatus,
    quantity: r.quantity,
    price: formatPrice(r.price),
    freshness: { kind: r.source === "live" ? "live" : "last-known", updatedAt: r.updatedAt },
  }));

  const loading = mode === "live" && (!ready || search.status === "idle" || (search.status === "loading" && !search.data));
  const failed = mode === "live" && search.status === "error";
  const empty = mode === "live" && search.status === "success" && liveRows.length === 0;
  const rows = mode === "illustrative" ? ILLUSTRATIVE : liveRows;
  const showTable = rows.length > 0 && !failed && !loading;

  return (
    <div data-av="root" data-mode={mode}>
      <div data-av="toolbar" role="group" aria-label="Data source">
        <button type="button" data-av="mode" aria-pressed={mode === "live"} onClick={() => setMode("live")}>
          Live data
        </button>
        <button type="button" data-av="mode" aria-pressed={mode === "illustrative"} onClick={() => setMode("illustrative")}>
          Illustrative preview
        </button>
      </div>

      {mode === "illustrative" && (
        <p data-av="banner" role="note">
          <strong>Illustrative preview.</strong> These rows are invented to show the layout. They are not live data and say nothing about any real pharmacy.
        </p>
      )}

      {loading && (
        <div data-av="loading" role="status">
          <span>Loading live availability for {query}…</span>
          <span data-av="skeleton" aria-hidden="true" />
          <span data-av="skeleton" aria-hidden="true" />
          <span data-av="skeleton" aria-hidden="true" />
        </div>
      )}

      {failed && (
        <div data-av="error" role="alert">
          <p>
            <strong>Live availability could not be loaded.</strong> {search.error instanceof ApiError ? search.error.message : "Something went wrong."}
          </p>
          <div data-av="actions">
            <button type="button" data-av="action" onClick={search.reload}>
              Try again
            </button>
            <button type="button" data-av="action" onClick={() => setMode("illustrative")}>
              Show illustrative preview
            </button>
          </div>
        </div>
      )}

      {empty && (
        <p data-av="empty" role="status">
          No participating pharmacy returned a match for {query} near {place}. That can mean none of them list it.
        </p>
      )}

      {mode === "live" && search.status === "success" && search.data && !search.data.live && liveRows.length > 0 && (
        <p data-av="notice" role="status">
          Live stock is unavailable right now, so these are last known values and may be out of date.
        </p>
      )}

      {showTable && (
        <table data-av="table">
          <caption className="sr-only">
            {mode === "live" ? `${query} availability at pharmacies near ${place}` : "Illustrative availability layout, not live data"}
          </caption>
          <thead>
            <tr>
              <th scope="col">Medicine</th>
              <th scope="col">Pharmacy</th>
              <th scope="col">Distance</th>
              <th scope="col">Stock</th>
              <th scope="col">Price</th>
              <th scope="col">Freshness</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} data-status={row.status}>
                <td data-label="Medicine">
                  <span data-av="medicine">{row.medicine}</span>
                  <span data-av="detail">{row.detail}</span>
                </td>
                <td data-label="Pharmacy">
                  <span>{row.pharmacy}</span>
                  <span data-av="code">{row.code}</span>
                </td>
                <td data-label="Distance">{row.distance}</td>
                <td data-label="Stock" data-av="stock">
                  <span aria-hidden="true">{STOCK[row.status].glyph}</span> {STOCK[row.status].label}
                  {row.quantity !== undefined && row.status !== "OUT_OF_STOCK" ? ` · ${row.quantity}` : ""}
                </td>
                <td data-label="Price">{row.price}</td>
                <td data-label="Freshness">{freshnessText(row.freshness, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p data-av="footnote">
        {mode === "live"
          ? `Example search: ${query}, near ${place}. Results come from MedLink's search and can change; call the pharmacy before you travel.`
          : "Illustrative preview. Switch to live data to see real results."}
      </p>
    </div>
  );
}

function freshnessText(f: Row["freshness"], now: Date): string {
  if (f.kind === "example") return f.text;
  const age = formatAge(f.updatedAt, now);
  return f.kind === "live" ? `Live · updated ${age}` : `Last known · updated ${age}`;
}
