"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getPharmacy, getPharmacyStock, type PharmacyStockItem, type StockStatus } from "../../lib/api";
import { formatDistance, formatPrice, pluralise } from "../../lib/format";
import { useAsync } from "../../lib/use-async";
import { useDebounced } from "../../lib/use-debounced";
import { NotifyMe } from "../search/NotifyMe";
import { useLocation } from "../providers/location";
import { Freshness } from "../stock/Freshness";
import { StockBadge } from "../stock/StockBadge";
import { ArrowLeftIcon, BellIcon, MapPinIcon, SearchIcon } from "../ui/icons";
import { DemoBadge, DEMO_NOTE, SimulatedInventoryNotice } from "../ui/DemoBadge";
import { DirectionsActions } from "./DirectionsActions";
import { Alert, Button, Card, Chip, EmptyState, Input, LinkButton, LiveDot, Skeleton } from "../ui/primitives";

type Tab = "all" | StockStatus;

export function PharmacyPage({ id }: { id: number }) {
  const { picked, ready, explicit } = useLocation();
  const [text, setText] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [notifying, setNotifying] = useState<number | null>(null);
  const q = useDebounced(text.trim(), 250);

  const pharmacy = useAsync((signal) => getPharmacy(id, picked.location, { signal }), [id, picked.location.latitude, picked.location.longitude], ready);
  const stock = useAsync((signal) => getPharmacyStock(id, { q }, { signal }), [id, q]);
  const previousStock = useRef("");
  const [stockAnnouncement, setStockAnnouncement] = useState("");
  useEffect(() => {
    let inFlight = false;
    const refresh = () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      stock.reload();
      window.setTimeout(() => { inFlight = false; }, 1000);
    };
    const timer = window.setInterval(refresh, 20000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [stock.reload]);

  const items = useMemo(() => (stock.data?.items ?? []).filter((i) => tab === "all" || i.stockStatus === tab), [stock.data, tab]);
  const anyLive = (stock.data?.items ?? []).some((i) => i.source === "live");
  useEffect(() => {
    const next = (stock.data?.items ?? []).map((i) => `${i.medicine.id}:${i.stockStatus}`).join("|");
    if (previousStock.current && previousStock.current !== next) setStockAnnouncement("Live stock has changed. Pharmacy stock has been updated.");
    previousStock.current = next;
  }, [stock.data]);

  if (pharmacy.status === "error" && pharmacy.error instanceof ApiError && pharmacy.error.kind === "notFound") {
    return (
      <EmptyState level={1} title="We couldn't find that pharmacy" action={<LinkButton href="/pharmacies" variant="primary">All pharmacies</LinkButton>}>
        It may no longer be listed.
      </EmptyState>
    );
  }

  return (
    <div className="pharmacy-view space-y-6">
      <Link href="/pharmacies" className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-muted hover:text-ink">
        <ArrowLeftIcon size={16} /> All pharmacies
      </Link>

      <Card variant="solid" className="pharmacy-overview overflow-hidden p-5 sm:p-7">
        {pharmacy.data ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">{pharmacy.data.demo ? "Demo directory listing" : "Independent pharmacy"}</p>
              <h1 className="editorial-title mt-1 text-3xl leading-tight sm:text-4xl">{pharmacy.data.name}</h1>
              <p className="mt-1 flex items-center gap-1.5 text-muted">
                <MapPinIcon size={16} className="shrink-0 text-brand" />
                {pharmacy.data.address}
              </p>
              {pharmacy.data.demo && (
                <div className="mt-2 space-y-1 text-sm text-muted">
                  <p>
                    <DemoBadge demo independent={pharmacy.data.independent} /> <span>{DEMO_NOTE}</span>
                  </p>
                  <SimulatedInventoryNotice pharmacy={pharmacy.data} className="font-medium text-ink" />
                </div>
              )}
              {pharmacy.data.locationVerified === false && <p className="mt-1 text-sm text-muted">Map location not verified: directions use the address, and no distance is shown.</p>}
              {pharmacy.data.distanceKm !== null && <p className="mt-1 text-sm font-medium">{formatDistance(pharmacy.data.distanceKm)} from {picked.label.replace(/, Mumbai$/, "")}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <DirectionsActions pharmacy={pharmacy.data} origin={explicit ? picked.location : null} variant="primary" size="md" showView />
            </div>
          </div>
        ) : (
          <>
            <h1 className="sr-only">Loading pharmacy details</h1>
            <div aria-hidden="true" className="space-y-2">
              <Skeleton className="h-8 w-72 max-w-full" />
              <Skeleton className="h-5 w-96 max-w-full" />
            </div>
          </>
        )}
      </Card>

      <section aria-label="Stock" className="space-y-4">
        <p className="sr-only" role="status" aria-live="polite">{stockAnnouncement}</p>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-64">
            <SearchIcon size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
            <label htmlFor="stock-search" className="sr-only">
              Search this pharmacy&apos;s stock
            </label>
            <Input id="stock-search" type="search" placeholder="Search this pharmacy's stock" value={text} onChange={(e) => setText(e.target.value)} className="pl-10" />
          </div>
          <div role="group" aria-label="Filter by availability" className="flex flex-wrap gap-2">
            <Chip pressed={tab === "all"} onClick={() => setTab("all")}>All{stock.data ? ` (${stock.data.total})` : ""}</Chip>
            <Chip pressed={tab === "IN_STOCK"} onClick={() => setTab("IN_STOCK")}>In stock</Chip>
            <Chip pressed={tab === "LOW_STOCK"} onClick={() => setTab("LOW_STOCK")}>Low</Chip>
            <Chip pressed={tab === "OUT_OF_STOCK"} onClick={() => setTab("OUT_OF_STOCK")}>Out of stock</Chip>
          </div>
        </div>

        {stock.status === "error" && (
          <Alert tone="bad" title="We couldn't load the stock" action={<Button size="sm" onClick={stock.reload}>Try again</Button>}>
            {stock.error instanceof ApiError ? stock.error.message : "Something went wrong."}
          </Alert>
        )}
        {stock.data && stock.data.items.length > 0 && !anyLive && (
          <Alert tone="warn" title="Showing last known stock">
            {stock.data.live ? "No live updates have reached MedLink for this pharmacy yet, so these figures may be out of date." : "Live stock is unavailable right now, so these figures may be out of date."}
          </Alert>
        )}
        {anyLive && (
          <p className="flex items-center gap-1.5 text-sm font-medium text-ok">
            <LiveDot /> Live stock, synced from the pharmacy
          </p>
        )}

        {!stock.data && stock.status !== "error" && (
          <div className="space-y-2" aria-label="Loading stock">
            <p role="status" className="sr-only">Loading pharmacy stock</p>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        )}

        {stock.data && items.length === 0 && (
          <EmptyState icon={<SearchIcon />} title={q || tab !== "all" ? "Nothing matches" : "This pharmacy has no stock listed"}>
            {q || tab !== "all" ? "Try a different name, or show all availability." : "Check back later."}
          </EmptyState>
        )}

        {items.length > 0 && (
          <>
            <p className="text-sm text-muted" aria-live="polite">
              Showing {pluralise(items.length, "medicine")}
            </p>
            <ul className="mx-card mx-card--solid divide-y divide-line overflow-hidden">
              {items.map((i) => (
                <StockRow key={i.medicine.id} item={i} notifying={notifying === i.medicine.id} onNotify={() => setNotifying(notifying === i.medicine.id ? null : i.medicine.id)} />
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function StockRow({ item, notifying, onNotify }: { item: PharmacyStockItem; notifying: boolean; onNotify: () => void }) {
  const out = item.stockStatus === "OUT_OF_STOCK";
  return (
    <li className="p-4 sm:px-5">
      {/* Phone: name and price on one line, status below, action below. Wider: four aligned columns. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 sm:grid-cols-[minmax(0,1fr)_6rem_14rem_7.5rem]">
        <div className="min-w-0">
          <p className="font-semibold leading-snug">
            {item.medicine.brandName} {item.medicine.dosage}
          </p>
          <p className="text-sm text-muted">
            {item.medicine.genericName} · {item.medicine.form}
          </p>
        </div>
        <p className="text-right font-bold tabular-nums">{formatPrice(item.price)}</p>
        <div className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-span-1 sm:flex-col sm:items-start sm:gap-1">
          <StockBadge status={item.stockStatus} />
          <Freshness source={item.source} updatedAt={item.updatedAt} />
        </div>
        {/* On wider screens this column exists on every row, filled or not, so the rows line up. */}
        <div className={out ? "col-span-2 sm:col-span-1" : "hidden sm:block"}>
          {out && (
            <Button size="sm" variant="secondary" onClick={onNotify} aria-expanded={notifying}>
              <BellIcon size={14} /> Notify me
            </Button>
          )}
        </div>
      </div>
      {out && notifying && (
        <div className="mt-3 rounded-[var(--card-radius-sm)] bg-canvas p-3.5">
          <NotifyMe medicine={item.medicine} />
        </div>
      )}
    </li>
  );
}
