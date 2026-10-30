"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { getNetworkAnalytics, getNodes, type NodesResponse, type NodeStatusEntry } from "../../lib/api";
import { addLagSample, formatSpan, summarizeNodes, type LagSample } from "../../lib/dashboard-data";
import { formatRelativeTime, pluralise } from "../../lib/format";
import { useLiveStream, type NodeEvent } from "../../lib/live";
import { getPharmacyAnalytics, getSession, PortalError } from "../../lib/portal";
import { useAsync } from "../../lib/use-async";
import { useNow } from "../../lib/use-now";
import { AlertIcon, BellIcon, CheckIcon, ClockIcon, ListIcon, PulseIcon, RefreshIcon, StoreIcon, SwapIcon } from "../ui/icons";
import { Alert, Button, Card, EmptyState, Skeleton } from "../ui/primitives";
import { InventorySection, type Access } from "./InventorySection";
import { LiveStatus } from "./LiveStatus";
import { NodeGlance } from "./NodeGlance";
import { NodeStatusGrid } from "./NodeStatusGrid";
import { KpiCard, Section } from "./Panel";
import { Reveal } from "./Reveal";
import { RestockSection } from "./RestockSection";
import { SyncSection } from "./SyncSection";

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

/** What the reader should know about the readings, from what the API said about where they came from. */
function SourceNotes({ meta }: { meta: NodesResponse["meta"] }) {
  return (
    <>
      {meta.redis === "down" && (
        <Alert tone="warn" title="MedLink can't read synchronization status right now">
          Every pharmacy below is shown as unknown, not healthy, and its numbers are unavailable until the status store answers again.
        </Alert>
      )}
      {meta.redis === "not-configured" && (
        <Alert tone="info" title="Live synchronization status is switched off on this server">
          Pharmacies are listed, but nothing can be said about their synchronization.
        </Alert>
      )}
      {meta.redis === "up" && (meta.syncService === "unreachable" || meta.syncService === "not-ready") && (
        <Alert tone="warn" title={meta.syncService === "unreachable" ? "The sync service could not be reached" : "The sync service says it is not ready"}>
          A pharmacy with nothing waiting is shown as {meta.syncService === "unreachable" ? "unknown, because MedLink can't confirm anything is processing its changes" : "degraded"}, not healthy.
        </Alert>
      )}
      {meta.redis === "up" && meta.connector !== "up" && (
        <Alert tone="info">
          Waiting-in-outbox counts are not available because the inventory connector could not be reached. Other readings are unaffected.
        </Alert>
      )}
    </>
  );
}

/** A reading is newer than another when it was taken later. */
const takenAt = (meta: { generatedAt: string }) => Date.parse(meta.generatedAt);

const NAV = [
  ["overview", "Overview"],
  ["inventory", "Inventory"],
  ["sync", "Synchronization"],
  ["network", "Pharmacy network"],
  ["restock", "Restock planning"],
] as const;

/** Live updates to the stock distribution and to the pharmacy's own figures are read again at most this often. */
const REFRESH_DEBOUNCE_MS = 2_500;

