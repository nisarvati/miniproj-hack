/**
 * Calendar-day arithmetic for the medicine calendar. A day is always the text "YYYY-MM-DD" in the person's own calendar, never
 * an instant, so nothing here depends on the browser's or the server's timezone: all arithmetic is done in UTC on plain dates,
 * and the only thing read from the local clock is which day "today" is.
 */

const pad = (n: number) => String(n).padStart(2, "0");
export const toIso = (year: number, month: number, day: number) => `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;

/** Today's date on the person's own clock. */
export const todayIso = (now: Date = new Date()) => toIso(now.getFullYear(), now.getMonth() + 1, now.getDate());

export function parseIso(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y!, month: m!, day: d! };
}

export interface GridDay {
  iso: string;
  day: number;
  inMonth: boolean;
}

/** Six weeks starting on Sunday, covering `month` (1-12): what the month view shows, so adjacent days are real days too. */
export function monthGrid(year: number, month: number): GridDay[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = Date.UTC(year, month - 1, 1 - first.getUTCDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start + i * 86_400_000);
    return { iso: toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), day: d.getUTCDate(), inMonth: d.getUTCMonth() === month - 1 };
  });
}

/** The first and last day of the month view, which is the range of entries to ask the server for. */
export function gridRange(year: number, month: number): { from: string; to: string } {
  const grid = monthGrid(year, month);
  return { from: grid[0]!.iso, to: grid[41]!.iso };
}

/** The day `delta` days after (or before) `iso`, as plain calendar arithmetic. */
export function addDays(iso: string, delta: number): string {
  const { year, month, day } = parseIso(iso);
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export const monthLabel = (year: number, month: number) => new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
export const dayLabel = (iso: string) => {
  const { year, month, day } = parseIso(iso);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};
export const shortDayLabel = (iso: string) => {
  const { year, month, day } = parseIso(iso);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
