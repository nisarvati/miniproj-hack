import type { CalendarEntry, EntryType } from "../../lib/calendar-api";
import { ENTRY_TYPE_INFO } from "../../lib/calendar-api";
import { BellIcon, CheckIcon, ClockIcon, ListIcon, StoreIcon } from "../ui/icons";

/**
 * How each kind of entry looks. Every entry is green: which green comes from its id (see `shadeOf`), never from its type or status.
 * The kind is told by its own icon and, wherever there is room, by its label in words, so colour carries no meaning.
 */
export const TYPE_ICON: Record<EntryType, typeof ListIcon> = { WANT_TO_GET: ListIcon, ORDERED: ClockIcon, PURCHASED: StoreIcon, REMINDER: BellIcon };

/** How many greens there are (the `.shade0` … `.shade5` classes in calendar.module.css). */
export const SHADES = 6;

/**
 * A stable shade for an entry: a hash of its persisted id, so it is the same on every render, in every month, on every reload and in
 * every view, and does not depend on the order entries arrive in. (FNV-1a, 32 bit. The shade says nothing about the medicine.)
 */
export function shadeOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SHADES;
}

export const entryLabel = (e: Pick<CalendarEntry, "type" | "status" | "medicineName">) =>
  `${ENTRY_TYPE_INFO[e.type].label}: ${e.medicineName}${e.status === "DONE" ? ", done" : ""}`;

export function TypeIcon({ type, size = 12 }: { type: EntryType; size?: number }) {
  const Icon = TYPE_ICON[type];
  return <Icon size={size} />;
}

export { CheckIcon };
