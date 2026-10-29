import { describe, expect, it } from "vitest";
import { assertInventoryEvent, EVENT_TYPES, parseInventoryEvent } from "../src/index.js";

const base = {
  schemaVersion: 1,
  eventId: "3f2b8c1e-5a4d-4e8f-9b7a-1c2d3e4f5a6b",
  pharmacyId: "P001",
  medicineId: "M001",
  timestamp: "2026-10-05T14:28:39.985Z",
};
const valid = {
  SALE: { ...base, eventType: "SALE", quantityDelta: -2, quantityAfter: 8, price: 25 },
  RESTOCK: { ...base, eventType: "RESTOCK", quantityDelta: 10, quantityAfter: 10 },
  PRICE_UPDATED: { ...base, eventType: "PRICE_UPDATED", price: 27.5 },
  MEDICINE_ADDED: { ...base, eventType: "MEDICINE_ADDED", quantityDelta: 5, quantityAfter: 5, price: 30 },
  MEDICINE_REMOVED: { ...base, eventType: "MEDICINE_REMOVED", quantityDelta: -7, quantityAfter: 0 },
} as const;

const fails = (input: unknown) => {
  const r = parseInventoryEvent(input);
  expect(r.success).toBe(false);
  return r as Extract<ReturnType<typeof parseInventoryEvent>, { success: false }>;
};

describe("valid events", () => {
  it.each(EVENT_TYPES)("accepts a %s event", (type) => {
    const r = parseInventoryEvent(valid[type]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.event).toEqual(valid[type]);
  });
  it("covers every declared event type", () => {
    expect(Object.keys(valid).sort()).toEqual([...EVENT_TYPES].sort());
  });
  it("accepts timestamps with a UTC offset", () => {
    expect(parseInventoryEvent({ ...valid.SALE, timestamp: "2026-10-05T19:58:39+05:30" }).success).toBe(true);
  });
  it("accepts a SALE without a price", () => {
    const { price: _p, ...noPrice } = valid.SALE;
    expect(parseInventoryEvent(noPrice).success).toBe(true);
  });
  it("accepts removal of an already-empty item", () => {
    expect(parseInventoryEvent({ ...valid.MEDICINE_REMOVED, quantityDelta: 0 }).success).toBe(true);
  });
});

describe("invalid events", () => {
  it.each([null, undefined, "SALE", 42, [], true])("rejects non-object input %j as MALFORMED", (input) => {
    expect(fails(input).code).toBe("MALFORMED");
  });

  it("rejects unknown event types", () => {
    expect(fails({ ...valid.SALE, eventType: "THEFT" }).code).toBe("INVALID");
  });

  it("rejects unsupported schema versions distinctly", () => {
    expect(fails({ ...valid.SALE, schemaVersion: 2 }).code).toBe("UNSUPPORTED_VERSION");
    expect(fails({ ...valid.SALE, schemaVersion: 0 }).code).toBe("UNSUPPORTED_VERSION");
  });

  it("rejects a missing schema version", () => {
    const { schemaVersion: _v, ...rest } = valid.SALE;
    expect(fails(rest).code).toBe("INVALID");
  });

  it("rejects a SALE with positive or zero delta, and a RESTOCK with negative or zero delta", () => {
    expect(fails({ ...valid.SALE, quantityDelta: 2 }).errors.join()).toMatch(/quantityDelta/);
    expect(fails({ ...valid.SALE, quantityDelta: 0 }).success).toBe(false);
    expect(fails({ ...valid.RESTOCK, quantityDelta: -1 }).success).toBe(false);
    expect(fails({ ...valid.RESTOCK, quantityDelta: 0 }).success).toBe(false);
  });

  it("rejects fractional quantities", () => {
    expect(fails({ ...valid.SALE, quantityDelta: -1.5 }).success).toBe(false);
    expect(fails({ ...valid.SALE, quantityAfter: 1.5 }).success).toBe(false);
  });

  it("rejects negative resulting inventory", () => {
    expect(fails({ ...valid.SALE, quantityAfter: -1 }).success).toBe(false);
  });

  it("rejects inconsistent numbers (stock before the change would be negative)", () => {
    // a +5 restock that ends at 2 would mean the shelf held -3 before it
    expect(fails({ ...valid.RESTOCK, quantityDelta: 5, quantityAfter: 2 }).errors.join()).toMatch(/must not be negative/);
  });

  it("rejects invalid or missing prices", () => {
    for (const price of [0, -1, 10.123, NaN, Infinity, "25", 2_000_000]) {
      expect(fails({ ...valid.SALE, price }).success, String(price)).toBe(false);
    }
    expect(fails({ ...valid.PRICE_UPDATED, price: undefined }).success).toBe(false);
    expect(fails({ ...valid.MEDICINE_ADDED, price: undefined }).success).toBe(false);
  });

  it("rejects bad identifiers", () => {
    expect(fails({ ...valid.SALE, eventId: "not-a-uuid" }).success).toBe(false);
    expect(fails({ ...valid.SALE, pharmacyId: "pharmacy-1" }).success).toBe(false);
    expect(fails({ ...valid.SALE, pharmacyId: "P1" }).success).toBe(false);
    expect(fails({ ...valid.SALE, medicineId: "1" }).success).toBe(false);
    expect(fails({ ...valid.SALE, medicineId: undefined }).success).toBe(false);
  });

  it("rejects bad timestamps", () => {
    for (const timestamp of ["yesterday", "2026-10-05", "2026-13-45T00:00:00Z", 1791210893000]) {
      expect(fails({ ...valid.SALE, timestamp }).success, String(timestamp)).toBe(false);
    }
  });

  it("rejects MEDICINE_ADDED whose delta differs from the initial stock", () => {
    expect(fails({ ...valid.MEDICINE_ADDED, quantityDelta: 4 }).success).toBe(false);
  });

  it("rejects MEDICINE_REMOVED that leaves stock behind or has a positive delta", () => {
    expect(fails({ ...valid.MEDICINE_REMOVED, quantityAfter: 3 }).success).toBe(false);
    expect(fails({ ...valid.MEDICINE_REMOVED, quantityDelta: 3 }).success).toBe(false);
  });

  it("reports every problem at once, with field paths", () => {
    const r = fails({ ...valid.SALE, pharmacyId: "x", quantityDelta: 3 });
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
    expect(r.errors.join()).toMatch(/pharmacyId/);
  });
});

describe("evolution", () => {
  it("ignores unknown fields (tolerant reader) and strips them from the result", () => {
    const r = parseInventoryEvent({ ...valid.SALE, futureField: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.event).not.toHaveProperty("futureField");
  });
});

describe("assertInventoryEvent", () => {
  it("returns the event when valid and throws a readable error otherwise", () => {
    expect(assertInventoryEvent(valid.RESTOCK)).toEqual(valid.RESTOCK);
    expect(() => assertInventoryEvent({ ...valid.RESTOCK, quantityDelta: -1 })).toThrow(/Invalid inventory event.*quantityDelta/);
  });
});
