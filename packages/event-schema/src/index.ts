import { z } from "zod";

/**
 * The standard MedLink inventory event. Every pharmacy connector emits these; the sync service consumes them.
 *
 * Evolution rules:
 *  - `schemaVersion` identifies the contract. Consumers reject versions they don't know (UNSUPPORTED_VERSION)
 *    instead of guessing, so a new version can be rolled out producers-last.
 *  - Within a version, readers ignore unknown fields (tolerant reader), so optional fields can be added
 *    without a version bump. Removing/renaming a field or changing its meaning requires a new version.
 */
export const SCHEMA_VERSION = 1;
export const SUPPORTED_VERSIONS: readonly number[] = [1];

export const EVENT_TYPES = ["SALE", "RESTOCK", "PRICE_UPDATED", "MEDICINE_ADDED", "MEDICINE_REMOVED"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const price = z.number().positive().max(1_000_000).multipleOf(0.01);
const quantityAfter = z.number().int().min(0).max(1_000_000);

const base = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** Globally unique, assigned once when the change is recorded and stable across re-publication. Idempotency key. */
  eventId: z.string().uuid(),
  /** Public pharmacy code, e.g. "P001". */
  pharmacyId: z.string().regex(/^P\d{3,}$/, "pharmacyId must look like P001"),
  /** Public medicine code from the MedLink catalogue, e.g. "M001". */
  medicineId: z.string().regex(/^M\d{3,}$/, "medicineId must look like M001"),
  /** When the change happened at the pharmacy (ISO 8601). */
  timestamp: z.string().datetime({ offset: true }),
};

const sale = z.object({
  ...base,
  eventType: z.literal("SALE"),
  /** Negative: units that left stock. */
  quantityDelta: z.number().int().max(-1),
  /** The pharmacy's authoritative quantity after this change. */
  quantityAfter,
  price: price.optional(),
});

const restock = z.object({
  ...base,
  eventType: z.literal("RESTOCK"),
  quantityDelta: z.number().int().min(1),
  quantityAfter,
  price: price.optional(),
});

const priceUpdated = z.object({ ...base, eventType: z.literal("PRICE_UPDATED"), price });

const medicineAdded = z.object({
  ...base,
  eventType: z.literal("MEDICINE_ADDED"),
  /** Initial stock; equals quantityAfter. */
  quantityDelta: z.number().int().min(0),
  quantityAfter,
  price,
});

const medicineRemoved = z.object({
  ...base,
  eventType: z.literal("MEDICINE_REMOVED"),
  /** Minus the stock that was on hand; stock after removal is 0. */
  quantityDelta: z.number().int().max(0),
  quantityAfter: z.literal(0),
});

export const inventoryEventSchema = z
  .discriminatedUnion("eventType", [sale, restock, priceUpdated, medicineAdded, medicineRemoved])
  .superRefine((e, ctx) => {
    // The numbers must tell one consistent story: stock before the change can't have been negative.
    if (e.eventType === "SALE" || e.eventType === "RESTOCK") {
      if (e.quantityAfter - e.quantityDelta < 0) {
        ctx.addIssue({ code: "custom", path: ["quantityAfter"], message: "quantityAfter - quantityDelta (stock before) must not be negative" });
      }
    }
    if (e.eventType === "MEDICINE_ADDED" && e.quantityDelta !== e.quantityAfter) {
      ctx.addIssue({ code: "custom", path: ["quantityDelta"], message: "for MEDICINE_ADDED, quantityDelta must equal quantityAfter" });
    }
  });

export type InventoryEvent = z.infer<typeof inventoryEventSchema>;

export type ParseResult =
  | { success: true; event: InventoryEvent }
  | { success: false; code: "MALFORMED" | "UNSUPPORTED_VERSION" | "INVALID"; errors: string[] };

/** Validates untrusted input (a stream entry, a request body). Never throws. */
export function parseInventoryEvent(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { success: false, code: "MALFORMED", errors: ["event must be a JSON object"] };
  }
  const version = (input as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version === "number" && !SUPPORTED_VERSIONS.includes(version)) {
    return { success: false, code: "UNSUPPORTED_VERSION", errors: [`unsupported schemaVersion ${version}`] };
  }
  const parsed = inventoryEventSchema.safeParse(input);
  if (parsed.success) return { success: true, event: parsed.data };
  return {
    success: false,
    code: "INVALID",
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(event)"}: ${i.message}`),
  };
}

/** For trusted producers: throws with a readable message if the event is not valid. */
export function assertInventoryEvent(input: unknown): InventoryEvent {
  const r = parseInventoryEvent(input);
  if (!r.success) throw new Error(`Invalid inventory event: ${r.errors.join("; ")}`);
  return r.event;
}
export * from "./streams.js";
