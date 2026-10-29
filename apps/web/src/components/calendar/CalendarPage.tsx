"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarApiError,
  deleteCalendarEntry,
  listCalendarEntries,
  updateCalendarEntry,
  type CalendarEntry,
} from "../../lib/calendar-api";
import { addMonths, dayLabel, gridRange, monthLabel, parseIso, shortDayLabel, todayIso } from "../../lib/calendar-dates";
import { useAsync } from "../../lib/use-async";
import { ArrowLeftIcon, ArrowRightIcon, PlusIcon } from "../ui/icons";
import { Alert, Button, Skeleton } from "../ui/primitives";
import s from "./calendar.module.css";
import { DayPanel } from "./DayPanel";
import { EntryForm } from "./EntryForm";
import { Modal } from "./Modal";
import { MonthGrid } from "./MonthGrid";

export { medicineLabel } from "./EntryForm";

/**
 * The person's own medicine calendar, filling the window: one thin header, a toolbar, and the month. A day opens in a dialog. Everything shown was loaded
 * from, and saved to, the server for the signed-in patient; nothing is kept in the browser. (The page itself is only reachable with
 * a session, and the server checks that again on every call.)
 */
export function CalendarPage() {
  const [today, setToday] = useState<string | null>(null);
  const [view, setView] = useState<{ year: number; month: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  // What is open over the month: a day's entries, or the add/edit form (`from`: where Cancel goes back to).
  const [dialog, setDialog] = useState<{ kind: "day" } | { kind: "form"; entry: CalendarEntry | null; date: string; from: "day" | "month" } | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);

  // "Today" is the person's own date, known only in the browser.
  useEffect(() => {
    const t = todayIso();
    const { year, month } = parseIso(t);
    setToday(t);
    setView({ year, month });
    setSelected(t);
  }, []);

  const range = view ? gridRange(view.year, view.month) : null;
  const data = useAsync((signal) => listCalendarEntries(range!.from, range!.to, signal), [range?.from, range?.to, version], range !== null && !sessionEnded);
  const unauthorized = sessionEnded || (data.status === "error" && data.error instanceof CalendarApiError && data.error.kind === "unauthorized");

  const entries = useMemo(() => (unauthorized ? [] : data.data?.entries ?? []), [unauthorized, data.data]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    for (const e of entries) map.set(e.date, [...(map.get(e.date) ?? []), e]);
    return map;
  }, [entries]);

  const refresh = () => setVersion((v) => v + 1);
  const endSession = useCallback(() => {
    setSessionEnded(true);
    setDialog(null);
    setNotice(null);
  }, []);

  if (unauthorized) {
    return (
      <div className={`${s.frame} items-center justify-center p-6`}>
        <div className="w-full max-w-md space-y-4">
          <Alert tone="warn" title="Your session has ended">
            Your calendar is private, so it is no longer shown. Sign in again to see it.
          </Alert>
          <Link href={`/signin?callbackUrl=${encodeURIComponent("/calendar")}`} className="inline-flex min-h-11 items-center rounded-xl bg-brand px-4 font-semibold text-on-brand hover:bg-brand-strong">Sign in</Link>
        </div>
      </div>
    );
  }

  const ready = view && selected && today ? { view, selected, today } : null;
  const loadingFirst = data.status === "loading" && data.data === null;
  const dayEntries = (selected && byDay.get(selected)) || [];

  /** Choose a day, and the month on show follows it. */
  const select = (iso: string) => {
    setSelected(iso);
    setNotice(null);
    const { year, month } = parseIso(iso);
    if (!view || view.year !== year || view.month !== month) setView({ year, month });
  };
  const openDay = (iso: string) => {
    select(iso);
    setRowError(null);
    setDialog({ kind: "day" });
  };
  const goToToday = () => {
    if (!today) return;
    const { year, month } = parseIso(today);
    setView({ year, month });
    setSelected(today);
    setNotice(null);
  };
  const step = (delta: number) => view && setView(addMonths(view.year, view.month, delta));
  const openForm = (entry: CalendarEntry | null, date: string, from: "day" | "month") => {
    setNotice(null);
    setRowError(null);
    setDialog({ kind: "form", entry, date, from });
  };
  const closeForm = () => setDialog((d) => (d?.kind === "form" && d.from === "day" ? { kind: "day" } : null));

  const saved = (entry: CalendarEntry, message: string) => {
    // Only now, with the server's confirmation, is it shown as done; the view follows the entry's own day.
    const { year, month } = parseIso(entry.date);
    setView({ year, month });
    setSelected(entry.date);
    setDialog(null);
    setNotice(`${message} (${shortDayLabel(entry.date)}).`);
    refresh();
  };

  async function act(entry: CalendarEntry, run: () => Promise<void>) {
    setBusyId(entry.id);
    setRowError(null);
    setNotice(null);
    try {
      await run();
    } catch (err) {
      if (err instanceof CalendarApiError && err.kind === "unauthorized") return endSession();
      if (err instanceof CalendarApiError && err.kind === "notFound") refresh(); // someone (another tab) removed it: show the truth
      setRowError({ id: entry.id, message: err instanceof CalendarApiError ? err.message : "Something went wrong. Please try again." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={s.frame}>
      <main id="cal-main" className={s.main}>
        <div className={s.toolbar}>
          <h1 className="editorial-title mr-1 text-2xl leading-tight sm:text-3xl">Medicine Calendar</h1>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" aria-label="Previous month" disabled={!view} onClick={() => step(-1)}><ArrowLeftIcon size={16} /></Button>
            <h2 className="min-w-[8.5rem] text-center text-lg font-semibold sm:min-w-[10rem] sm:text-xl" aria-live="polite">{view ? monthLabel(view.year, view.month) : "\u00a0"}</h2>
            <Button size="sm" variant="secondary" aria-label="Next month" disabled={!view} onClick={() => step(1)}><ArrowRightIcon size={16} /></Button>
          </div>
          <Button size="sm" variant="secondary" disabled={!today} onClick={goToToday}>Today</Button>
          <Button size="sm" variant="primary" className="ml-auto" disabled={!ready} onClick={() => ready && openForm(null, ready.selected, "month")}><PlusIcon size={15} />Add medicine</Button>
        </div>

        <div role="status" aria-live="polite" className="px-3 sm:px-6">
          {notice && <Alert tone="ok" className="mb-2">{notice}</Alert>}
        </div>
        {(data.status === "error" || (data.status === "success" && data.data.truncated)) && (
          <div className="px-3 pb-2 sm:px-6">
            {data.status === "error" ? (
              <Alert tone="bad" title="Your calendar could not be loaded" action={<Button size="sm" variant="secondary" onClick={refresh}>Try again</Button>}>
                {data.error instanceof CalendarApiError ? data.error.message : "Something went wrong. Please try again."}
              </Alert>
            ) : (
              <Alert tone="warn">This month has more entries than can be shown at once. Choose a day to see its entries.</Alert>
            )}
          </div>
        )}

        <div className={s.workspace}>
          {ready ? (
            <MonthGrid year={ready.view.year} month={ready.view.month} today={ready.today} selected={ready.selected} byDay={byDay} loading={data.status === "loading"} onSelect={select} onOpenDay={openDay} onOpenEntry={(entry) => { select(entry.date); openForm(entry, entry.date, "month"); }} />
          ) : (
            <Skeleton className="min-h-96 w-full flex-1" />
          )}
          <p className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-[0.7rem] leading-snug text-muted">
            <span>Your own notes. MedLink does not place orders, confirm purchases or check that a medicine is available, and it sends no reminders by email or message.</span>
            <span aria-hidden={data.status !== "loading"}>{data.status === "loading" ? "Loading your entries…" : ""}</span>
          </p>
        </div>
      </main>

      {ready && dialog?.kind === "day" && (
        <Modal key="day" title={dayLabel(ready.selected)} onClose={() => setDialog(null)}>
          <DayPanel
            today={ready.today}
            selected={ready.selected}
            entries={dayEntries}
            loading={loadingFirst}
            busyId={busyId}
            rowError={rowError}
            onAdd={() => openForm(null, ready.selected, "day")}
            onEdit={(entry) => openForm(entry, entry.date, "day")}
            onToggleDone={(entry) =>
              act(entry, async () => {
                const next = await updateCalendarEntry(entry.id, { status: entry.status === "DONE" ? "OPEN" : "DONE" });
                setNotice(next.status === "DONE" ? "Marked as done." : "Reopened.");
                refresh();
              })
            }
            onDelete={(entry) =>
              act(entry, async () => {
                await deleteCalendarEntry(entry.id);
                setNotice("Entry deleted.");
                refresh();
              })
            }
          />
        </Modal>
      )}

      {dialog?.kind === "form" && (
        <Modal key="form" title={dialog.entry ? "Edit entry" : "Add medicine"} locked={formBusy} onClose={closeForm}>
          <EntryForm
            key={dialog.entry?.id ?? "new"}
            entry={dialog.entry}
            defaultDate={dialog.date}
            onSaved={(entry) => saved(entry, dialog.entry ? "Changes saved" : "Added to your calendar")}
            onCancel={closeForm}
            onUnauthorized={endSession}
            onBusy={setFormBusy}
          />
        </Modal>
      )}
    </div>
  );
}
