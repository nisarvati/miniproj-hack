"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { findMedicines, type MedicineRef } from "../../lib/api";
import { CalendarApiError, createCalendarEntry, ENTRY_TYPE_INFO, ENTRY_TYPE_ORDER, updateCalendarEntry, type CalendarEntry, type EntryType } from "../../lib/calendar-api";
import { useDebounced } from "../../lib/use-debounced";
import { Alert, Button, Input, Select } from "../ui/primitives";

const FIELD_CLASS = "w-full rounded-xl border border-control-border bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-placeholder transition-colors hover:border-muted/60 focus:border-focus";

export const medicineLabel = (m: Pick<MedicineRef, "brandName" | "dosage" | "form">) => `${m.brandName} ${m.dosage} ${m.form}`;

interface FormProps {
  /** The entry being edited, or null for a new one. */
  entry: CalendarEntry | null;
  defaultDate: string;
  onSaved: (saved: CalendarEntry) => void;
  onCancel: () => void;
  onUnauthorized: () => void;
  /** Told whenever a save starts or ends, so the dialog around the form does not close in the middle of one. */
  onBusy?: (busy: boolean) => void;
}

/**
 * Add or edit one entry. Nothing is treated as saved until the server has said so: on a failure the form stays as the person left it
 * and says what went wrong. The medicine can be picked from the catalogue (the server then takes the name from the catalogue) or typed.
 */
export function EntryForm({ entry, defaultDate, onSaved, onCancel, onUnauthorized, onBusy }: FormProps) {
  const [name, setName] = useState(entry?.medicineName ?? "");
  const [medicineId, setMedicineId] = useState<number | null>(entry?.medicineId ?? null);
  const [pickedLabel, setPickedLabel] = useState<string | null>(entry?.medicineId ? entry.medicineName : null);
  const [type, setType] = useState<EntryType>(entry?.type ?? "WANT_TO_GET");
  const [date, setDate] = useState(entry?.date ?? defaultDate);
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [suggestions, setSuggestions] = useState<MedicineRef[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const busy = useRef(false);
  useEffect(() => onBusy?.(submitting), [submitting, onBusy]);

  const query = useDebounced(name.trim(), 250);
  useEffect(() => {
    if (query.length < 2 || medicineId !== null) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    findMedicines(query, { signal: controller.signal }).then(
      (found) => !controller.signal.aborted && setSuggestions(found),
      () => !controller.signal.aborted && setSuggestions([]), // suggestions are a convenience: typing a name still works
    );
    return () => controller.abort();
  }, [query, medicineId]);

  const onName = (value: string) => {
    setName(value);
    if (value !== pickedLabel) setMedicineId(null); // an edited name is no longer that catalogue medicine
  };
  const pick = (m: MedicineRef) => {
    const label = medicineLabel(m);
    setName(label);
    setPickedLabel(label);
    setMedicineId(m.id);
    setSuggestions([]);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return; // one request at a time, however fast it is pressed
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.medicineName = "Enter or choose a medicine.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.date = "Choose a date.";
    setFieldErrors(problems);
    if (Object.keys(problems).length) return;

    busy.current = true;
    setSubmitting(true);
    setError(null);
    const medicine = medicineId !== null ? { medicineId } : { medicineName: name.trim() };
    try {
      const saved = entry
        ? await updateCalendarEntry(entry.id, { ...(medicineId !== null ? medicine : { medicineId: null, medicineName: name.trim() }), type, date, notes: notes.trim() || null })
        : await createCalendarEntry({ ...medicine, type, date, notes: notes.trim() || null });
      onSaved(saved);
    } catch (err) {
      if (err instanceof CalendarApiError && err.kind === "unauthorized") return onUnauthorized();
      if (err instanceof CalendarApiError && err.fields.length) setFieldErrors(Object.fromEntries(err.fields.map((f) => [f.field, f.message])));
      setError(err instanceof CalendarApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-label={entry ? "Edit entry" : "Add entry"} className="space-y-4">
      {error && (
        <Alert tone="bad" title="That was not saved">
          {error} Your entry is still here: you can try again.
        </Alert>
      )}
      <div>
        <label htmlFor="cal-medicine" className="block text-sm font-semibold">Medicine</label>
        <Input id="cal-medicine" value={name} onChange={(e) => onName(e.target.value)} maxLength={200} autoComplete="off" placeholder="Start typing a medicine name" aria-invalid={Boolean(fieldErrors.medicineName || fieldErrors.medicineId)} aria-describedby="cal-medicine-help" className="mt-1" />
        <p id="cal-medicine-help" className="mt-1 text-xs text-muted">
          {medicineId !== null ? "Matched to the MedLink catalogue." : "Choose a match to link the catalogue entry, or keep your own words."}
        </p>
        {(fieldErrors.medicineName || fieldErrors.medicineId) && <p className="mt-1 text-sm text-bad">{fieldErrors.medicineName ?? fieldErrors.medicineId}</p>}
        {suggestions.length > 0 && (
          <ul aria-label="Matching medicines" className="mx-card mx-card--solid mt-1 divide-y divide-line">
            {suggestions.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => pick(m)} className="flex min-h-11 w-full flex-col items-start px-3.5 py-2 text-left text-sm hover:bg-control-hover">
                  <span className="font-medium">{m.brandName} {m.dosage}</span>
                  <span className="text-xs text-muted">{m.genericName} · {m.form}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cal-type" className="block text-sm font-semibold">What is it?</label>
          <Select id="cal-type" value={type} onChange={(e) => setType(e.target.value as EntryType)} className="mt-1">
            {ENTRY_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>{ENTRY_TYPE_INFO[t].label}</option>
            ))}
          </Select>
        </div>
        <div>
          <label htmlFor="cal-date" className="block text-sm font-semibold">Date</label>
          <Input id="cal-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} min="2000-01-01" max="2100-12-31" aria-invalid={Boolean(fieldErrors.date)} className="mt-1" />
          {fieldErrors.date && <p className="mt-1 text-sm text-bad">{fieldErrors.date}</p>}
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted">{ENTRY_TYPE_INFO[type].hint}</p>
      <div>
        <label htmlFor="cal-notes" className="block text-sm font-semibold">Notes <span className="font-normal text-muted">(optional)</span></label>
        <textarea id="cal-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} rows={3} className={`${FIELD_CLASS} mt-1`} />
        {fieldErrors.notes && <p className="mt-1 text-sm text-bad">{fieldErrors.notes}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={submitting}>{submitting ? "Saving…" : entry ? "Save changes" : "Add to calendar"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>
      </div>
    </form>
  );
}
