/**
 * Redis key conventions shared by whoever writes events (connectors) and whoever reads them (sync service).
 *
 * One stream per pharmacy keeps that pharmacy's events in order. The pharmacy code is a Redis hash tag
 * ({P001}), so in Redis Cluster every key of one pharmacy lives in the same slot.
 */
export const DEFAULT_KEY_PREFIX = "medlink";

/** The single field of a stream entry; its value is the JSON-encoded InventoryEvent. */
export const STREAM_EVENT_FIELD = "event";

export const eventStreamKey = (pharmacyId: string, prefix = DEFAULT_KEY_PREFIX) => `${prefix}:events:{${pharmacyId}}`;

/** Set of all event stream keys, so consumers discover pharmacies without a hard-coded list. */
export const streamRegistryKey = (prefix = DEFAULT_KEY_PREFIX) => `${prefix}:streams`;

/** Events that could not be processed, kept for inspection. */
export const deadLetterKey = (prefix = DEFAULT_KEY_PREFIX) => `${prefix}:events:dlq`;

/** Per-pharmacy synchronization status (last event, last sync time, counters). */
export const syncStatusKey = (pharmacyId: string, prefix = DEFAULT_KEY_PREFIX) => `${prefix}:sync:{${pharmacyId}}`;

/**
 * Marker for one event id, used to ignore duplicate deliveries (milestone 8). Same hash tag as the pharmacy's
 * other keys. Value is "processing" (short lease) or "done" (kept for the retention period).
 */
export const dedupKey = (pharmacyId: string, eventId: string, prefix = DEFAULT_KEY_PREFIX) =>
  `${prefix}:dedup:{${pharmacyId}}:${eventId}`;

/**
 * Current state of one medicine at one pharmacy (milestone 9): quantity, price and the event timestamps that
 * decided them. Same hash tag as the pharmacy's other keys, so one script can touch all of them atomically.
 */
export const inventoryItemKey = (pharmacyId: string, medicineId: string, prefix = DEFAULT_KEY_PREFIX) =>
  `${prefix}:inventory:{${pharmacyId}}:${medicineId}`;

/** Set of the medicine ids a pharmacy currently lists (removed medicines are not in it). */
export const inventoryIndexKey = (pharmacyId: string, prefix = DEFAULT_KEY_PREFIX) =>
  `${prefix}:inventory:{${pharmacyId}}:index`;

/**
 * Which pharmacies may stock a medicine (milestone 10). Hash-tagged by the MEDICINE, so it lives in a different
 * slot than the pharmacy keys and cannot be part of their atomic script. It is therefore a superset hint, never the
 * truth: it is written before the pharmacy's state change (a crash can leave an extra entry, never a missing one),
 * and readers check each pharmacy's own item before trusting an entry.
 */
export const medicineIndexKey = (medicineId: string, prefix = DEFAULT_KEY_PREFIX) =>
  `${prefix}:medicine:{${medicineId}}:pharmacies`;

/** Extracts "P001" from "<prefix>:events:{P001}", or null for keys that aren't event streams. */
export function pharmacyIdFromStreamKey(key: string): string | null {
  return /:events:\{(P\d{3,})\}$/.exec(key)?.[1] ?? null;
}
