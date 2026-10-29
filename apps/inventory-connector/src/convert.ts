import { assertInventoryEvent, SCHEMA_VERSION, type InventoryEvent } from "@medlink/event-schema";

/** A row of a pharmacy database's `outbox` table. */
export interface OutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  medicine_code: string;
  quantity_delta: number | null;
  quantity_after: number | null;
  /** NUMERIC comes back from pg as a string. */
  price: string | null;
  occurred_at: Date;
}

/** Builds the standard event for an outbox row, or throws if the row doesn't describe a valid event. */
export function toEvent(row: OutboxRow, pharmacyId: string): InventoryEvent {
  return assertInventoryEvent({
    schemaVersion: SCHEMA_VERSION,
    eventId: row.event_id,
    eventType: row.event_type,
    pharmacyId,
    medicineId: row.medicine_code,
    timestamp: row.occurred_at.toISOString(),
    ...(row.quantity_delta !== null && { quantityDelta: row.quantity_delta }),
    ...(row.quantity_after !== null && { quantityAfter: row.quantity_after }),
    ...(row.price !== null && { price: Number(row.price) }),
  });
}
