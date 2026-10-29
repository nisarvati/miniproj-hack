"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MedicineRef } from "../../lib/api";
import { CalendarApiError, createCalendarEntry, ENTRY_TYPE_INFO, ENTRY_TYPE_ORDER, type EntryType } from "../../lib/calendar-api";
import { shortDayLabel, todayIso } from "../../lib/calendar-dates";
import { useAuth } from "../providers/auth";
import { CalendarIcon } from "../ui/icons";
import { Alert, Button, Input, Select } from "../ui/primitives";

/**
 * "Add to calendar" on a search result: the person's own note about this catalogue medicine, saved through the same private API as
 * the calendar page. It passes the medicine's catalogue id (the server checks it and takes the name from the catalogue). Signed out,
 * it offers sign-in and returns here; with sign-in not set up, it is not shown at all.
 */
export function AddToCalendar({ medicine }: { medicine: Pick<MedicineRef, "id" | "brandName" | "dosage" | "form"> }) {
  const { status, configured } = useAuth();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<EntryType>("WANT_TO_GET");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOn, setSavedOn] = useState<string | null>(null);
  const [back, setBack] = useState("/search");
  const busy = useRef(false);

  useEffect(() => setBack(`${window.location.pathname}${window.location.search}`), []);

  if (status === "loading" || !configured) return null;
  if (status !== "authenticated") {
    return (
      <Link href={`/signin?callbackUrl=${encodeURIComponent(back)}`} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted underline underline-offset-2 hover:text-brand">
        <CalendarIcon size={15} />Sign in to add to your calendar
      </Link>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setError("Choose a date.");
    busy.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const entry = await createCalendarEntry({ medicineId: medicine.id, type, date, notes: notes.trim() || null });
      setSavedOn(entry.date); // only now that the server has confirmed it
      setOpen(false);
      setNotes("");
    } catch (err) {
      setError(err instanceof CalendarApiError ? (err.kind === "unauthorized" ? "Your session has ended. Please sign in again." : err.message) : "Something went wrong. Please try again.");
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="text-sm">
      {savedOn && (
        <p role="status" className="mb-2 text-ok">
          Added to your calendar for {shortDayLabel(savedOn)}. <Link href="/calendar" className="font-semibold underline underline-offset-2">View calendar</Link>
        </p>
      )}
      {!open ? (
        <Button size="sm" variant="secondary" aria-expanded={false} onClick={() => { setDate((d) => d || todayIso()); setSavedOn(null); setOpen(true); }}>
          <CalendarIcon size={14} />Add to calendar
        </Button>
      ) : (
        <form onSubmit={submit} noValidate aria-label={`Add ${medicine.brandName} ${medicine.dosage} to your calendar`} className="mx-card mx-card--solid space-y-3 p-3">
          <p className="font-semibold">{medicine.brandName} {medicine.dosage} {medicine.form}</p>
          {error && <Alert tone="bad">{error}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="font-medium">What is it?</span>
              <Select value={type} onChange={(e) => setType(e.target.value as EntryType)} className="mt-1">
                {ENTRY_TYPE_ORDER.map((t) => <option key={t} value={t}>{ENTRY_TYPE_INFO[t].label}</option>)}
              </Select>
            </label>
            <label className="block">
              <span className="font-medium">Date</span>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} min="2000-01-01" max="2100-12-31" className="mt-1" />
            </label>
          </div>
          <label className="block">
            <span className="font-medium">Notes <span className="font-normal text-muted">(optional)</span></span>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className="mt-1" />
          </label>
          <p className="text-xs text-muted">{ENTRY_TYPE_INFO[type].hint}</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={submitting}>{submitting ? "Saving…" : "Save to calendar"}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}
