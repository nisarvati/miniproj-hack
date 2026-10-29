import { describe, expect, it } from "vitest";
import type { InventoryEvent } from "@medlink/event-schema";
import { detectRestock } from "../src/restock.js";

const base = {
  schemaVersion: 1,
  eventId: "6f1c1f0e-5c53-4e1e-9d52-0b6c1b0e6a11",
  pharmacyId: "P001",
  medicineId: "M001",
  timestamp: "2026-10-05T12:00:00.000Z",
} as const;
const event = (e: Record<string, unknown>) => ({ ...base, ...e }) as InventoryEvent;

describe("detectRestock", () => {
  it("recognises a RESTOCK and carries what a notification needs", () => {
    const r = detectRestock(event({ eventType: "RESTOCK", quantityDelta: 10, quantityAfter: 10, price: 25 }));
    expect(r).toEqual({
      eventId: base.eventId,
      pharmacyCode: "P001",
      medicineCode: "M001",
      quantity: 10,
      price: 25,
      occurredAt: new Date("2026-10-05T12:00:00.000Z"),
    });
  });

  it("price is optional", () => {
    expect(detectRestock(event({ eventType: "RESTOCK", quantityDelta: 3, quantityAfter: 8 }))?.price).toBeNull();
  });

  it.each([
    ["SALE", { eventType: "SALE", quantityDelta: -1, quantityAfter: 4 }],
    ["PRICE_UPDATED", { eventType: "PRICE_UPDATED", price: 30 }],
    ["MEDICINE_ADDED", { eventType: "MEDICINE_ADDED", quantityDelta: 5, quantityAfter: 5, price: 30 }],
    ["MEDICINE_REMOVED", { eventType: "MEDICINE_REMOVED", quantityDelta: -5, quantityAfter: 0 }],
  ])("ignores %s", (_name, e) => {
    expect(detectRestock(event(e))).toBeNull();
  });

  it("never reports a restock that leaves the shelf empty", () => {
    expect(detectRestock(event({ eventType: "RESTOCK", quantityDelta: 1, quantityAfter: 0 }))).toBeNull();
  });
});
