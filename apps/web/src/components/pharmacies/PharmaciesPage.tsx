"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ApiError, listPharmacies } from "../../lib/api";
import { formatDistance } from "../../lib/format";
import { haversineKm } from "../../lib/geo";
import { useAsync } from "../../lib/use-async";
import { useLocation } from "../providers/location";
import { ChevronRightIcon, StoreIcon } from "../ui/icons";
import { Alert, Button, Card, EmptyState, LinkButton, Skeleton } from "../ui/primitives";
import { DemoBadge, SimulatedInventoryNotice } from "../ui/DemoBadge";
import { DirectionsActions } from "./DirectionsActions";
import { DirectoryListings } from "./DirectoryListings";

export function PharmaciesPage() {
  const { picked, explicit } = useLocation();
  const state = useAsync((signal) => listPharmacies({ signal }), []);
  const sorted = useMemo(
    () =>
      (state.data ?? [])
        // A distance is claimed only for a verified map point; the others follow, by name.
        .map((p) => ({ p, km: p.locationVerified === false ? null : haversineKm(picked.location, p) }))
        .sort((a, b) => (a.km === null ? 1 : 0) - (b.km === null ? 1 : 0) || (a.km ?? 0) - (b.km ?? 0) || a.p.name.localeCompare(b.p.name)),
    [state.data, picked.location],
  );

  return (
    <div className="pharmacies-view space-y-6">
      <header className="max-w-3xl border-b border-line pb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">Your local network</p>
        <h1 className="editorial-title mt-2 text-4xl leading-tight sm:text-5xl">Pharmacies close to home</h1>
        <p className="mt-2 max-w-2xl text-muted">Browse nearby independent pharmacies, ranked from {picked.label.replace(/, Mumbai$/, "")}. Open one to check its latest stock.</p>
      </header>

      {state.status === "error" && (
        <Alert tone="bad" title="We couldn't load the pharmacies" action={<Button size="sm" onClick={state.reload}>Try again</Button>}>
          {state.error instanceof ApiError ? state.error.message : "Something went wrong."}
        </Alert>
      )}
      {!state.data && state.status !== "error" && (
        <div className="grid gap-4 sm:grid-cols-2" aria-label="Loading pharmacies">
          <p role="status" className="sr-only">Loading pharmacies</p>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      )}
      {state.data && sorted.length === 0 && <EmptyState icon={<StoreIcon />} title="No pharmacies yet">Pharmacies appear here once they join MedLink.</EmptyState>}

        <ul className="grid gap-3">
        {sorted.map(({ p, km }) => (
          <li key={p.id}>
            <Card interactive className="flex h-full flex-col p-5">
              <div className="flex items-start gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
                  <StoreIcon size={22} />
                </span>
                <div className="min-w-0">
                  <h2 className="editorial-title text-xl leading-snug">
                    <Link href={`/pharmacies/${p.id}`} className="rounded underline-offset-2 hover:underline">
                      {p.name}
                    </Link>
                  </h2>
                  <p className="text-sm text-muted">{p.address}</p>
                  {p.demo && (
                    <div className="mt-1 space-y-1">
                      <p><DemoBadge demo independent={p.independent} /></p>
                      <SimulatedInventoryNotice pharmacy={p} />
                    </div>
                  )}
                  <p className="mt-2 inline-flex items-center rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand-ink">{km === null ? "Location not verified: distance not shown" : formatDistance(km)}</p>
                </div>
              </div>
              <div className="mt-auto flex items-center gap-2 pt-4">
                <LinkButton href={`/pharmacies/${p.id}`} variant="primary" size="sm">
                  See stock <ChevronRightIcon size={14} />
                </LinkButton>
                <DirectionsActions pharmacy={p} origin={explicit ? picked.location : null} />
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <DirectoryListings origin={explicit ? picked.location : null} />
    </div>
  );
}
