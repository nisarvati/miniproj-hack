import { activePharmacies, presentPharmacy } from "@medlink/db";
import type { ConnectorHealthSource, ConnectorPharmacy, ConnectorReading } from "./connector-health.js";
import type { SyncServiceHealthSource, SyncServiceState } from "./service-health.js";
import type { NodeReading, SyncRecord, SyncStatusSource } from "./sync-status.js";

export type NodeStatus = "healthy" | "degraded" | "down" | "unknown";

/**
 * The thresholds behind `status`. Silence alone is never a failure (a pharmacy that sells nothing records nothing), so freshness is
 * only held against a node that has events WAITING to be processed:
 *   waiting events, last processed within DEGRADED_AFTER_MS     healthy   (the service is working through them)
 *   waiting events, last processed DEGRADED_AFTER_MS to DOWN_AFTER_MS  degraded  (slow, or stalled for a short time)
 *   waiting events, last processed over DOWN_AFTER_MS ago       down      (the sync service is not consuming)
 * Nothing waiting is "healthy" only if the sync service itself confirms it is running (when that check is configured). The full rules are
 * in deriveStatus and docs/node-status.md.
 */
export const THRESHOLDS = { degradedAfterMs: 15_000, downAfterMs: 120_000 } as const;

export interface NodeStatusEntry {
  pharmacyCode: string;
  name: string;
  status: NodeStatus;
  /** One line saying which evidence decided `status`. */
  statusReason: string;
  /** When the sync service last processed an event for this pharmacy. null: never, or the stored value is unusable. */
  lastSyncedAt: string | null;
  /** Milliseconds from lastSyncedAt to now ("time since the last processed event"). null when lastSyncedAt is null. */
  syncLagMs: number | null;
  /** From the connector's health endpoint. null: not available (connector unreachable, or it could not count). */
  unpublishedOutbox: number | null;
  staleCount: number | null;
  duplicateCount: number | null;
  processedCount: number | null;
}

export interface NodesResponse {
  data: NodeStatusEntry[];
  meta: {
    generatedAt: string;
    /** "down" or "not-configured": no node can be assessed, every status is "unknown" and every counter null. */
    redis: "up" | "down" | "not-configured";
    connector: "up" | "unreachable" | "stale" | "not-configured";
    /** The sync service's own health report. Anything but "ready" or "not-configured" keeps caught-up nodes from being called healthy. */
    syncService: SyncServiceState | "not-configured";
    thresholds: typeof THRESHOLDS;
  };
}

export interface NodeSources {
  sync?: SyncStatusSource;
  connector?: ConnectorHealthSource;
  /** Confirms the sync service is running. Without it nothing can tell "caught up" from "nobody is consuming", and the check is skipped. */
  syncService?: SyncServiceHealthSource;
  /** The pharmacies to report on. Defaults to the pharmacy registry's active pharmacies. */
  pharmacies?: () => { code: string; name: string }[];
  now?: () => number;
}

/** The configured, active pharmacies as shoppers see them. Reads the registry only: no database. */
export const registryPharmacies = (env: NodeJS.ProcessEnv = process.env) =>
  activePharmacies(env).map((p) => ({ code: p.code, name: presentPharmacy(p).name }));

/** Time since `iso` in ms, or null when there is no usable timestamp or it lies in the future (clock skew is not "lag"). */
export function lagMs(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  return Number.isFinite(then) && then <= now ? now - then : null;
}

export function deriveStatus(input: {
  redisUp: boolean;
  reading: NodeReading | undefined;
  connector: ConnectorPharmacy | undefined;
  syncService: SyncServiceState | "not-configured";
  lag: number | null;
}): { status: NodeStatus; reason: string } {
  const { redisUp, reading, connector, syncService, lag } = input;
  if (!redisUp || !reading) return { status: "unknown", reason: "Redis is not reachable, so the sync status cannot be read." };
  if (connector?.databaseUp === false) return { status: "down", reason: "The connector cannot reach this pharmacy's database." };

  const { backlog } = reading;
  if (backlog !== null && backlog > 0) {
    if (lag === null) return { status: "degraded", reason: `${backlog} event(s) are waiting and none has been processed yet.` };
    if (lag > THRESHOLDS.downAfterMs) return { status: "down", reason: `${backlog} event(s) are waiting and none was processed for over ${THRESHOLDS.downAfterMs / 1000} s.` };
    if (lag > THRESHOLDS.degradedAfterMs) return { status: "degraded", reason: `${backlog} event(s) are waiting and none was processed for over ${THRESHOLDS.degradedAfterMs / 1000} s.` };
    return { status: "healthy", reason: `${backlog} event(s) are waiting and the sync service is processing them.` };
  }
  if (connector?.pollingFailing) return { status: "degraded", reason: "The connector's last attempt to read this pharmacy's outbox failed." };
  if (backlog === 0 && lag !== null) {
    if (syncService === "not-ready") return { status: "degraded", reason: "No events are waiting, but the sync service reports that it is not ready." };
    if (syncService === "unreachable") return { status: "unknown", reason: "No events are waiting, but the sync service could not be reached to confirm it is running." };
    if (syncService === "stale") return { status: "unknown", reason: "No events are waiting, but the sync service's last heartbeat is too old to confirm it is running." };
    return { status: "healthy", reason: "No events are waiting; the last event was processed." };
  }
  if (reading.record === null) return { status: "unknown", reason: "No event has been synchronized for this pharmacy yet." };
  if (lag === null) return { status: "unknown", reason: "The stored last-sync time is missing or unusable." };
  return { status: "unknown", reason: "The number of waiting events could not be measured." };
}

export async function getNodes(src: NodeSources): Promise<NodesResponse> {
  const now = (src.now ?? Date.now)();
  const pharmacies = (src.pharmacies ?? registryPharmacies)();
  const codes = pharmacies.map((p) => p.code);

  const sync = src.sync ? await src.sync.read(codes) : null;
  const connector: ConnectorReading | null = src.connector ? await src.connector.read() : null;
  const syncService: SyncServiceState | "not-configured" = src.syncService ? await src.syncService.read() : "not-configured";
  const nodes = sync?.redis === "up" ? sync.nodes : undefined;

  const data = pharmacies.map((p): NodeStatusEntry => {
    const reading = nodes?.get(p.code);
    const record: SyncRecord | null = reading?.record ?? null;
    const c = connector?.reachable ? connector.pharmacies.get(p.code) : undefined;
    const lastSyncedAt = record?.lastSyncedAt ?? null;
    const lag = lagMs(lastSyncedAt, now);
    const { status, reason } = deriveStatus({ redisUp: sync?.redis === "up", reading, connector: c, syncService, lag });
    return {
      pharmacyCode: p.code,
      name: p.name,
      status,
      statusReason: reason,
      lastSyncedAt,
      syncLagMs: lag,
      unpublishedOutbox: c?.unpublishedOutbox ?? null,
      staleCount: record?.staleCount ?? null,
      duplicateCount: record?.duplicateCount ?? null,
      processedCount: record?.processedCount ?? null,
    };
  });

  return {
    data,
    meta: {
      generatedAt: new Date(now).toISOString(),
      redis: sync === null ? "not-configured" : sync.redis,
      connector: connector === null ? "not-configured" : connector.reachable ? "up" : connector.stale ? "stale" : "unreachable",
      syncService,
      thresholds: THRESHOLDS,
    },
  };
}
