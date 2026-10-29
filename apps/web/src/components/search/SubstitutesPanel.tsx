"use client";

import Link from "next/link";
import { getSubstitutes, type Location, type MedicineRef } from "../../lib/api";
import { formatDistance, formatPrice, pluralise } from "../../lib/format";
import { useAsync } from "../../lib/use-async";
import { StockBadge } from "../stock/StockBadge";
import { InfoIcon, SwapIcon } from "../ui/icons";
import { Badge, Skeleton } from "../ui/primitives";

/**
 * Same active ingredient, available nearby. Always a suggestion for a pharmacist or doctor to confirm, never a
 * recommendation: strength and form can differ, so each card says exactly how.
 */
export function SubstitutesPanel({ medicine, location }: { medicine: MedicineRef; location: Location }) {
  const state = useAsync((signal) => getSubstitutes(medicine.id, location, { signal }), [medicine.id, location.latitude, location.longitude]);

  if (state.status === "error") return null; // an extra, never worth an error banner
  if (state.status !== "success" && !state.data) {
    return (
      <div aria-hidden="true" className="space-y-2">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  const { substitutes, notice } = state.data!;
  if (substitutes.length === 0) return null;

  return (
    <section id={`alternatives-${medicine.id}`} aria-label={`Alternatives to ${medicine.brandName} ${medicine.dosage}`}>
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <SwapIcon size={16} className="text-brand" />
        Available nearby with the same ingredient ({medicine.genericName})
      </h3>
      <ul className="mt-2 grid gap-2.5 sm:grid-cols-2">
        {substitutes.map((s) => (
          <li key={s.medicine.id} className="mx-card mx-card--interactive p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold">
                  {s.medicine.brandName} {s.medicine.dosage}
                </p>
                <p className="text-xs text-muted">{s.medicine.form}</p>
              </div>
              <p className="shrink-0 font-bold tabular-nums">{formatPrice(s.best.price)}</p>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone={s.sameStrength ? "ok" : "warn"}>{s.sameStrength ? "Same strength" : `Different strength (${s.medicine.dosage})`}</Badge>
              <Badge tone={s.sameForm ? "ok" : "warn"}>{s.sameForm ? "Same form" : `Different form (${s.medicine.form})`}</Badge>
            </div>
            <p className="mt-2 text-sm">
              <Link href={`/pharmacies/${s.best.pharmacy.id}`} className="font-medium underline-offset-2 hover:underline">
                {s.best.pharmacy.name}
              </Link>
              <span className="text-muted"> · {s.best.distanceKm === null ? "Distance not shown" : formatDistance(s.best.distanceKm)}</span>
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StockBadge status={s.best.stockStatus} />
              {s.pharmaciesInStock > 1 && <span className="text-xs text-muted">at {pluralise(s.pharmaciesInStock, "pharmacy", "pharmacies")}</span>}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 flex items-start gap-1.5 text-xs text-muted">
        <InfoIcon size={14} className="mt-0.5 shrink-0" />
        {notice}
      </p>
    </section>
  );
}
