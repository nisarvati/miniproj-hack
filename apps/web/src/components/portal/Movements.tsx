"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatRelativeTime } from "../../lib/format";
import { listHistory, PortalError, recordRestock, recordSale, type PortalMovement, type PortalStockItem } from "../../lib/portal";
import { useAsync } from "../../lib/use-async";
import { Alert, Badge, Button, Card, EmptyState, Input, Segmented, Select, Skeleton } from "../ui/primitives";
import { ListIcon } from "../ui/icons";

/** A fresh retry key. Sent with a request so that sending the same request again (after a timeout, say) is applied only once. */
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

const positiveWhole = (text: string): number | null => (/^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 1_000_000 ? Number(text) : null);
const label = (i: { brandName: string; dosage: string }) => `${i.brandName} ${i.dosage}`;

type Kind = "sale" | "restock";
const COPY: Record<Kind, { action: string; verb: string; noun: string }> = {
  sale: { action: "Record sale", verb: "Sold", noun: "sale" },
  restock: { action: "Record restock", verb: "Received", noun: "restock" },
};

/**
 * Record a sale or a restock for the signed-in pharmacy. The pharmacy is never chosen here: the portal knows it from the session, and
 * only this pharmacy's own medicines are offered. One submission at a time; a retry of the same entry carries the same key, so it
 * cannot be applied twice, and any edit to the entry starts a new key.
 */
