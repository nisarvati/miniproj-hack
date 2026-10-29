"use client";

import { useState } from "react";
import { formatRelativeTime } from "../../lib/format";
import { listAlerts, listRisk, PortalError, type PortalAlert, type PortalRisk, type RiskFactor, type RiskLevel } from "../../lib/portal";
import { useAsync } from "../../lib/use-async";
import { AlertIcon, CheckIcon } from "../ui/icons";
import { Alert, Badge, Button, Card, EmptyState, Skeleton } from "../ui/primitives";

type Tone = "ok" | "info" | "warn" | "bad" | "neutral";
/** Severity styling follows how pressing the stock is: ordinary states stay calm, only HIGH and CRITICAL ask for attention. */
const LEVEL: Record<RiskLevel, { label: string; tone: Tone }> = {
  LOW: { label: "Low risk", tone: "ok" },
  MODERATE: { label: "Moderate risk", tone: "info" },
  HIGH: { label: "High risk", tone: "warn" },
  CRITICAL: { label: "Critical risk", tone: "bad" },
  UNKNOWN: { label: "Risk unknown", tone: "neutral" },
};

/** The level as words as well as a colour, with the score when there is one. */
export function RiskBadge({ level, score }: { level: RiskLevel; score: number | null }) {
  const { label, tone } = LEVEL[level];
  return (
    <Badge tone={tone}>
      <span className="sr-only">Stock risk: </span>
      {label}
      {score !== null && <span className="tabular-nums"> · {score}/100</span>}
    </Badge>
  );
}

