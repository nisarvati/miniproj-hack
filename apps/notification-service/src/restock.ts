import type { InventoryEvent } from "@medlink/event-schema";

/** A pharmacy has stock of a medicine that it just received. */
export interface Restock {
  eventId: string;
  pharmacyCode: string;
  medicineCode: string;
  /** Units on hand after the restock. */
  quantity: number;
  price: number | null;
  /** When it happened at the pharmacy. */
  occurredAt: Date;
}

/**
 * Recognises a restock: a RESTOCK event that leaves stock on the shelf. Everything else (sales, price changes,
 * a medicine being added or removed) is not a reason to tell anyone that a medicine is back.
 *
 * A RESTOCK that leaves nothing cannot happen (the schema requires a positive delta), but is rejected anyway:
 * telling a patient "back in stock" about an empty shelf would be worse than missing a notification.
 */
export function detectRestock(event: InventoryEvent): Restock | null {
  if (event.eventType !== "RESTOCK" || event.quantityAfter <= 0) return null;
  return {
    eventId: event.eventId,
    pharmacyCode: event.pharmacyId,
    medicineCode: event.medicineId,
    quantity: event.quantityAfter,
    price: event.price ?? null,
    occurredAt: new Date(event.timestamp),
  };
}