export function TransactionPanel({
  items,
  onRecorded,
  onSignedOut,
  preset,
}: {
  items: PortalStockItem[] | undefined;
  onRecorded: () => void;
  onSignedOut: () => void;
  /** Fills the form for a restock of this medicine (from "Restock this" on an alert). A new `nonce` applies it again. */
  preset?: { medicineCode: string; nonce: number } | null;
}) {
  const [kind, setKind] = useState<Kind>("sale");
  const [code, setCode] = useState("");
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const key = useRef(newKey());
  const submitting = useRef(false);

  useEffect(() => {
    if (!preset) return;
    setKind("restock");
    setCode(preset.medicineCode);
    setQuantity("");
    setError(null);
    setDone(null);
    key.current = newKey();
    const form = document.getElementById("txn-medicine");
    form?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    document.getElementById("txn-quantity")?.focus();
  }, [preset]);

  const item = items?.find((i) => i.medicineCode === code);
  const edited = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    key.current = newKey(); // different details: not a retry of the previous entry
    setError(null);
    setDone(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting.current) return; // a second click while the first is still on its way
    const q = positiveWhole(quantity);
    if (!item) return setError("Choose a medicine.");
    if (q === null) return setError("Quantity must be a whole number, 1 or more.");
    if (kind === "sale" && q > item.quantity) return setError(`Only ${item.quantity} in stock: you can't sell ${q}.`);
    submitting.current = true;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { movement, replayed } = await (kind === "sale" ? recordSale : recordRestock)({ medicineCode: item.medicineCode, quantity: q }, key.current);
      setDone(
        replayed
          ? `This ${COPY[kind].noun} was already recorded, so nothing changed. ${movement.quantityAfter} in stock.`
          : `${COPY[kind].verb} ${movement.quantity} × ${label(item)}. ${movement.quantityAfter} now in stock.`,
      );
      setQuantity("");
      key.current = newKey();
      onRecorded();
    } catch (err) {
      if (err instanceof PortalError && err.kind === "unauthenticated") onSignedOut();
      else setError(err instanceof PortalError ? err.message : "Something went wrong.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Card variant="solid" className="space-y-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Record a sale or restock</h3>
        <Segmented<Kind> label="What happened" value={kind} onChange={edited(setKind)} options={[{ value: "sale", label: "Sale" }, { value: "restock", label: "Restock" }]} />
      </div>
      <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <label htmlFor="txn-medicine" className="mb-1 block text-xs font-semibold text-muted">Medicine for this entry</label>
          <Select id="txn-medicine" value={code} onChange={(e) => edited(setCode)(e.target.value)} aria-describedby="txn-stock" className="w-full">
            <option value="">{items ? (items.length ? "Choose a medicine" : "You have no medicines listed") : "Loading…"}</option>
            {items?.map((i) => <option key={i.medicineCode} value={i.medicineCode}>{label(i)} · {i.quantity} in stock</option>)}
          </Select>
        </div>
        <div className="w-32">
          <label htmlFor="txn-quantity" className="mb-1 block text-xs font-semibold text-muted">{kind === "sale" ? "Units sold" : "Units received"}</label>
          <Input id="txn-quantity" inputMode="numeric" autoComplete="off" value={quantity} onChange={(e) => edited(setQuantity)(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? "txn-error" : undefined} />
        </div>
        <Button type="submit" variant="primary" loading={busy}>{COPY[kind].action}</Button>
      </form>
      <p id="txn-stock" className="text-sm text-muted" aria-live="polite">{item ? <>Currently <span className="font-semibold tabular-nums text-ink">{item.quantity}</span> in stock.</> : "Pick a medicine to see how many you have."}</p>
      {error && <Alert id="txn-error" tone="bad" title={`The ${COPY[kind].noun} was not recorded`}>{error}</Alert>}
      {done && <Alert tone="ok">{done} Shoppers will see it within a few seconds.</Alert>}
    </Card>
  );
}

const PAGE = 10;
const signed = (n: number) => (n > 0 ? `+${n}` : `−${Math.abs(n)}`);

/** The pharmacy's own record of sales, restocks and stock counts, newest first. `refreshKey` changes when something new was recorded. */
export function HistoryPanel({ refreshKey, onSignedOut }: { refreshKey: number; onSignedOut: () => void }) {
  const [page, setPage] = useState({ key: refreshKey, offset: 0 });
  const offset = page.key === refreshKey ? page.offset : 0; // something new was recorded: back to the newest
  const history = useAsync((signal) => listHistory({ limit: PAGE, offset }, { signal }), [offset, refreshKey]);
  if (history.status === "error" && history.error instanceof PortalError && history.error.kind === "unauthenticated") queueMicrotask(onSignedOut);

  const data = history.data;
  const go = (next: number) => setPage({ key: refreshKey, offset: next });

  return (
    <section aria-label="Movement history" className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">Movement history</h2>
        <p className="text-sm text-muted">Sales, restocks and stock counts recorded in this portal, newest first. Changes made before this list existed, or some other way, are not shown.</p>
      </div>
      {history.status === "error" && (
        <Alert tone="bad" title="We couldn't load the history" action={<Button size="sm" onClick={history.reload}>Try again</Button>}>
          {history.error instanceof PortalError ? history.error.message : "Something went wrong."}
        </Alert>
      )}
      {!data && history.status !== "error" && (
        <div className="space-y-2" aria-label="Loading history">
          <p role="status" className="sr-only">Loading movement history</p>
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
        </div>
      )}
      {data && data.items.length === 0 && (
        <EmptyState icon={<ListIcon />} title={data.total === 0 ? "No movements recorded yet" : "No more movements"}>
          {data.total === 0 ? "A sale, restock or stock count recorded here will appear in this list." : "That was the oldest one."}
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <>
          <Card variant="solid" className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">Stock movements, newest first</caption>
              <thead className="border-b border-line text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-semibold">When</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Medicine</th>
                  <th scope="col" className="px-4 py-2.5 font-semibold">Change</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-semibold">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((m) => <MovementRow key={m.movementId} m={m} />)}
              </tbody>
            </table>
          </Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted" aria-live="polite">Showing {data.offset + 1}–{data.offset + data.items.length} of {data.total}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={data.offset === 0 || history.status === "loading"} onClick={() => go(Math.max(0, data.offset - PAGE))}>Newer</Button>
              <Button size="sm" variant="secondary" disabled={!data.hasMore || history.status === "loading"} onClick={() => go(data.offset + PAGE)}>Older</Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function MovementRow({ m }: { m: PortalMovement }) {
  return (
    <tr>
      <td className="whitespace-nowrap px-4 py-3 align-top">
        <time dateTime={m.occurredAt} title={new Date(m.occurredAt).toLocaleString()}>{formatRelativeTime(m.occurredAt)}</time>
        {m.byYou && <span className="block text-xs text-muted">by you</span>}
      </td>
      <td className="px-4 py-3 align-top">
        <span className="font-medium">{m.medicineName}</span>
        {m.source === "STOCK_COUNT" && <span className="block text-xs text-muted">Stock count</span>}
      </td>
      <td className="px-4 py-3 align-top">
        <Badge tone={m.operation === "SALE" ? "info" : "ok"}>{m.operation === "SALE" ? "Sale" : "Restock"}</Badge>{" "}
        <span className="font-semibold tabular-nums">
          <span className="sr-only">{m.operation === "SALE" ? "minus " : "plus "}{m.quantity}</span>
          <span aria-hidden="true">{signed(m.quantityDelta)}</span>
        </span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right align-top tabular-nums">
        <span className="text-muted">{m.quantityBefore}</span> → <span className="font-semibold">{m.quantityAfter}</span>
      </td>
    </tr>
  );
}
