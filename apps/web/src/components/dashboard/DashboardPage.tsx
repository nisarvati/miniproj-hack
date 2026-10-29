"use client";

import { useMemo, useState } from "react";
import { getNodes, type NodesResponse, type NodeStatusEntry } from "../../lib/api";
import { formatRelativeTime, pluralise } from "../../lib/format";
import { useLiveStream, type NodeEvent } from "../../lib/live";
import { useAsync } from "../../lib/use-async";
import { useNow } from "../../lib/use-now";
import { PulseIcon, RefreshIcon } from "../ui/icons";
import { Alert, Button, EmptyState, Skeleton } from "../ui/primitives";
import { LiveStatus } from "./LiveStatus";
import { NodeStatusGrid } from "./NodeStatusGrid";

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

export function DashboardPage() {
  const nodes = useAsync((signal) => getNodes({ signal }), []);
  // Node updates that arrived over the live stream. They sit on top of what the API returned, and an entry only wins while it is newer
  // than that response, so a fresh Refresh always takes over.
  const [pushed, setPushed] = useState<Record<string, NodeEvent>>({});
  const live = useLiveStream({
    onNode: (event) => setPushed((p) => (p[event.node.pharmacyCode] && takenAt(p[event.node.pharmacyCode]!.meta) > takenAt(event.meta) ? p : { ...p, [event.node.pharmacyCode]: event })),
    // The stream was down for a while, or may have missed events: read the current state instead of guessing.
    onResync: () => {
      if (nodes.status !== "loading") nodes.reload();
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

  return (
    <div className="dashboard-view mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-brand"><PulseIcon size={16} /> Pharmacy nodes</p>
          <h1 className="editorial-title mt-2 text-4xl leading-tight sm:text-5xl">Synchronization status</h1>
          <p className="mt-2 max-w-2xl text-muted">
            Each pharmacy keeps its own inventory and sends changes to MedLink. MedLink is eventually consistent: a change shows up in search after a short,
            variable delay, not instantly, and these readings describe what MedLink has processed so far. Live updates can lag or be missed;
            Refresh reads the current state.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <LiveStatus state={live.state} />
          {updatedAt && <p className="text-sm text-muted" aria-live="off">Updated {formatRelativeTime(updatedAt.toISOString(), now)}</p>}
          <Button variant="secondary" onClick={nodes.reload} loading={loading} aria-label="Refresh status"><RefreshIcon size={16} /> Refresh</Button>
        </div>
      </header>

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

      {view && (
        <>
          <SourceNotes meta={view.meta} />
          {view.list.length === 0 ? (
            <EmptyState icon={<PulseIcon />} title="No pharmacies are configured">
              Once a pharmacy is set up and sends inventory changes, its synchronization status appears here.
            </EmptyState>
          ) : (
            <>
              <p className="text-sm text-muted">Showing {pluralise(view.list.length, "pharmacy")}</p>
              <NodeStatusGrid nodes={view.list} now={new Date(view.meta.generatedAt)} />
              <p className="text-sm text-muted">
                &ldquo;Time since last sync&rdquo; is how long ago MedLink last processed an event for that pharmacy. A pharmacy with no recent changes has a
                long one and is not necessarily unhealthy; a pharmacy is marked degraded or down only when changes are waiting and not being processed.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
