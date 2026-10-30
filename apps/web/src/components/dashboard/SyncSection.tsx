"use client";

import type { NetworkAnalytics, NodeStatusEntry } from "../../lib/api";
import { bucketLabel, formatSpan, sumBuckets, type LagSample, type NodeSummary } from "../../lib/dashboard-data";
import { Alert, Button, Segmented, Skeleton } from "../ui/primitives";
import { CheckIcon, PulseIcon, StoreIcon } from "../ui/icons";
import { COLORS, GroupedBars, HBars, LineChart } from "./charts";
import type { Loadable } from "./InventorySection";
import { Panel, Section } from "./Panel";

const WINDOWS = [6, 24, 72] as const;

export function SyncSection({ nodes, summary, network, hours, onHours, samples }: { nodes: NodeStatusEntry[]; summary: NodeSummary; network: Loadable<NetworkAnalytics>; hours: number; onHours: (h: number) => void; samples: LagSample[] }) {
  const events = network.data?.data.events;
  const window = network.data?.data.window;
  const reporting = nodes.filter((n) => n.processedCount !== null);
  const silent = nodes.filter((n) => n.processedCount === null).map((n) => n.pharmacyCode);
  return (
    <Section id="sync" title="Distributed synchronization" intro="How changes travel to MedLink: published to a stream, then processed. About events, not stock.">
      <div className="grid min-h-min flex-1 grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-12">
        <Panel index={0} className="md:col-span-2 lg:col-span-7" title="Events published to the stream" description="How many events each pharmacy's stream retains, by the time its connector published them. This is published, not processed: MedLink does not keep a history of processed events."
          action={<Segmented label="Time window" value={String(hours)} onChange={(v) => onHours(Number(v))} options={WINDOWS.map((h) => ({ value: String(h), label: `${h} h` }))} />}>
          {network.status === "error" && !network.data ? (
            <Alert tone="bad" title="We couldn't load event activity" action={<Button size="sm" onClick={network.reload}>Try again</Button>}>{network.error?.message}</Alert>
          ) : !events || !window ? (
            <Skeleton className="h-52" />
          ) : !events.available ? (
            <p className="text-sm text-muted">{events.reason === "NOT_CONFIGURED" ? "Event activity is switched off on this server (no Redis connection)." : "Event activity can't be read right now."} Nothing is shown rather than a zero.</p>
          ) : events.byPharmacy.every((p) => p.total === 0) ? (
            <p className="text-sm text-muted">No events were published in the last {hours} hours.</p>
          ) : (
            <>
              <GroupedBars fill height={170} label={`Events published per ${window.bucketMinutes} minutes, last ${hours} hours, all pharmacies`} unit="events" tickEvery={4}
                labels={window.bucketStarts.map((s) => bucketLabel(s))} series={[{ name: "Events published", color: COLORS.brand, values: sumBuckets(events.byPharmacy, window.bucketStarts.length) }]} />
              <p className="text-xs text-muted">Each bar is {window.bucketMinutes} minutes (local time). Total {events.byPharmacy.reduce((n, p) => n + p.total, 0)} events across {events.byPharmacy.length} pharmacies.{events.truncated && " Counts are capped at 5,000 entries per pharmacy, so very busy pharmacies are understated."}</p>
            </>
          )}
        </Panel>

        <Panel index={1} className="lg:col-span-5" title="Event outcomes by pharmacy" description="Since MedLink began counting. Duplicates are redeliveries it skipped; stale events were older than data it already held and changed nothing.">
          {reporting.length === 0 ? (
            <p className="text-sm text-muted">No pharmacy has reported event counts, so nothing is charted. Unknown is not zero.</p>
          ) : (
            <>
              <GroupedBars fill height={170} label="Events processed, duplicate and stale, per pharmacy" unit="events" labels={reporting.map((n) => n.pharmacyCode)}
                series={[{ name: "Processed", color: COLORS.brand, values: reporting.map((n) => n.processedCount ?? 0) }, { name: "Duplicates", color: COLORS.warn, values: reporting.map((n) => n.duplicateCount ?? 0) }, { name: "Stale", color: COLORS.bad, values: reporting.map((n) => n.staleCount ?? 0) }]} />
              {silent.length > 0 && <p className="text-xs text-warn">No reading for {silent.join(", ")}: left out, not counted as zero.</p>}
              {reporting.some((n) => n.duplicateCount === null || n.staleCount === null) && <p className="text-xs text-warn">A missing duplicate or stale count is drawn as no bar; it does not mean zero.</p>}
            </>
          )}
        </Panel>

        <Panel index={2} className="lg:col-span-4" title="Time since each pharmacy's last event" description="Right now. A quiet pharmacy has a long one and is not necessarily unhealthy; this is not the delay of a change.">
          <HBars label="Time since last processed event" unit="" rows={nodes.filter((n) => n.syncLagMs !== null).map((n) => ({ label: `${n.pharmacyCode} · ${n.name}`, value: n.syncLagMs!, display: formatSpan(n.syncLagMs) }))}
            empty={<p className="text-sm text-muted">No pharmacy has processed an event yet, so there is nothing to compare.</p>} />
          {nodes.some((n) => n.syncLagMs === null) && nodes.some((n) => n.syncLagMs !== null) && <p className="text-xs text-warn">Unknown for {nodes.filter((n) => n.syncLagMs === null).map((n) => n.pharmacyCode).join(", ")}.</p>}
        </Panel>

        <Panel index={3} className="lg:col-span-4" title="Events waiting in pharmacy outboxes" description="Changes a pharmacy has recorded but not yet published, in total across the pharmacies the connector reported, measured while this page is open.">
          {summary.outbox.value === null ? (
            <p className="text-sm text-muted">The inventory connector could not be reached, so the backlog is unknown. It is not shown as zero.</p>
          ) : samples.length < 2 ? (
            <p className="text-sm text-muted"><span className="text-2xl font-bold text-ink">{summary.outbox.value}</span> waiting now. A trend appears once more readings arrive while this page is open.</p>
          ) : (
            <LineChart fill height={140} label="Events waiting in pharmacy outboxes since this page was opened" unit="events" labels={samples.map((s) => bucketLabel(new Date(s.at).toISOString()))} series={[{ name: "Waiting", color: COLORS.warn, values: samples.map((s) => s.backlog) }]} />
          )}
          <p className="text-xs text-muted">Readings are taken when MedLink reports a change or you refresh. Nothing before this page was opened is known.</p>
        </Panel>

        <Panel index={4} className="lg:col-span-4" title="Three different kinds of health" description="They are separate, and one does not imply another.">
          <ul className="space-y-2.5">
            <li><p className="flex items-center gap-2 text-sm font-semibold"><PulseIcon size={15} /> Event processing</p><p className="text-xs text-muted">Whether published events are being processed without waiting. Shown in this section.</p></li>
            <li><p className="flex items-center gap-2 text-sm font-semibold"><StoreIcon size={15} /> Pharmacy node</p><p className="text-xs text-muted">Whether MedLink has evidence that a pharmacy&apos;s changes are arriving. Shown as a status on each pharmacy card.</p></li>
            <li><p className="flex items-center gap-2 text-sm font-semibold"><CheckIcon size={15} /> Medicine stock risk</p><p className="text-xs text-muted">How low a medicine is running at a pharmacy. Private to that pharmacy&apos;s staff.</p></li>
          </ul>
          <p className="text-xs text-muted">{summary.byStatus.healthy} of {summary.nodes} pharmacy nodes are healthy; that says nothing about their stock.</p>
        </Panel>
      </div>
    </Section>
  );
}
