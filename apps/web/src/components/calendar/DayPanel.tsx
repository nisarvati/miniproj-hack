"use client";

import { useState } from "react";
import { ENTRY_TYPE_INFO, type CalendarEntry } from "../../lib/calendar-api";
import { CalendarIcon } from "../ui/icons";
import { Badge, Button, Skeleton } from "../ui/primitives";
import s from "./calendar.module.css";
import { CheckIcon, shadeOf, TypeIcon } from "./entry-visuals";

function EntryRow({ entry, busy, error, onEdit, onToggleDone, onDelete }: { entry: CalendarEntry; busy: boolean; error: string | null; onEdit: () => void; onToggleDone: () => void; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const done = entry.status === "DONE";
  return (
    <li className={`${s.row} ${s[`shade${shadeOf(entry.id)}`]}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral"><TypeIcon type={entry.type} size={13} />{ENTRY_TYPE_INFO[entry.type].label}</Badge>
        {done && <Badge tone="neutral"><CheckIcon size={13} />Done</Badge>}
      </div>
      <p className={`mt-2 break-words font-semibold leading-snug ${done ? "text-muted line-through" : ""}`}>{entry.medicineName}</p>
      {entry.notes && <p className="mt-1 whitespace-pre-line break-words text-sm text-muted">{entry.notes}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-bad">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {confirming ? (
          <>
            <span className="self-center text-sm">Delete this entry?</span>
            <Button size="sm" variant="danger" loading={busy} onClick={onDelete}>Yes, delete</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Keep it</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" loading={busy} onClick={onToggleDone} aria-label={`${done ? "Reopen" : "Mark done"}: ${entry.medicineName}`}>
              {done ? "Reopen" : "Mark done"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit} aria-label={`Edit: ${entry.medicineName}`}>Edit</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(true)} aria-label={`Delete: ${entry.medicineName}`}>Delete</Button>
          </>
        )}
      </div>
    </li>
  );
}

interface PanelProps {
  today: string;
  selected: string;
  entries: CalendarEntry[];
  /** True until the first answer for the visible range has arrived: entries are not yet known, so "nothing here" must not be claimed. */
  loading: boolean;
  busyId: string | null;
  rowError: { id: string; message: string } | null;
  onAdd: () => void;
  onEdit: (entry: CalendarEntry) => void;
  onToggleDone: (entry: CalendarEntry) => void;
  onDelete: (entry: CalendarEntry) => void;
}

/** The selected day, shown in a dialog: a count taken from the entries the server returned, those entries, and the way to add one. */
export function DayPanel({ today, selected, entries, loading, busyId, rowError, onAdd, onEdit, onToggleDone, onDelete }: PanelProps) {
  const done = entries.filter((e) => e.status === "DONE").length;
  const count = entries.length;
  const summary = loading ? "Loading…" : count === 0 ? "No medicines on this day" : `${count} ${count === 1 ? "medicine" : "medicines"} on this day${done > 0 ? ` · ${done} done` : ""}`;
  return (
    <div>
      <p className="text-sm text-muted" aria-live="polite">
        {selected === today && <span className="ui-mono mr-2 text-[0.68rem] font-medium uppercase tracking-[0.12em] text-brand">Today</span>}
        {summary}
      </p>
      <div className="mt-3">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : count === 0 ? (
          <div className="rounded-[var(--card-radius-sm)] border border-dashed border-line px-4 py-6 text-center">
            <span aria-hidden="true" className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-brand-soft text-brand-ink"><CalendarIcon size={18} /></span>
            <p className="mt-2 text-sm font-semibold">Nothing recorded for this day.</p>
          </div>
        ) : (
          <ul className="space-y-2.5" aria-label="Entries for this day">
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                error={rowError?.id === entry.id ? rowError.message : null}
                onEdit={() => onEdit(entry)}
                onToggleDone={() => onToggleDone(entry)}
                onDelete={() => onDelete(entry)}
              />
            ))}
          </ul>
        )}
      </div>
      <Button variant="primary" size="sm" className="mt-4 w-full" onClick={onAdd}>Add to this day</Button>
    </div>
  );
}
