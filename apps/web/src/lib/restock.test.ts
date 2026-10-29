import { describe, expect, it } from "vitest";
import type { SearchResult, StockStatus } from "./api";
import { loadSavedEmail, looksLikeEmail, saveEmail, unavailableMedicines } from "./restock";

const row = (medicineId: number, pharmacyId: number, stockStatus: StockStatus) =>
  ({
    medicine: { id: medicineId, brandName: `Med${medicineId}`, genericName: "g", dosage: "500mg", form: "tablet" },
    pharmacy: { id: pharmacyId },
    stockStatus,
  }) as unknown as SearchResult;

describe("unavailableMedicines", () => {
  it("offers a medicine that is out of stock at every pharmacy", () => {
    const out = unavailableMedicines([row(1, 1, "OUT_OF_STOCK"), row(1, 2, "OUT_OF_STOCK")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ medicine: { id: 1 }, pharmacyCount: 2 });
  });

  it("does not offer one that is in stock, or low, anywhere", () => {
    expect(unavailableMedicines([row(1, 1, "OUT_OF_STOCK"), row(1, 2, "IN_STOCK")])).toEqual([]);
    expect(unavailableMedicines([row(1, 1, "OUT_OF_STOCK"), row(1, 2, "LOW_STOCK")])).toEqual([]);
  });

  it("judges each medicine on its own", () => {
    const out = unavailableMedicines([row(1, 1, "OUT_OF_STOCK"), row(2, 1, "IN_STOCK"), row(2, 2, "OUT_OF_STOCK"), row(3, 1, "OUT_OF_STOCK")]);
    expect(out.map((o) => o.medicine.id)).toEqual([1, 3]);
  });

  it("offers nothing for no results", () => {
    expect(unavailableMedicines([])).toEqual([]);
  });
});

describe("looksLikeEmail", () => {
  it.each(["a@b.co", "asha.k+med@example.com", " a@b.co "])("accepts %s", (s) => expect(looksLikeEmail(s)).toBe(true));
  it.each(["", "asha", "asha@", "@example.com", "a b@example.com", "a@b", `${"x".repeat(250)}@b.co`])("rejects %j", (s) => expect(looksLikeEmail(s)).toBe(false));
});

describe("remembered email", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it("round-trips, normalised", () => {
    const store = memory();
    saveEmail("  Asha@Example.com ", store);
    expect(loadSavedEmail(store)).toBe("asha@example.com");
  });

  it("returns null when nothing (or something invalid) is stored", () => {
    const store = memory();
    expect(loadSavedEmail(store)).toBeNull();
    store.setItem("medlink:notify-email", "garbage");
    expect(loadSavedEmail(store)).toBeNull();
  });

  it("survives storage that throws (private mode)", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSavedEmail(broken)).toBeNull();
    expect(() => saveEmail("a@b.co", broken)).not.toThrow();
  });
});
