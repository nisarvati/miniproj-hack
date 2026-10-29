"use client";

import { useRef, useState } from "react";
import { formatRelativeTime } from "../../lib/format";
import { decideStaffRequest, listStaffRequests, PortalError, signOut, type AccountStatus, type PortalSession, type StaffAccount } from "../../lib/portal";
import { useAsync } from "../../lib/use-async";
import { ListIcon, ShieldIcon } from "../ui/icons";
import { Alert, Badge, Button, Card, EmptyState, Segmented, Skeleton } from "../ui/primitives";

const FILTERS: { value: AccountStatus | "all"; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "active", label: "Active" },
  { value: "rejected", label: "Declined" },
  { value: "all", label: "All" },
];
const STATUS: Record<AccountStatus, { label: string; tone: "info" | "ok" | "neutral" }> = {
  pending: { label: "Waiting for a decision", tone: "info" },
  active: { label: "Active", tone: "ok" },
  rejected: { label: "Declined or revoked", tone: "neutral" },
};
const PAGE = 20;
const errText = (err: unknown) => (err instanceof PortalError ? err.message : "Something went wrong.");

/**
 * What an administrator sees: who has asked for, or holds, access to a pharmacy's portal, and the decision to give or take it away. An administrator belongs to
 * no pharmacy and sees none of its stock, history, alerts or plans. The server enforces that (403); this page only offers what the role is for.
 */
export function AdminPanel({ session, onSignedOut }: { session: PortalSession; onSignedOut: () => void }) {
  const [filter, setFilter] = useState<AccountStatus | "all">("pending");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const accounts = useAsync((signal) => listStaffRequests({ status: filter, limit: PAGE, offset }, { signal }), [filter, offset, version]);
  if (accounts.status === "error" && accounts.error instanceof PortalError && accounts.error.kind === "unauthenticated") queueMicrotask(onSignedOut);

  async function leave() {
    await signOut().catch(() => undefined);
    onSignedOut();
  }

  return (
    <div className="portal-view space-y-6">
      <Card variant="solid" className="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-7">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-brand"><ShieldIcon size={16} /> Administrator</p>
          <h1 className="editorial-title mt-1 text-3xl leading-tight sm:text-4xl">Pharmacy access</h1>
          <p className="text-sm text-muted">Signed in as {session.email}</p>
        </div>
        <Button variant="secondary" onClick={leave}>Sign out</Button>
      </Card>

      <section aria-label="Staff access requests" className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Staff access</h2>
          <p className="text-sm text-muted">
            Approve who may manage each pharmacy&apos;s stock. Approving gives a person that one pharmacy only. Administrators have no pharmacy of their own and cannot see any pharmacy&apos;s
            stock, history, alerts or restock plans.
          </p>
        </div>
        {notice && <Alert tone="ok">{notice}</Alert>}
        <Segmented<AccountStatus | "all"> label="Show accounts" value={filter} onChange={(f) => (setFilter(f), setOffset(0))} options={FILTERS} />

        {accounts.status === "error" && <Alert tone="bad" title="We couldn't load the accounts" action={<Button size="sm" onClick={accounts.reload}>Try again</Button>}>{errText(accounts.error)}</Alert>}
        {!accounts.data && accounts.status !== "error" && (
          <div aria-label="Loading accounts" className="space-y-2">
            <p role="status" className="sr-only">Loading staff accounts</p>
            {[0, 1].map((i) => <Skeleton key={i} className="h-20" />)}
          </div>
        )}
        {accounts.data && accounts.data.items.length === 0 && (
          <EmptyState icon={<ListIcon />} title={filter === "pending" ? "No requests are waiting" : "No accounts here"} level={3}>
            {filter === "pending" ? "When someone asks for access to a pharmacy, it appears here." : "Nothing matches this filter."}
          </EmptyState>
        )}
        {accounts.data && accounts.data.items.length > 0 && (
          <>
            <ul className="space-y-2" aria-label="Accounts">
              {accounts.data.items.map((a) => (
                <AccountRow key={a.id} account={a} onDecided={(message) => (setNotice(message), setVersion((v) => v + 1))} onSignedOut={onSignedOut} />
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted" aria-live="polite">Showing {accounts.data.offset + 1}–{accounts.data.offset + accounts.data.items.length} of {accounts.data.total}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={accounts.data.offset === 0 || accounts.status === "loading"} onClick={() => setOffset(Math.max(0, accounts.data!.offset - PAGE))}>Earlier</Button>
                <Button size="sm" variant="secondary" disabled={!accounts.data.hasMore || accounts.status === "loading"} onClick={() => setOffset(accounts.data!.offset + PAGE)}>Later</Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function AccountRow({ account, onDecided, onSignedOut }: { account: StaffAccount; onDecided: (message: string) => void; onSignedOut: () => void }) {
  const [confirming, setConfirming] = useState<"revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const isAdmin = account.role === "ADMIN";
  const { label, tone } = STATUS[account.status];

  async function decide(decision: "approve" | "reject" | "revoke", message: string) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await decideStaffRequest(account.id, decision);
      onDecided(message);
    } catch (err) {
      if (err instanceof PortalError && err.kind === "unauthenticated") onSignedOut();
      else setError(errText(err));
    } finally {
      working.current = false;
      setBusy(false);
      setConfirming(null);
    }
  }

  return (
    <li>
      <Card variant="solid" className="space-y-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-semibold leading-snug">{account.email}</p>
            <p className="text-sm text-muted">
              {isAdmin ? "Administrator (no pharmacy)" : <>Pharmacy <span className="ui-mono">{account.pharmacyCode}</span></>} · asked <time dateTime={account.requestedAt}>{formatRelativeTime(account.requestedAt)}</time>
            </p>
          </div>
          <Badge tone={tone}><span className="sr-only">Account status: </span>{label}</Badge>
        </div>
        {error && <Alert tone="bad" title="That didn't go through">{error}</Alert>}
        {account.status === "pending" && !isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => decide("approve", `Approved ${account.email} for pharmacy ${account.pharmacyCode}.`)} aria-label={`Approve ${account.email}`}>Approve</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => decide("reject", `Declined ${account.email}.`)} aria-label={`Decline ${account.email}`}>Decline</Button>
          </div>
        )}
        {account.status === "active" && !isAdmin && (
          confirming === "revoke" ? (
            <div className="flex flex-wrap items-center gap-3 rounded-[var(--card-radius-sm)] bg-canvas p-3 text-sm">
              <p className="flex-1">Take away this person&apos;s access? They are signed out at their next request and can ask again.</p>
              <Button size="sm" variant="danger" loading={busy} onClick={() => decide("revoke", `Access removed for ${account.email}.`)}>Yes, remove access</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Keep it</Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming("revoke")} aria-label={`Remove access for ${account.email}`}>Remove access</Button>
          )
        )}
      </Card>
    </li>
  );
}
