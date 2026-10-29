"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { CalendarEntry } from "../../lib/calendar-api";
import { addDays, dayLabel, monthGrid, monthLabel, WEEKDAYS, type GridDay } from "../../lib/calendar-dates";
import s from "./calendar.module.css";
import { CheckIcon, entryLabel, shadeOf, TypeIcon } from "./entry-visuals";

const CHIP_HEIGHT = 22; // px, a chip plus its gap
const DAY_HEAD = 34; // px, the day number and the cell's padding

/**
 * How many entry lines a day cell can hold. Where the page is exactly one screen high the six week rows share the height, so this is
 * measured; where the page scrolls instead, cells grow with their content and three lines are shown.
 */
function useCapacity(ref: RefObject<HTMLElement | null>): number {
  const [capacity, setCapacity] = useState(3);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined" || typeof matchMedia === "undefined") return;
    const fixed = matchMedia("(min-width: 48rem) and (min-height: 34rem)");
    const measure = () => setCapacity(fixed.matches ? Math.max(0, Math.min(6, Math.floor((el.clientHeight / 6 - DAY_HEAD) / CHIP_HEIGHT))) : 3);
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    fixed.addEventListener?.("change", measure);
    measure();
    return () => {
      observer.disconnect();
      fixed.removeEventListener?.("change", measure);
    };
  }, [ref]);
  return capacity;
}

const KEY_STEP: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

interface GridProps {
  year: number;
  month: number;
  today: string;
  selected: string;
  byDay: Map<string, CalendarEntry[]>;
  loading: boolean;
  /** Choose a day without opening it (the arrow keys). */
  onSelect: (iso: string) => void;
  /** Open a day: a click or Enter on its date, or its "more" line. */
  onOpenDay: (iso: string) => void;
  onOpenEntry: (entry: CalendarEntry) => void;
}

/**
 * The month: six rows of seven days that share whatever height there is. Each day is a cell with a date button (the keyboard's way in:
 * the arrow keys move between days) and the day's entries as chips. Which days have entries, and how many, comes from `byDay`, which is
 * built from what the server returned.
 */
export function MonthGrid({ year, month, today, selected, byDay, loading, onSelect, onOpenDay, onOpenEntry }: GridProps) {
  const cells = monthGrid(year, month);
  const weeks = Array.from({ length: 6 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const weeksRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const capacity = useCapacity(weeksRef);
  const tabIso = cells.some((c) => c.iso === selected) ? selected : cells.find((c) => c.inMonth)!.iso;

  useEffect(() => {
    if (!focusAfter.current) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-iso="${focusAfter.current}"]`)?.focus();
    focusAfter.current = null;
  });

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, iso: string) => {
    const step = KEY_STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = addDays(iso, step);
    focusAfter.current = next;
    onSelect(next);
  };

  const cell = (c: GridDay) => {
    const entries = byDay.get(c.iso) ?? [];
    const n = entries.length;
    const isSelected = c.iso === selected;
    const isToday = c.iso === today;
    const overflow = n > capacity;
    const shown = overflow ? entries.slice(0, Math.max(0, capacity - 1)) : entries;
    const hidden = n - shown.length;
    return (
      <div
        key={c.iso}
        role="gridcell"
        aria-selected={isSelected}
        onClick={() => onOpenDay(c.iso)}
        className={`${s.cell} ${c.inMonth ? "" : s.outside} ${isSelected ? s.selected : ""}`}
      >
        <div className="flex items-center justify-between gap-1">
          <button
            type="button"
            data-iso={c.iso}
            tabIndex={c.iso === tabIso ? 0 : -1}
            aria-current={isToday ? "date" : undefined}
            aria-label={`${dayLabel(c.iso)}, ${n === 0 ? "no entries" : n === 1 ? "1 entry" : `${n} entries`}`}
            onClick={(e) => {
              e.stopPropagation();
              onOpenDay(c.iso);
            }}
            onKeyDown={(e) => onKeyDown(e, c.iso)}
            className={`${s.dayNumber} ${isToday ? s.today : ""}`}
          >
            {c.day}
          </button>
        </div>
        {n > 0 && <span aria-hidden="true" className={s.count}>{n}</span>}
        {n > 0 && (
          <div className={s.chips}>
            {shown.map((entry) => (
              <button
                key={entry.id}
                type="button"
                tabIndex={isSelected ? 0 : -1}
                aria-label={`${entryLabel(entry)}. Open to edit`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEntry(entry);
                }}
                title={entryLabel(entry)}
                className={`${s.chip} ${s[`shade${shadeOf(entry.id)}`]} ${entry.status === "DONE" ? s.done : ""}`}
              >
                {entry.status === "DONE" ? <CheckIcon size={12} /> : <TypeIcon type={entry.type} />}
                <span className="truncate">{entry.medicineName}</span>
              </button>
            ))}
            {hidden > 0 && (
              <button
                type="button"
                tabIndex={isSelected ? 0 : -1}
                aria-label={`${hidden} more ${hidden === 1 ? "entry" : "entries"} on ${dayLabel(c.iso)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenDay(c.iso);
                }}
                className={s.more}
              >
                {shown.length === 0 ? `${hidden} ${hidden === 1 ? "entry" : "entries"}` : `+${hidden} more`}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={gridRef} role="grid" aria-label={`${monthLabel(year, month)}, choose a day`} aria-busy={loading} className={s.grid}>
      <div role="row" className={s.weekdays}>
        {WEEKDAYS.map((d) => (
          <div key={d} role="columnheader" className="ui-mono py-2 text-center text-[0.68rem] font-medium uppercase tracking-[0.1em] text-muted">{d}</div>
        ))}
      </div>
      <div ref={weeksRef} className={s.weeks}>
        {weeks.map((week) => (
          <div key={week[0]!.iso} role="row" className={s.week}>
            {week.map(cell)}
          </div>
        ))}
      </div>
    </div>
  );
}
