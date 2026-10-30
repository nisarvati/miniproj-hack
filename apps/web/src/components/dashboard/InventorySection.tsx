"use client";

import type { NetworkAnalytics } from "../../lib/api";
import { dayLabel } from "../../lib/dashboard-data";
import { ANALYTICS_DAYS, PortalError, type PortalAnalytics, type StaffSession } from "../../lib/portal";
import { Alert, Button, Segmented, Skeleton } from "../ui/primitives";
import { COLORS, Donut, GroupedBars, HBars, StackedRows } from "./charts";
import { Panel, PrivateNote, Section } from "./Panel";

const Unavailable = ({ what }: { what: string }) => <p className="text-sm text-muted">{what} can&apos;t be read right now. Nothing is shown rather than a zero.</p>;

/** Who is looking: decides whether the pharmacy-private parts are shown, explained or still loading. */
export type Access = { kind: "loading" } | { kind: "signedOut" } | { kind: "unreachable" } | { kind: "admin" } | { kind: "staff"; session: StaffSession };

export function privateMessage(access: Access, what: string): string {
  if (access.kind === "admin") return `${what} belong to one pharmacy, so they are shown only to that pharmacy's staff. An administrator account has no pharmacy.`;
  if (access.kind === "unreachable") return `${what} are private to each pharmacy's staff. They could not be checked right now because the pharmacy portal did not answer.`;
  return `${what} come from one pharmacy's own records, so they are shown only to that pharmacy's signed-in staff, never across the network.`;
}

export type Loadable<T> = { status: "idle" | "loading" | "success" | "error"; data: T | null; error: Error | null; reload: () => void };

/** What staff-only parts say when the portal answers with something other than data. */
function mineProblem(error: Error | null) {
  if (error instanceof PortalError && error.kind === "unauthenticated") return "Your session ended. Sign in again to see your pharmacy's figures.";
  return error?.message ?? "Something went wrong.";
}

