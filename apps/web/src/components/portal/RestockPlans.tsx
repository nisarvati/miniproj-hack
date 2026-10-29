"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatDay, formatRelativeTime } from "../../lib/format";
import { createPlan, downloadPlansCsv, getPlan, listPlans, PortalError, updatePlan, type PlanFilter, type PlanStatus, type PortalPlan, type PortalStockItem, type RiskLevel } from "../../lib/portal";
import { useAsync } from "../../lib/use-async";
import { ListIcon } from "../ui/icons";
import { Alert, Badge, Button, Card, EmptyState, Input, Segmented, Select, Skeleton } from "../ui/primitives";
import { RiskBadge } from "./StockRisk";

/** What staff were looking at when they chose to plan: shown beside the form so the plan is made with the risk in view. */
export interface PlanContext {
  level: RiskLevel;
  score: number | null;
  quantity: number | null;
  threshold: number | null;
  summary: string;
}
/** A request from elsewhere on the page: start a plan for a medicine (from an alert), or show one plan. A new `nonce` applies it again. */
export type PlanRequest = { kind: "new"; medicineCode: string; context: PlanContext | null; nonce: number } | { kind: "view"; planId: string; nonce: number };

const STATUS: Record<PlanStatus, { label: string; tone: "neutral" | "info" | "ok" }> = {
  PLANNED: { label: "Planned", tone: "neutral" },
  IN_PROGRESS: { label: "In progress", tone: "info" },
  COMPLETED: { label: "Completed", tone: "ok" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};
const isOpen = (s: PlanStatus) => s === "PLANNED" || s === "IN_PROGRESS";

const pad = (n: number) => String(n).padStart(2, "0");
/** A calendar day (YYYY-MM-DD) in the person's own time zone. */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysFromNow = (n: number) => localDay(new Date(Date.now() + n * 86_400_000));
const showDay = formatDay;
/** Only a starting value, which staff can change: sooner when the stock is lower risk-wise. Not a prediction of when stock will run out. */
const startingDate = (level: RiskLevel | undefined) => daysFromNow(level === "CRITICAL" ? 1 : level === "HIGH" ? 3 : 7);

const positiveWhole = (text: string): number | null => (/^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 1_000_000 ? Number(text) : null);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const errText = (err: unknown) => (err instanceof PortalError ? err.message : "Something went wrong.");
const PAGE = 10;
const FILTERS: { value: Extract<PlanFilter, "OPEN" | "COMPLETED" | "CANCELLED" | "ALL">; label: string }[] = [
  { value: "OPEN", label: "Open" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "ALL", label: "All" },
];

/**
 * Restock planning: what staff mean to order, and by when. A plan is a note to self. Creating, editing, rescheduling or completing one never changes stock:
 * only "Record received stock", which uses the restock form, adds stock. The pharmacy is the signed-in one and is never chosen here.
 */
export function PlanPanel({
  stock,
  request,
  refreshKey,
  onRecordRestock,
  onSignedOut,
}: {
  stock: PortalStockItem[] | undefined;
  request: PlanRequest | null;
  refreshKey: number;
  onRecordRestock: (medicineCode: string, quantity: number) => void;
  onSignedOut: () => void;
}) {
  const [filter, setFilter] = useState<"OPEN" | "COMPLETED" | "CANCELLED" | "ALL">("OPEN");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [form, setForm] = useState<{ medicineCode: string; context: PlanContext | null } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const plans = useAsync((signal) => listPlans({ status: filter, limit: PAGE, offset }, { signal }), [filter, offset, version, refreshKey]);
  const selected = useAsync((signal) => getPlan(selectedId!, { signal }), [selectedId, version], selectedId !== null);
  for (const s of [plans, selected]) if (s.status === "error" && s.error instanceof PortalError && s.error.kind === "unauthenticated") queueMicrotask(onSignedOut);

  useEffect(() => {
    if (!request) return;
    if (request.kind === "new") {
      setForm({ medicineCode: request.medicineCode, context: request.context });
      setNotice(null);
    } else {
      setSelectedId(request.planId);
      setForm(null);
    }
    document.getElementById("restock-planning")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [request]);

  const changed = (message: string) => {
    setNotice(message);
    setVersion((v) => v + 1);
  };
  const setFilterAndTop = (f: typeof filter) => {
    setFilter(f);
    setOffset(0);
  };

  async function exportCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const { filename, truncated } = await downloadPlansCsv(filter);
      setNotice(`Downloaded ${filename}.${truncated ? " The file holds the first 10,000 plans only: narrow the filter to export the rest." : ""}`);
    } catch (err) {
      if (err instanceof PortalError && err.kind === "unauthenticated") onSignedOut();
      else setExportError(`The export did not download. ${errText(err)}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section id="restock-planning" aria-label="Restock planning" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Restock planning</h2>
          <p className="text-sm text-muted">
            Note what you mean to order and by when. A plan is a reminder for your team: <strong className="text-ink">completing one does not add stock</strong>. When the delivery
            arrives, use <strong className="text-ink">Record received stock</strong>, which updates your stock and what shoppers see. One open plan per medicine at a time.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => setForm({ medicineCode: "", context: null })} aria-expanded={form !== null}>New plan</Button>
          <Button variant="secondary" onClick={exportCsv} loading={exporting}>Export CSV</Button>
        </div>
      </div>

      {notice && <Alert tone="ok">{notice}</Alert>}
      {exportError && <Alert tone="bad" title="Export failed" action={<Button size="sm" onClick={exportCsv}>Try again</Button>}>{exportError}</Alert>}

      {form && (
        <PlanForm
          stock={stock}
          start={form}
          onCancel={() => setForm(null)}
          onCreated={(plan) => {
            setForm(null);
            setFilterAndTop("OPEN");
            changed(`Plan saved: ${plan.plannedQuantity} × ${plan.medicineName} by ${showDay(plan.targetDate)}. No stock has changed.`);
          }}
          onOpen={(planId) => {
            setForm(null);
            setSelectedId(planId);
          }}
          onSignedOut={onSignedOut}
        />
      )}

      {selectedId && (
        <div className="space-y-2" aria-label="Opened plan">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">The plan you opened</h3>
            <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>Close</Button>
          </div>
          {selected.status === "error" && <Alert tone="bad" title="We couldn't open that plan" action={<Button size="sm" onClick={selected.reload}>Try again</Button>}>{errText(selected.error)}</Alert>}
          {!selected.data && selected.status !== "error" && <Skeleton className="h-28" />}
          {selected.data && (
            <ul aria-label="Opened restock plan">
              <PlanCard plan={selected.data} onChanged={changed} onRecordRestock={onRecordRestock} onSignedOut={onSignedOut} />
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented<typeof filter> label="Show plans" value={filter} onChange={setFilterAndTop} options={FILTERS} />
        {plans.data && <p className="text-sm text-muted" aria-live="polite">{plans.data.total === 0 ? "No plans" : `Showing ${plans.data.offset + 1}–${plans.data.offset + plans.data.items.length} of ${plans.data.total}`}</p>}
      </div>

      {plans.status === "error" && <Alert tone="bad" title="We couldn't load your restock plans" action={<Button size="sm" onClick={plans.reload}>Try again</Button>}>{errText(plans.error)}</Alert>}
      {!plans.data && plans.status !== "error" && (
        <div aria-label="Loading restock plans" className="space-y-2">
          <p role="status" className="sr-only">Loading restock plans</p>
          {[0, 1].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      )}
      {plans.data && plans.data.items.length === 0 && (
        <EmptyState icon={<ListIcon />} title={filter === "OPEN" ? "No open restock plans" : filter === "ALL" ? "No restock plans yet" : `No ${filter.toLowerCase()} plans`} level={3}
          action={filter === "OPEN" || filter === "ALL" ? <Button onClick={() => setForm({ medicineCode: "", context: null })}>Make a plan</Button> : undefined}>
          {filter === "OPEN" || filter === "ALL" ? "Plan a restock from a low-stock alert above, or start one here." : "Plans you move here will be listed."}
        </EmptyState>
      )}
      {plans.data && plans.data.items.length > 0 && (
        <>
          <ul className="space-y-2" aria-label="Restock plans">
            {plans.data.items.map((p) => <PlanCard key={p.planId} plan={p} onChanged={changed} onRecordRestock={onRecordRestock} onSignedOut={onSignedOut} />)}
          </ul>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" disabled={plans.data.offset === 0 || plans.status === "loading"} onClick={() => setOffset(Math.max(0, plans.data!.offset - PAGE))}>Earlier</Button>
            <Button size="sm" variant="secondary" disabled={!plans.data.hasMore || plans.status === "loading"} onClick={() => setOffset(plans.data!.offset + PAGE)}>Later</Button>
          </div>
        </>
      )}
    </section>
  );
}

function PlanForm({
  stock,
  start,
  onCancel,
  onCreated,
  onOpen,
  onSignedOut,
}: {
  stock: PortalStockItem[] | undefined;
  start: { medicineCode: string; context: PlanContext | null };
  onCancel: () => void;
  onCreated: (plan: PortalPlan) => void;
  onOpen: (planId: string) => void;
  onSignedOut: () => void;
}) {
  const [code, setCode] = useState(start.medicineCode);
  const [quantity, setQuantity] = useState(""); // never suggested: there is no demand data to base a number on
  const [date, setDate] = useState(startingDate(start.context?.level));
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const item = stock?.find((i) => i.medicineCode === code);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current) return;
    const q = positiveWhole(quantity);
    if (!item) return setError("Choose a medicine.");
    if (q === null) return setError("The planned quantity must be a whole number, 1 or more.");
    if (!DAY_PATTERN.test(date)) return setError("Choose a target date.");
    submitting.current = true;
    setBusy(true);
    setError(null);
    setExisting(null);
    try {
      onCreated(await createPlan({ medicineCode: item.medicineCode, quantity: q, targetDate: date, ...(notes.trim() && { notes: notes.trim() }) }));
    } catch (err) {
      if (err instanceof PortalError && err.kind === "unauthenticated") onSignedOut();
      else {
        setError(errText(err));
        if (err instanceof PortalError && err.planId) setExisting(err.planId);
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const ctx = start.context;
  return (
    <Card variant="solid" className="space-y-3 p-4">
      <h3 className="text-base font-semibold">New restock plan</h3>
      {ctx && (
        <div className="space-y-1 rounded-[var(--card-radius-sm)] bg-canvas p-3 text-sm" aria-label="Low-stock alert for this medicine">
          <p className="flex flex-wrap items-center gap-2"><span className="font-medium">From a low-stock alert:</span><RiskBadge level={ctx.level} score={ctx.score} /></p>
          <p className="text-muted">{ctx.summary}</p>
          <p>
            In stock now: <span className="font-semibold tabular-nums">{ctx.quantity ?? "?"}</span>
            {ctx.threshold !== null && <> · low-stock threshold {ctx.threshold}</>}. How much to order is yours to decide: MedLink has no sales history to suggest a number.
          </p>
        </div>
      )}
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <label htmlFor="plan-medicine" className="mb-1 block text-xs font-semibold text-muted">Medicine to restock</label>
          <Select id="plan-medicine" value={code} onChange={(e) => setCode(e.target.value)} className="w-full">
            <option value="">{stock ? (stock.length ? "Choose a medicine" : "You have no medicines listed") : "Loading…"}</option>
            {stock?.map((i) => <option key={i.medicineCode} value={i.medicineCode}>{i.brandName} {i.dosage} · {i.quantity} in stock</option>)}
          </Select>
        </div>
        <div className="w-32">
          <label htmlFor="plan-quantity" className="mb-1 block text-xs font-semibold text-muted">Units to order</label>
          <Input id="plan-quantity" inputMode="numeric" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div className="w-44">
          <label htmlFor="plan-date" className="mb-1 block text-xs font-semibold text-muted">Target date</label>
          <Input id="plan-date" type="date" min={daysFromNow(-1)} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="min-w-0 flex-1 basis-56">
          <label htmlFor="plan-notes" className="mb-1 block text-xs font-semibold text-muted">Notes (optional)</label>
          <Input id="plan-notes" maxLength={500} autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Supplier, order number…" />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>Save plan</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </form>
      {error && (
        <Alert tone="bad" title="The plan was not saved" action={existing ? <Button size="sm" onClick={() => onOpen(existing)}>View the open plan</Button> : undefined}>
          {error}
        </Alert>
      )}
    </Card>
  );
}

function PlanCard({
  plan,
  onChanged,
  onRecordRestock,
  onSignedOut,
}: {
  plan: PortalPlan;
  onChanged: (message: string) => void;
  onRecordRestock: (medicineCode: string, quantity: number) => void;
  onSignedOut: () => void;
}) {
  const [mode, setMode] = useState<null | "reschedule" | "edit" | "cancel">(null);
  const [date, setDate] = useState(plan.targetDate);
  const [quantity, setQuantity] = useState(String(plan.plannedQuantity));
  const [notes, setNotes] = useState(plan.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const open = isOpen(plan.status);
  const overdue = open && plan.targetDate < localDay(new Date());
  const { label, tone } = STATUS[plan.status];

  async function change(patch: Parameters<typeof updatePlan>[1], message: string) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await updatePlan(plan.planId, patch);
      setMode(null);
      onChanged(message);
    } catch (err) {
      if (err instanceof PortalError && err.kind === "unauthenticated") onSignedOut();
      else setError(errText(err));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const saveEdit = (e: FormEvent) => {
    e.preventDefault();
    const q = positiveWhole(quantity);
    if (q === null) return setError("The planned quantity must be a whole number, 1 or more.");
    void change({ quantity: q, notes: notes.trim() === "" ? null : notes.trim() }, `Plan updated: ${q} × ${plan.medicineName}.`);
  };
  const saveDate = (e: FormEvent) => {
    e.preventDefault();
    if (!DAY_PATTERN.test(date)) return setError("Choose a target date.");
    void change({ targetDate: date }, `Plan moved to ${showDay(date)}.`);
  };

  return (
    <li>
      <Card variant="solid" className="space-y-2.5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold leading-snug">{plan.medicineName} <span className="ui-mono text-xs font-normal text-muted">{plan.medicineCode}</span></p>
            <p className="text-sm">
              Plan to order <span className="font-semibold tabular-nums">{plan.plannedQuantity}</span> by <time dateTime={plan.targetDate} className="font-semibold">{showDay(plan.targetDate)}</time>
              {overdue && <> <Badge tone="warn">Overdue</Badge></>}
            </p>
          </div>
          <Badge tone={tone}><span className="sr-only">Plan status: </span>{label}</Badge>
        </div>
        <p className="text-sm text-muted">
          In stock now: <span className="font-semibold tabular-nums text-ink">{plan.currentQuantity ?? "not listed"}</span> · updated <time dateTime={plan.updatedAt}>{formatRelativeTime(plan.updatedAt)}</time>
          {plan.completedAt && <> · completed <time dateTime={plan.completedAt}>{formatRelativeTime(plan.completedAt)}</time></>}
        </p>
        {plan.notes && <p className="text-sm">{plan.notes}</p>}
        {plan.status === "COMPLETED" && <p className="text-sm text-muted">Completed means the plan is done. It did not add any stock: if the delivery has arrived, record it below.</p>}

        {mode === "reschedule" && (
          <form onSubmit={saveDate} noValidate className="flex flex-wrap items-end gap-2">
            <div className="w-44">
              <label htmlFor={`date-${plan.planId}`} className="mb-1 block text-xs font-semibold text-muted">New target date</label>
              <Input id={`date-${plan.planId}`} type="date" min={daysFromNow(-1)} value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <Button type="submit" size="sm" variant="primary" loading={busy}>Save date</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </form>
        )}
        {mode === "edit" && (
          <form onSubmit={saveEdit} noValidate className="flex flex-wrap items-end gap-2">
            <div className="w-28">
              <label htmlFor={`qty-${plan.planId}`} className="mb-1 block text-xs font-semibold text-muted">Units to order</label>
              <Input id={`qty-${plan.planId}`} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div className="min-w-0 flex-1 basis-48">
              <label htmlFor={`notes-${plan.planId}`} className="mb-1 block text-xs font-semibold text-muted">Notes</label>
              <Input id={`notes-${plan.planId}`} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <Button type="submit" size="sm" variant="primary" loading={busy}>Save changes</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
          </form>
        )}
        {mode === "cancel" && (
          <div className="flex flex-wrap items-center gap-3 rounded-[var(--card-radius-sm)] bg-canvas p-3 text-sm">
            <p className="flex-1">Cancel this plan? A cancelled plan cannot be reopened; you would make a new one. Your stock is not affected.</p>
            <Button size="sm" variant="danger" loading={busy} onClick={() => change({ status: "CANCELLED" }, `Plan cancelled for ${plan.medicineName}.`)}>Yes, cancel the plan</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Keep it</Button>
          </div>
        )}
        {error && <Alert tone="bad" title="That didn't go through">{error}</Alert>}

        <div className="flex flex-wrap gap-2 pt-1">
          {plan.status === "PLANNED" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => change({ status: "IN_PROGRESS" }, `Plan started for ${plan.medicineName}.`)}>Start</Button>}
          {plan.status === "IN_PROGRESS" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => change({ status: "PLANNED" }, `Plan put back to planned for ${plan.medicineName}.`)}>Back to planned</Button>}
          {open && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => change({ status: "COMPLETED" }, `Plan completed for ${plan.medicineName}. This did not add stock: record the delivery with “Record received stock” when it arrives.`)}>Complete</Button>
          )}
          {plan.status === "COMPLETED" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => change({ status: "IN_PROGRESS" }, `Plan reopened for ${plan.medicineName}.`)}>Reopen</Button>}
          {open && <Button size="sm" variant="secondary" disabled={busy} aria-expanded={mode === "reschedule"} onClick={() => (setDate(plan.targetDate), setError(null), setMode(mode === "reschedule" ? null : "reschedule"))}>Reschedule</Button>}
          {open && <Button size="sm" variant="secondary" disabled={busy} aria-expanded={mode === "edit"} onClick={() => (setQuantity(String(plan.plannedQuantity)), setNotes(plan.notes ?? ""), setError(null), setMode(mode === "edit" ? null : "edit"))}>Edit</Button>}
          {open && <Button size="sm" variant="danger" disabled={busy} aria-expanded={mode === "cancel"} onClick={() => (setError(null), setMode(mode === "cancel" ? null : "cancel"))}>Cancel plan</Button>}
          {plan.status !== "CANCELLED" && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onRecordRestock(plan.medicineCode, plan.plannedQuantity)} aria-label={`Record received stock for ${plan.medicineName}`}>Record received stock</Button>
          )}
        </div>
      </Card>
    </li>
  );
}
