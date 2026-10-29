import type { ReactNode } from "react";
import type { NodeStatus, NodeStatusEntry } from "../../lib/api";
import { formatDuration, formatRelativeTime } from "../../lib/format";
import { AlertIcon, CheckIcon, InfoIcon, XIcon } from "../ui/icons";
import { Badge, Card } from "../ui/primitives";

const STATUS: Record<NodeStatus, { label: string; tone: "ok" | "warn" | "bad" | "neutral"; Icon: typeof CheckIcon; meaning: string }> = {
  healthy: { label: "Healthy", tone: "ok", Icon: CheckIcon, meaning: "Synchronization is caught up" },
  degraded: { label: "Degraded", tone: "warn", Icon: AlertIcon, meaning: "Synchronization is slow or partly failing" },
  down: { label: "Down", tone: "bad", Icon: XIcon, meaning: "Synchronization is not working" },
  unknown: { label: "Unknown", tone: "neutral", Icon: InfoIcon, meaning: "MedLink has no reliable evidence either way" },
};

/** The status as a word as well as a colour and an icon, so it never depends on colour alone. */
export function StatusBadge({ status }: { status: NodeStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} title={s.meaning}>
      <s.Icon size={14} aria-hidden="true" />
      <span className="sr-only">Status: </span>
      {s.label}
    </Badge>
  );
}

const UNKNOWN = <span className="text-muted">Unknown</span>;

function Metric({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-base font-semibold tabular-nums" title={hint}>{children}</dd>
    </div>
  );
}

const count = (n: number | null) => (n === null ? UNKNOWN : n.toLocaleString("en-IN"));

/** One card per pharmacy. `now` is the time of the response, so "x ago" is relative to when the numbers were read. */
export function NodeCard({ node, now }: { node: NodeStatusEntry; now: Date }) {
  return (
    <li>
      <Card variant="solid" role="group" className="h-full space-y-4 p-5" aria-label={`${node.name}, pharmacy ${node.pharmacyCode}`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold leading-snug">{node.name}</h3>
            <p className="ui-mono text-xs text-muted">Pharmacy {node.pharmacyCode}</p>
          </div>
          <StatusBadge status={node.status} />
        </div>
        {node.statusReason && <p className="text-sm text-muted">{node.statusReason}</p>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Metric label="Last synchronized" hint="When MedLink last processed an event for this pharmacy">
            {node.lastSyncedAt ? <time dateTime={node.lastSyncedAt} title={node.lastSyncedAt}>{formatRelativeTime(node.lastSyncedAt, now)}</time> : <span className="text-muted">Never / unknown</span>}
          </Metric>
          <Metric label="Time since last sync" hint="Time between the last processed event and this reading. A quiet pharmacy has a long one.">
            {node.syncLagMs === null ? UNKNOWN : formatDuration(node.syncLagMs)}
          </Metric>
          <Metric label="Events processed">{count(node.processedCount)}</Metric>
          <Metric label="Duplicate events" hint="Redeliveries MedLink recognised and skipped">{count(node.duplicateCount)}</Metric>
          <Metric label="Stale events" hint="Older events that did not overwrite newer stock data">{count(node.staleCount)}</Metric>
          <Metric label="Waiting in pharmacy outbox" hint="Changes the pharmacy has recorded but not yet published">
            {node.unpublishedOutbox === null ? <span className="text-muted">Not available</span> : count(node.unpublishedOutbox)}
          </Metric>
        </dl>
      </Card>
    </li>
  );
}

export function NodeStatusGrid({ nodes, now }: { nodes: NodeStatusEntry[]; now: Date }) {
  return (
    <ul aria-label="Pharmacy synchronization status" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {nodes.map((n) => <NodeCard key={n.pharmacyCode} node={n} now={now} />)}
    </ul>
  );
}