function Factors({ factors }: { factors: RiskFactor[] }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium text-brand underline-offset-4 hover:underline">How this score is made</summary>
      <ul className="mt-2 space-y-1.5">
        {factors.map((f) => (
          <li key={f.id} className="flex gap-2">
            <span className="w-14 shrink-0 text-right font-semibold tabular-nums">{f.available && f.points !== null ? `+${f.points}` : "n/a"}</span>
            <span><span className="font-medium">{f.label}.</span> <span className="text-muted">{f.detail}</span></span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const reload = (state: { reload: () => void }) => <Button size="sm" onClick={state.reload}>Try again</Button>;
const errText = (err: unknown) => (err instanceof PortalError ? err.message : "Something went wrong.");

/**
 * Low-stock alerts and a stock-risk ranking for the signed-in pharmacy. The score is an operational indicator (units on hand against the
 * low-stock threshold), not a forecast, and says so. Alerts are opened and closed by the server; this only shows them. `refreshKey` changes when
 * stock changed here, `onRestock` hands a medicine to the restock form.
 */
export function RiskPanel({ refreshKey, onRestock, onSignedOut }: { refreshKey: number; onRestock: (medicineCode: string) => void; onSignedOut: () => void }) {
  const [page, setPage] = useState({ key: refreshKey, offset: 0 });
  const offset = page.key === refreshKey ? page.offset : 0; // stock changed here: back to the riskiest
  const [showResolved, setShowResolved] = useState(false);
  const alerts = useAsync((signal) => listAlerts({ state: "ACTIVE", limit: 20, offset: 0 }, { signal }), [refreshKey]);
  const risk = useAsync((signal) => listRisk({ limit: PAGE, offset }, { signal }), [refreshKey, offset]);
  const resolved = useAsync((signal) => listAlerts({ state: "RESOLVED", limit: 5, offset: 0 }, { signal }), [refreshKey, showResolved], showResolved);
  for (const s of [alerts, risk, resolved]) if (s.status === "error" && s.error instanceof PortalError && s.error.kind === "unauthenticated") queueMicrotask(onSignedOut);

  const threshold = alerts.data?.threshold ?? risk.data?.threshold ?? null;

  return (
    <section aria-label="Stock risk and alerts" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Stock risk and low-stock alerts</h2>
        <p className="text-sm text-muted">
          The risk score (0 to 100) compares the units you have with your low-stock threshold{threshold !== null && <> of <span className="font-semibold text-ink">{threshold}</span></>}.
          It is a guide to what to look at first, not a forecast: how fast something sells is not used. An alert opens when a medicine reaches the threshold and closes when it is back above it.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Active alerts</h3>
        {alerts.status === "error" && <Alert tone="bad" title="We couldn't load the alerts" action={reload(alerts)}>{errText(alerts.error)}</Alert>}
        {!alerts.data && alerts.status !== "error" && (
          <div aria-label="Loading alerts" className="space-y-2">
            <p role="status" className="sr-only">Loading low-stock alerts</p>
            <Skeleton className="h-20" />
          </div>
        )}
        {alerts.data && alerts.data.items.length === 0 && (
          <EmptyState icon={<CheckIcon />} title="No low-stock alerts" level={3}>
            Every medicine you list has more than {threshold ?? "the threshold"} in stock.
          </EmptyState>
        )}
        {alerts.data && alerts.data.items.length > 0 && (
          <ul className="space-y-2" aria-label="Active low-stock alerts">
            {alerts.data.items.map((a) => <AlertCard key={a.alertId} a={a} onRestock={onRestock} />)}
          </ul>
        )}
        {alerts.data && alerts.data.total > alerts.data.items.length && <p className="text-sm text-muted">Showing the latest {alerts.data.items.length} of {alerts.data.total} alerts.</p>}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Risk by medicine, highest first</h3>
        {risk.status === "error" && <Alert tone="bad" title="We couldn't load the risk scores" action={reload(risk)}>{errText(risk.error)}</Alert>}
        {!risk.data && risk.status !== "error" && (
          <div aria-label="Loading risk scores" className="space-y-2">
            <p role="status" className="sr-only">Loading stock risk</p>
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
          </div>
        )}
        {risk.data && risk.data.items.length === 0 && <EmptyState icon={<AlertIcon />} title="No medicines to rate" level={3}>Medicines you list will be scored here.</EmptyState>}
        {risk.data && risk.data.items.length > 0 && (
          <>
            <Card variant="solid" className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <caption className="sr-only">Stock risk by medicine, highest first</caption>
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Medicine</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">In stock</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Risk</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Why</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {risk.data.items.map((r) => <RiskRow key={r.medicineCode} r={r} />)}
                </tbody>
              </table>
            </Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted" aria-live="polite">Showing {risk.data.offset + 1}–{risk.data.offset + risk.data.items.length} of {risk.data.total}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={risk.data.offset === 0 || risk.status === "loading"} onClick={() => setPage({ key: refreshKey, offset: Math.max(0, risk.data!.offset - PAGE) })}>Higher</Button>
                <Button size="sm" variant="secondary" disabled={!risk.data.hasMore || risk.status === "loading"} onClick={() => setPage({ key: refreshKey, offset: risk.data!.offset + PAGE })}>Lower</Button>
              </div>
            </div>
          </>
        )}
      </div>

      <details onToggle={(e) => setShowResolved((e.currentTarget as HTMLDetailsElement).open)} className="text-sm">
        <summary className="cursor-pointer font-medium text-brand underline-offset-4 hover:underline">Recently resolved alerts</summary>
        <div className="mt-2 space-y-2">
          {resolved.status === "error" && <Alert tone="bad" title="We couldn't load them" action={reload(resolved)}>{errText(resolved.error)}</Alert>}
          {showResolved && !resolved.data && resolved.status !== "error" && <Skeleton className="h-12" />}
          {resolved.data && resolved.data.items.length === 0 && <p className="text-muted">No alert has been resolved yet.</p>}
          {resolved.data && resolved.data.items.length > 0 && (
            <ul className="divide-y divide-line rounded-[var(--card-radius-sm)] border border-line">
              {resolved.data.items.map((a) => (
                <li key={a.alertId} className="px-3 py-2.5">
                  <span className="font-medium">{a.medicineName}</span>: low since <time dateTime={a.createdAt}>{formatRelativeTime(a.createdAt)}</time> ({a.quantityAtCreation} left),{" "}
                  {a.resolvedReason === "NO_LONGER_STOCKED" ? "resolved when you stopped listing it" : <>back to {a.quantityAtResolution} <time dateTime={a.resolvedAt ?? undefined}>{a.resolvedAt ? formatRelativeTime(a.resolvedAt) : ""}</time></>}.
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}

const PAGE = 8;

function AlertCard({ a, onRestock }: { a: PortalAlert; onRestock: (code: string) => void }) {
  const now = a.current;
  return (
    <li>
      <Card variant="solid" className="space-y-2.5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold leading-snug">{a.medicineName} <span className="ui-mono text-xs font-normal text-muted">{a.medicineCode}</span></p>
            <p className="text-sm text-muted">
              Low since <time dateTime={a.createdAt} title={new Date(a.createdAt).toLocaleString()}>{formatRelativeTime(a.createdAt)}</time>
              {" · "}<span className="font-semibold tabular-nums text-ink">{now?.quantity ?? "?"}</span> in stock · threshold {now?.threshold ?? a.threshold}
            </p>
          </div>
          {now ? <RiskBadge level={now.level} score={now.score} /> : <RiskBadge level="UNKNOWN" score={null} />}
        </div>
        {now && <p className="text-sm">{now.summary}</p>}
        {now && <Factors factors={now.factors} />}
        <div>
          <Button size="sm" variant="primary" onClick={() => onRestock(a.medicineCode)} aria-label={`Restock ${a.medicineName}`}>Restock this</Button>
        </div>
      </Card>
    </li>
  );
}

function RiskRow({ r }: { r: PortalRisk }) {
  return (
    <tr>
      <td className="px-4 py-3 align-top">
        <span className="font-medium">{r.medicineName}</span>
        {r.alert && <span className="block text-xs text-muted">Alert open</span>}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right align-top font-semibold tabular-nums">{r.quantity ?? "?"}</td>
      <td className="whitespace-nowrap px-4 py-3 align-top"><RiskBadge level={r.level} score={r.score} /></td>
      <td className="px-4 py-3 align-top text-muted">{r.summary}</td>
    </tr>
  );
}
