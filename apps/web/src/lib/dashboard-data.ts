import type { NodeStatus, NodeStatusEntry } from "./api";

/**
 * Pure figures for the analytics dashboard. A reading that is unknown (null) is never counted as 0: a total over some unknown pharmacies says how many
 * it covered (`known` of `of`), so the page can say "partial" instead of showing a number that looks complete.
 */
export interface Total {
  /** null: no pharmacy reported this reading at all. */
  value: number | null;
  known: number;
  of: number;
}

const total = (values: (number | null)[]): Total => {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return { value: known.length ? known.reduce((a, b) => a + b, 0) : null, known: known.length, of: values.length };
};

export interface NodeSummary {
  nodes: number;
  byStatus: Record<NodeStatus, number>;
  processed: Total;
  duplicates: Total;
  stale: Total;
  outbox: Total;
  /** Mean time since each pharmacy's last processed event (not the delay of a change), over the pharmacies that have one. */
  averageSinceLastEventMs: { value: number | null; known: number; of: number };
}

export function summarizeNodes(nodes: NodeStatusEntry[]): NodeSummary {
  const byStatus: Record<NodeStatus, number> = { healthy: 0, degraded: 0, down: 0, unknown: 0 };
  for (const n of nodes) byStatus[n.status]++;
  const lags = nodes.map((n) => n.syncLagMs).filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0);
  return {
    nodes: nodes.length,
    byStatus,
    processed: total(nodes.map((n) => n.processedCount)),
    duplicates: total(nodes.map((n) => n.duplicateCount)),
    stale: total(nodes.map((n) => n.staleCount)),
    outbox: total(nodes.map((n) => n.unpublishedOutbox)),
    averageSinceLastEventMs: { value: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : null, known: lags.length, of: nodes.length },
  };
}

/** A share as a whole percentage, or null when there is nothing to divide by. */
export const percentOf = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

/** A "nice" top for an axis: 1, 2, 5 times a power of ten, at least `value`, never 0 so an all-zero chart still has a scale. */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const f = value / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** Backlog readings taken while the page is open. They are measurements of this session only, never a stored history. */
export interface LagSample {
  at: number;
  /** Events waiting in pharmacy outboxes, summed over the pharmacies that reported one. null: none reported (the connector could not be reached). */
  backlog: number | null;
}
export const MAX_SAMPLES = 60;

/** Adds a reading, ignoring one that is not newer than the last (a repeated live event) and keeping only the most recent MAX_SAMPLES. */
export function addLagSample(samples: LagSample[], at: number, nodes: NodeStatusEntry[]): LagSample[] {
  if (!Number.isFinite(at) || (samples.length && at <= samples[samples.length - 1]!.at)) return samples;
  const next = [...samples, { at, backlog: total(nodes.map((n) => n.unpublishedOutbox)).value }];
  return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
}

/** Bucket start times as short labels: "14:00" for hour-sized buckets, "14:15" for quarter hours, "Oct 29" style is left to the caller for days. */
export function bucketLabel(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone && { timeZone }) });
}

export const dayLabel = (isoDate: string): string => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
};

/** Sum of per-pharmacy bucket arrays, bucket by bucket. */
export function sumBuckets(rows: { buckets: number[] }[], length: number): number[] {
  const out = new Array<number>(length).fill(0);
  for (const r of rows) for (let i = 0; i < length; i++) out[i]! += r.buckets[i] ?? 0;
  return out;
}

/** How long, in words that do not suggest precision the measurement does not have. */
export function formatSpan(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "Unknown";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