export function InventorySection({ network, access, mine, days, onDays }: { network: Loadable<NetworkAnalytics>; access: Access; mine: Loadable<PortalAnalytics>; days: number; onDays: (d: number) => void }) {
  const staff = access.kind === "staff" ? access.session : null;
  const stock = network.data?.data.stock;
  const totals = stock?.available ? stock.byPharmacy.reduce((t, p) => ({ inStock: t.inStock + p.inStock, lowStock: t.lowStock + p.lowStock, outOfStock: t.outOfStock + p.outOfStock, listings: t.listings + p.listings }), { inStock: 0, lowStock: 0, outOfStock: 0, listings: 0 }) : null;
  const m = mine.data;
  const rangePicker = staff && (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <p className="text-sm text-muted">Your pharmacy: <span className="font-semibold text-ink">{staff.pharmacy.name}</span> ({staff.pharmacy.code}). Private to your staff.</p>
      <Segmented label="Date range" value={String(days)} onChange={(v) => onDays(Number(v))} options={ANALYTICS_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} />
    </div>
  );
  const private_ = access.kind !== "loading" && !staff;
  return (
    <Section id="inventory" title="Inventory analytics" intro="What pharmacies hold now and, for signed-in staff, what moved through their own shelves." action={rangePicker}>
      <div className={`grid min-h-min flex-1 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-12 ${private_ || access.kind === "loading" ? "md:grid-rows-[minmax(min-content,1fr)_auto]" : ""}`}>
        <Panel index={0} className={staff ? "lg:col-span-4" : "lg:col-span-6"} title="Stock availability across the network" description={stock?.available ? `Listings by status, as shoppers see them (low means ${stock.threshold} or fewer). A snapshot, not a trend.` : "Listings by status, as shoppers see them. A snapshot, not a trend."}>
          {network.status === "error" && !network.data ? (
            <Alert tone="bad" title="We couldn't load the network figures" action={<Button size="sm" onClick={network.reload}>Try again</Button>}>{network.error?.message}</Alert>
          ) : !stock ? (
            <Skeleton className="h-32" />
          ) : !stock.available || !totals ? (
            <Unavailable what="Stock availability" />
          ) : totals.listings === 0 ? (
            <p className="text-sm text-muted">No pharmacy lists any medicine yet.</p>
          ) : (
            <div className="flex flex-1 flex-col justify-center gap-2">
              <Donut label={`Stock availability across ${stock.byPharmacy.length} pharmacies`} centre={{ value: totals.listings, caption: "listings" }}
                segments={[{ label: "In stock", value: totals.inStock, color: COLORS.ok }, { label: "Low stock", value: totals.lowStock, color: COLORS.warn }, { label: "Out of stock", value: totals.outOfStock, color: COLORS.bad }]} />
              {!stock.live && <p className="text-xs text-warn">Live stock is not available, so this is the last synchronized copy in MedLink&apos;s database.</p>}
            </div>
          )}
        </Panel>

        <Panel index={1} className={staff ? "lg:col-span-4" : "lg:col-span-6"} title="Stock status by pharmacy" description="Each bar is one pharmacy's listings. Counts, never quantities.">
          {!stock ? (
            network.status === "error" ? <Unavailable what="Stock by pharmacy" /> : <Skeleton className="h-32" />
          ) : !stock.available ? (
            <Unavailable what="Stock by pharmacy" />
          ) : (
            <div className="flex flex-1 flex-col justify-center">
              <StackedRows label="Stock status by pharmacy" parts={[{ label: "In stock", color: COLORS.ok }, { label: "Low", color: COLORS.warn }, { label: "Out", color: COLORS.bad }]}
                rows={stock.byPharmacy.map((p) => ({ label: p.pharmacyCode, values: [p.inStock, p.lowStock, p.outOfStock] }))} />
            </div>
          )}
        </Panel>

        {access.kind === "loading" ? (
          <Skeleton className="h-24 md:col-span-2 lg:col-span-12" />
        ) : !staff ? (
          <PrivateNote index={2} className="md:col-span-2 lg:col-span-12" title="Sales, risk and top-selling medicines">{privateMessage(access, "These figures")}</PrivateNote>
        ) : (
          <>
            {mine.status === "error" && !m && <Alert tone="bad" title="We couldn't load your pharmacy's figures" action={<Button size="sm" onClick={mine.reload}>Try again</Button>}>{mineProblem(mine.error)}</Alert>}
            <Panel index={2} className="lg:col-span-4" title="Most frequently sold" description="From recorded sales in this range, not from current stock.">
              {!m ? <Skeleton className="h-32" /> : !m.topSold.available ? <Unavailable what="Sales history" /> : (
                <HBars label="Most sold medicines" unit="units" rows={m.topSold.items.map((i) => ({ label: i.medicineName, value: i.units, hint: `${i.transactions} sales` }))} empty={<p className="text-sm text-muted">No sales were recorded in this range.</p>} />
              )}
            </Panel>
            <Panel index={3} className="md:order-last md:col-span-2 lg:order-none lg:col-span-8" title="Sales and restocks per day" description={`Units sold and received through the portal, per UTC day, for the last ${days} days.`}>
              {!m ? <Skeleton className="h-40" /> : !m.movements.available ? <Unavailable what="Movement history" /> : m.movements.totals.salesTransactions + m.movements.totals.restockTransactions === 0 ? (
                <p className="text-sm text-muted">No sales or restocks were recorded in these {days} days. Only changes made through the portal are recorded; nothing is back-filled.</p>
              ) : (
                <>
                  <GroupedBars fill height={190} label={`Units sold and restocked per day, last ${days} days`} unit="units" labels={m.movements.daily.map((d) => dayLabel(d.date))} tickEvery={days > 14 ? 5 : days > 7 ? 2 : 1}
                    series={[{ name: "Sold", color: COLORS.brand, values: m.movements.daily.map((d) => d.salesUnits) }, { name: "Restocked", color: COLORS.warn, values: m.movements.daily.map((d) => d.restockUnits) }]} />
                  <p className="text-xs text-muted">{m.movements.totals.salesUnits} units sold in {m.movements.totals.salesTransactions} sales; {m.movements.totals.restockUnits} units received in {m.movements.totals.restockTransactions} restocks.{m.movements.stockCountAdjustments > 0 && ` ${m.movements.stockCountAdjustments} stock-count corrections are not counted as sales.`}</p>
                </>
              )}
            </Panel>
            <Panel index={4} className="lg:col-span-4" title="Stock-risk distribution" description="How your medicines score on the stock-risk indicator (an operating signal, not a forecast).">
              {!m ? <Skeleton className="h-32" /> : !m.risk.available ? <Unavailable what="Stock risk" /> : m.risk.total === 0 ? <p className="text-sm text-muted">Your pharmacy lists no medicines.</p> : (
                <div className="flex flex-1 flex-col justify-center">
                  <Donut label="Stock-risk levels" centre={{ value: m.risk.total, caption: "medicines" }}
                    segments={[{ label: "Low risk", value: m.risk.byLevel.LOW, color: COLORS.ok }, { label: "Moderate", value: m.risk.byLevel.MODERATE, color: COLORS.brandSoft }, { label: "High", value: m.risk.byLevel.HIGH, color: COLORS.warn }, { label: "Critical", value: m.risk.byLevel.CRITICAL, color: COLORS.bad }, ...(m.risk.byLevel.UNKNOWN ? [{ label: "Unknown", value: m.risk.byLevel.UNKNOWN, color: COLORS.neutral }] : [])]} />
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </Section>
  );
}
