"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, cancelSubscription, listSubscriptions, type RestockSubscription } from "../../lib/api";
import { formatRelativeTime, pluralise, withoutStockCount } from "../../lib/format";
import { looksLikeEmail } from "../../lib/restock";
import { useAsync } from "../../lib/use-async";
import { useAccount } from "../providers/account";
import { BellIcon, CheckIcon, MailIcon, SearchIcon, TrashIcon } from "../ui/icons";
import { Alert, Badge, Button, Card, EmptyState, Input, LinkButton, Segmented, Skeleton } from "../ui/primitives";

type Tab = "feed" | "waiting";

export function NotificationsPage() {
  const { email } = useAccount();
  return (
    <div className="notifications-view mx-auto max-w-3xl space-y-6">
      <header className="border-b border-line pb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">A little peace of mind</p>
        <h1 className="editorial-title mt-2 text-4xl leading-tight sm:text-5xl">Your restock notes</h1>
        <p className="mt-2 text-muted">Alerts from the local pharmacies you&apos;re keeping an eye on.</p>
      </header>
      {email ? <Inbox email={email} /> : <EmailGate />}
    </div>
  );
}

function EmailGate() {
  const { setEmail } = useAccount();
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!looksLikeEmail(value)) {
      setProblem("Enter a valid email address, e.g. name@example.com.");
      return;
    }
    setEmail(value);
  }

  return (
    <Card variant="quiet" className="p-6">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand-ink">
        <MailIcon size={24} />
      </span>
      <h2 className="mt-4 text-lg font-semibold">See your notifications</h2>
      <p className="mt-1 text-sm text-muted">There&apos;s no sign-in yet: the email you used to ask for a restock alert is how MedLink recognises you on this device.</p>
      <form onSubmit={submit} noValidate className="mt-5">
        <label htmlFor={id} className="mb-1.5 block text-sm font-semibold">
          Your email
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id={id} type="email" autoComplete="email" placeholder="you@example.com" value={value} onChange={(e) => (setValue(e.target.value), setProblem(null))} aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-hint ${id}-problem` : `${id}-hint`} />
          <Button type="submit" variant="primary" className="h-11">
            Show my notifications
          </Button>
        </div>
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted">Enter the same email you used when asking for an alert.</p>
        {problem && (
          <p id={`${id}-problem`} role="alert" className="mt-2 text-sm text-bad">
            {problem}
          </p>
        )}
      </form>
      <p className="mt-5 text-sm text-muted">
        Haven&apos;t asked for an alert yet? Search for a medicine that&apos;s out of stock and choose <strong className="text-ink">Notify me</strong>.
      </p>
    </Card>
  );
}

function Inbox({ email }: { email: string }) {
  const { setEmail, notifications, notificationsUnavailable, lastSeen, markAllRead, markRead, refresh } = useAccount();
  const [tab, setTab] = useState<Tab>("feed");
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);

  const subs = useAsync((signal) => listSubscriptions(email, { signal }), [email]);
  // A fulfilled subscription flips to "notified" on the server when its notification is created: refetch then.
  const count = notifications?.length ?? 0;
  useEffect(() => {
    if (count > 0) subs.reload();
    // (reload is stable: only a change in the count should trigger this)
  }, [count]);

  // What was unread when this page opened stays highlighted ("New"); a moment later it counts as read, so the badge
  // clears. The "unread when opened" value is latched during the first render that has data (a ref, not state), so
  // "New" shows together with the notification instead of one render later.
  const previousNotificationIds = useRef<Set<number> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (notifications === null) return;
    const ids = new Set(notifications.map((n) => n.id));
    if (previousNotificationIds.current) {
      const added = notifications.filter((n) => !previousNotificationIds.current!.has(n.id));
      if (added.length) setAnnouncement(`${added.length} new ${added.length === 1 ? "notification" : "notifications"}.`);
    }
    previousNotificationIds.current = ids;
  }, [notifications]);
  const unreadCount = notifications?.filter((n) => n.id > lastSeen).length ?? 0;

  async function cancel(s: RestockSubscription) {
    setCancelling(s.id);
    setCancelError(null);
    try {
      await cancelSubscription(s.id, email);
    } catch (err) {
      // "already fulfilled or cancelled" just means the list was out of date: refresh it below.
      if (!(err instanceof ApiError && err.kind === "notFound")) setCancelError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setCancelling(null);
      subs.reload();
    }
  }

  const waiting = (subs.data ?? []).filter((s) => s.status === "ACTIVE");
  const earlier = (subs.data ?? []).filter((s) => s.status !== "ACTIVE");

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm text-muted">
          Showing alerts for <strong className="text-ink">{email}</strong>
        </p>
        <Button size="sm" variant="ghost" onClick={() => setEmail(null)}>
          Not you? Change email
        </Button>
      </div>

      <Segmented
        label="Notifications or waiting"
        value={tab}
        onChange={setTab}
        options={[
          { value: "feed", label: `Notifications${notifications ? ` (${notifications.length})` : ""}`, icon: <BellIcon size={16} /> },
          { value: "waiting", label: `Waiting${subs.data ? ` (${waiting.length})` : ""}`, icon: <CheckIcon size={16} /> },
        ]}
      />

      {tab === "feed" && (
        <section aria-label="Notifications" className="space-y-3">
          <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
          {notificationsUnavailable && <Alert tone="warn" title="We couldn't refresh your notifications" action={<Button size="sm" variant="secondary" onClick={() => void refresh()}>Try again</Button>}>Showing the last notifications we received. Check your connection and try again.</Alert>}
          {unreadCount > 0 && <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={markAllRead}>Mark all as read ({unreadCount})</Button></div>}
          {notifications === null && <><p role="status" className="sr-only">Loading notifications</p><Skeleton className="h-24" /></>}
          {notifications?.length === 0 && (
            <EmptyState icon={<BellIcon />} title="No notifications yet" action={<LinkButton href="/search" variant="primary"><SearchIcon size={16} /> Search for a medicine</LinkButton>}>
              When a pharmacy restocks a medicine you&apos;re waiting for, it appears here.
            </EmptyState>
          )}
          {notifications?.map((n) => {
            const isNew = n.id > lastSeen;
            return (
              <Card key={n.id} className={`overflow-hidden ${isNew ? "border-brand/60 shadow-pop" : ""}`}>
                <div className="flex items-start gap-3 p-4">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
                    <CheckIcon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{withoutStockCount(n.message)}</p>
                    <p className="mt-0.5 text-xs text-muted" title={new Date(n.createdAt).toLocaleString()}>
                      {formatRelativeTime(n.createdAt)} · simulated notification
                    </p>
                  </div>
              {isNew && <><Badge tone="brand">New</Badge><Button size="sm" variant="ghost" aria-label={`Mark ${withoutStockCount(n.message)} as read`} onClick={() => markRead(n.id)}>Mark read</Button></>}
                </div>
              </Card>
            );
          })}
          <p className="text-xs text-muted">Notifications are simulated for now: instead of being emailed, they appear here.</p>
        </section>
      )}

      {tab === "waiting" && (
        <section aria-label="Waiting for restock" className="space-y-3">
          {cancelError && <Alert tone="bad">{cancelError}</Alert>}
          {subs.status === "error" && !subs.data && (
            <Alert tone="bad" title="We couldn't load your list" action={<Button size="sm" onClick={subs.reload}>Try again</Button>}>
              {subs.error instanceof ApiError ? subs.error.message : "Something went wrong."}
            </Alert>
          )}
          {!subs.data && subs.status !== "error" && <><p role="status" className="sr-only">Loading waiting list</p><Skeleton className="h-20" /></>}

          {subs.data && waiting.length === 0 && (
            <EmptyState icon={<BellIcon />} title="You're not waiting for anything" action={<LinkButton href="/search" variant="primary">Search for a medicine</LinkButton>}>
              When a medicine is out of stock, choose “Notify me” and it will be listed here.
            </EmptyState>
          )}
          {waiting.length > 0 && <p className="text-sm text-muted">Waiting for {pluralise(waiting.length, "medicine")}</p>}
          {waiting.map((s) => (
            <Card key={s.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {s.medicine.brandName} {s.medicine.dosage}
                </p>
                <p className="text-xs text-muted">Waiting since {formatRelativeTime(s.createdAt)}</p>
              </div>
              <Badge tone="warn">Waiting</Badge>
              <Button size="sm" variant="danger" onClick={() => cancel(s)} loading={cancelling === s.id} aria-label={`Stop waiting for ${s.medicine.brandName} ${s.medicine.dosage}`}>
                <TrashIcon size={14} /> Cancel
              </Button>
            </Card>
          ))}

          {earlier.length > 0 && (
            <details className="mx-card mx-card--quiet mx-details p-4">
              <summary className="cursor-pointer text-sm font-semibold">Earlier ({earlier.length})</summary>
              <ul className="mt-3 divide-y divide-line">
                {earlier.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span>
                      {s.medicine.brandName} {s.medicine.dosage}
                    </span>
                    <span className="flex items-center gap-2 text-muted">
                      {s.status === "NOTIFIED" && s.notifiedAt ? `Notified ${formatRelativeTime(s.notifiedAt)}` : formatRelativeTime(s.createdAt)}
                      <Badge tone={s.status === "NOTIFIED" ? "ok" : "neutral"}>{s.status === "NOTIFIED" ? "Notified" : "Cancelled"}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </>
  );
}