export function DashboardPage() {
  const nodes = useAsync((signal) => getNodes({ signal }), []);
  // Node updates that arrived over the live stream. They sit on top of what the API returned, and an entry only wins while it is newer
  // than that response, so a fresh Refresh always takes over.
  const [pushed, setPushed] = useState<Record<string, NodeEvent>>({});
  const [hours, setHours] = useState(24);
  const [days, setDays] = useState(14);
  const network = useAsync((signal) => getNetworkAnalytics(hours, { signal }), [hours]);
  const session = useAsync((signal) => getSession({ signal }), []);
  const staff = session.status === "success" && session.data.pharmacy && session.data.role !== "ADMIN" ? { ...session.data, pharmacy: session.data.pharmacy } : null;
  const mine = useAsync((signal) => getPharmacyAnalytics(days, { signal }), [days], staff !== null);

  // One timer for both: a burst of stock events reads the aggregates once, not once per event.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const own = useRef<string | null>(null);
  own.current = staff?.pharmacy.code ?? null;
  const latest = useRef({ network, mine });
  latest.current = { network, mine };
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const refreshSoon = (pharmacyCode?: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current.network.reload();
      if (own.current && pharmacyCode === own.current) latest.current.mine.reload();
    }, REFRESH_DEBOUNCE_MS);
  };

  const live = useLiveStream({
    onNode: (event) => setPushed((p) => (p[event.node.pharmacyCode] && takenAt(p[event.node.pharmacyCode]!.meta) > takenAt(event.meta) ? p : { ...p, [event.node.pharmacyCode]: event })),
    onStock: (event) => refreshSoon(event.pharmacyCode),
    // The stream was down for a while, or may have missed events: read the current state instead of guessing.
    onResync: () => {
      if (nodes.status !== "loading") nodes.reload();
      latest.current.network.reload();
      if (own.current) latest.current.mine.reload();
    },
  });
  const loading = nodes.status === "loading" || nodes.status === "idle";
  const first = !nodes.data && nodes.status !== "error";
  const now = useNow();

  const view = useMemo(() => {
    if (!nodes.data) return null;
    const base = takenAt(nodes.data.meta);
    let meta: NodesResponse["meta"] = nodes.data.meta;
    const list: NodeStatusEntry[] = nodes.data.data.map((n) => {
      const event = pushed[n.pharmacyCode];
      if (!event || takenAt(event.meta) <= base) return n;
      if (takenAt(event.meta) > takenAt(meta)) meta = { ...meta, ...event.meta };
      return event.node;
    });
    return { list, meta };
  }, [nodes.data, pushed]);
  const updatedAt = view ? new Date(view.meta.generatedAt) : null;
  const summary = useMemo(() => summarizeNodes(view?.list ?? []), [view]);

  // Readings taken while this page is open: the only history there is for the backlog.
  const [samples, setSamples] = useState<LagSample[]>([]);
  useEffect(() => {
    if (view) setSamples((s) => addLagSample(s, takenAt(view.meta), view.list));
  }, [view]);

  const access: Access =
    session.status === "idle" || session.status === "loading" ? { kind: "loading" }
    : staff ? { kind: "staff", session: staff }
    : session.status === "success" ? { kind: "admin" }
    : session.error instanceof PortalError && session.error.kind === "unauthenticated" ? { kind: "signedOut" }
    : { kind: "unreachable" };

  const refreshAll = () => {
    nodes.reload();
    network.reload();
    if (staff) mine.reload();
  };

  const m = mine.data;
  const reporting = summary.processed.known < summary.processed.of;
  const kpiBase = 120;

  // Which section is on screen, for the navigation. Only where the browser can say.
  const [active, setActive] = useState<string>(NAV[0][0]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !view) return;
    const io = new IntersectionObserver((entries) => {
      const best = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (best?.target.id) setActive(best.target.id);
    }, { threshold: [0.4, 0.6, 0.8] });
    for (const [id] of NAV) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [view]);

  return (
    <div className="dashboard-view analytics-view dash-app mx-auto flex w-full max-w-[96rem] flex-col gap-3 lg:grid lg:grid-cols-[10rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-5">
      <nav aria-label="Dashboard sections" className="dash-nav flex gap-1 overflow-x-auto pb-1 max-md:sticky max-md:top-16 max-md:z-30 max-md:bg-canvas lg:flex-col lg:self-start lg:overflow-visible">
        {NAV.map(([id, label]) => (
          <a key={id} href={`#${id}`} aria-current={active === id ? "location" : undefined} className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium hover:bg-control-hover hover:text-ink focus-visible:outline-2 ${active === id ? "bg-brand-soft text-brand-ink" : "text-muted"}`}>{label}</a>
        ))}
      </nav>

      <div className="dash-column flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <Reveal as="header" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-line pb-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <h1 className="editorial-title text-2xl leading-tight sm:text-3xl">MedLink Analytics</h1>
            <p className="text-sm text-muted">Pharmacy network, inventory and synchronization insights.</p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <LiveStatus state={live.state} />
            {updatedAt && <p className="text-sm text-muted" aria-live="off">Updated {formatRelativeTime(updatedAt.toISOString(), now)}</p>}
            <Button size="sm" variant="secondary" onClick={refreshAll} loading={loading} aria-label="Refresh status"><RefreshIcon size={16} /> Refresh</Button>
          </div>
          <p className="w-full text-xs leading-snug text-muted">
            Each pharmacy keeps its own inventory and sends changes to MedLink. MedLink is eventually consistent: a change shows up in search after a short,
            variable delay, not instantly, and these readings describe what MedLink has processed so far. Live updates can lag or be missed;
            Refresh reads the current state.
          </p>
        </Reveal>

        {nodes.status === "error" && (
          <Alert tone="bad" title="We couldn't load the status" action={<Button size="sm" onClick={nodes.reload}>Try again</Button>}>
            {message(nodes.error)}
          </Alert>
        )}

        {first && (
          <div aria-label="Loading status" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <p role="status" className="sr-only">Loading pharmacy status</p>
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-56" />)}
          </div>
        )}

        {view && <SourceNotes meta={view.meta} />}

        {view && (
          view.list.length === 0 ? (
            <EmptyState icon={<PulseIcon />} title="No pharmacies are configured">
              Once a pharmacy is set up and sends inventory changes, its synchronization status appears here.
            </EmptyState>
          ) : (
            <div className="dash-stage min-h-0 flex-1 space-y-8 md:space-y-3">
              <Section id="overview" title="Overview" intro="The network at a glance. A figure MedLink cannot read is marked unavailable, never shown as zero.">
                <ul aria-label="Key figures" className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                  <KpiCard index={0} base={kpiBase} title="Pharmacy nodes" icon={<StoreIcon size={16} />} value={summary.nodes} caption="Pharmacies connected to MedLink" />
                  <KpiCard index={1} base={kpiBase} title="Healthy nodes" icon={<CheckIcon size={16} />} tone={summary.byStatus.healthy === summary.nodes ? "ok" : "warn"} value={`${summary.byStatus.healthy} of ${summary.nodes}`}
                    caption={`${summary.byStatus.degraded} degraded · ${summary.byStatus.down} down · ${summary.byStatus.unknown} unknown`} />
                  <KpiCard index={2} base={kpiBase} title="Events processed" icon={<PulseIcon size={16} />} value={summary.processed.value === null ? "Unavailable" : summary.processed.value.toLocaleString("en-IN")}
                    caption="Since MedLink began counting, all pharmacies" note={reporting && summary.processed.value !== null ? `Counted for ${summary.processed.known} of ${summary.processed.of} pharmacies only` : undefined} />
                  <KpiCard index={3} base={kpiBase} title="Waiting in outboxes" icon={<SwapIcon size={16} />} tone={summary.outbox.value ? "warn" : "neutral"} value={summary.outbox.value === null ? "Unavailable" : summary.outbox.value}
                    caption={summary.outbox.value === null ? "The inventory connector could not be reached" : "Changes recorded but not yet published"} note={summary.outbox.value !== null && summary.outbox.known < summary.outbox.of ? `Reported by ${summary.outbox.known} of ${summary.outbox.of} pharmacies` : undefined} />
                  <KpiCard index={4} base={kpiBase} title="Since last event" icon={<ClockIcon size={16} />} value={formatSpan(summary.averageSinceLastEventMs.value)}
                    caption="Average time since each pharmacy's last processed event. Not the delay of a change" note={summary.averageSinceLastEventMs.value !== null && summary.averageSinceLastEventMs.known < summary.averageSinceLastEventMs.of ? `Known for ${summary.averageSinceLastEventMs.known} of ${summary.averageSinceLastEventMs.of} pharmacies` : undefined} />
                  {access.kind === "staff" ? (
                    <KpiCard index={5} base={kpiBase} title="Your active alerts" icon={<BellIcon size={16} />} tone={m?.alerts.available && m.alerts.active > 0 ? "warn" : "neutral"}
                      value={!m ? "…" : m.alerts.available ? m.alerts.active : "Unavailable"} caption={`Low-stock alerts at ${access.session.pharmacy.name}`} />
                  ) : (
                    <KpiCard index={5} base={kpiBase} title="Alerts and plans" icon={<AlertIcon size={16} />} value="Private" caption={access.kind === "loading" ? "Checking whether you are signed in…" : <>Shown to a pharmacy&apos;s own staff. <Link href="/portal" className="font-semibold text-brand underline underline-offset-2">Sign in</Link></>} />
                  )}
                  {access.kind === "staff" && (
                    <KpiCard index={6} base={kpiBase} title="Your open restock plans" icon={<ListIcon size={16} />} tone={m?.plans.available && m.plans.overdue > 0 ? "warn" : "neutral"}
                      value={!m ? "…" : m.plans.available ? m.plans.open : "Unavailable"} caption={m?.plans.available ? `${m.plans.overdue} overdue` : "Planned or in progress"} />
                  )}
                </ul>
                <NodeGlance nodes={view.list} now={new Date(view.meta.generatedAt)} />
              </Section>

              <InventorySection network={network} access={access} mine={mine} days={days} onDays={setDays} />
              <SyncSection nodes={view.list} summary={summary} network={network} hours={hours} onHours={setHours} samples={samples} />

              <Section id="network" title="Pharmacy network" intro="One card per pharmacy node: health, last event and event counts. Health is a word as well as a colour.">
                <p className="text-sm text-muted">Showing {pluralise(view.list.length, "pharmacy")}</p>
                <NodeStatusGrid nodes={view.list} now={new Date(view.meta.generatedAt)} />
                <Card variant="quiet" className="space-y-1 p-3 text-xs leading-snug text-muted">
                  <p>
                    &ldquo;Time since last sync&rdquo; is how long ago MedLink last processed an event for that pharmacy. A pharmacy with no recent changes has a
                    long one and is not necessarily unhealthy; a pharmacy is marked degraded or down only when changes are waiting and not being processed.
                  </p>
                  <p>
                    This page&apos;s synchronization figures are about <strong className="text-ink">whether each pharmacy&apos;s changes are reaching MedLink</strong>. They are not about stock. How low a
                    medicine is running (stock-risk scores and alerts) and what a pharmacy plans to reorder (restock plans) are different things, and they are private to that pharmacy&apos;s
                    staff in the pharmacy portal.
                  </p>
                </Card>
              </Section>

              <RestockSection access={access} mine={mine} />
            </div>
          )
        )}
      </div>
    </div>
  );
}
