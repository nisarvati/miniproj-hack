import { MEDICINES, knownPharmacies, shippedCatalogue, type SeedMedicine, type SeedPharmacy } from "@medlink/db";

export class SimulatorError extends Error {
  constructor(
    public readonly code: "UNKNOWN_PHARMACY" | "UNKNOWN_MEDICINE" | "NOT_STOCKED" | "ALREADY_STOCKED" | "INSUFFICIENT_STOCK" | "IDEMPOTENCY_KEY_REUSED" | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SimulatorError";
  }
}

export const pharmacyByCode = (code: string): SeedPharmacy => {
  const all = knownPharmacies();
  const p = all.find((x) => x.code === code);
  if (!p) throw new SimulatorError("UNKNOWN_PHARMACY", `Unknown pharmacy "${code}". Known: ${all.map((x) => x.code).join(", ")}`);
  return p;
};

/** The demo medicines that ship with starting stock and a base price. */
export const medicineByCode = (code: string): SeedMedicine | undefined => MEDICINES.find((m) => m.code === code);

/** What the simulator and portal need to know about any catalogued product. */
export interface CatalogueEntry {
  code: string;
  brand: string;
  generic: string;
  dosage: string;
  form: string;
}

/**
 * Every product a pharmacy may start stocking: the demo medicines plus the verified catalogue batches. Being listed here
 * only means the product exists in the MedLink catalogue; it says nothing about any pharmacy's stock.
 */
export const catalogueEntries = (): CatalogueEntry[] => {
  const seeded = new Set(MEDICINES.map((m) => m.code));
  return [...MEDICINES, ...shippedCatalogue().filter((c) => !seeded.has(c.code))];
};

export const catalogueEntryByCode = (code: string): CatalogueEntry | undefined => catalogueEntries().find((m) => m.code === code);

/** "Crocin 500mg" */
export const medicineLabel = (code: string): string => {
  const m = catalogueEntryByCode(code);
  return m ? `${m.brand} ${m.dosage}` : code;
};

/** Accepts a pharmacy code in any case ("p004"). */
export function resolvePharmacy(input: string): string {
  return pharmacyByCode(input.trim().toUpperCase()).code;
}

/** Accepts a medicine code ("m001") or the start of a brand name ("croc"). */
export function resolveMedicine(input: string): string {
  const text = input.trim();
  if (!text) throw new SimulatorError("UNKNOWN_MEDICINE", `Name a medicine by code (M001) or brand (Crocin); "list" shows the catalogue.`);
  if (/^m\d{3,}$/i.test(text)) {
    const code = text.toUpperCase();
    if (!catalogueEntryByCode(code)) throw new SimulatorError("UNKNOWN_MEDICINE", `Unknown medicine "${code}". Try "list" to see the catalogue.`);
    return code;
  }
  const matches = catalogueEntries().filter((m) => m.brand.toLowerCase().startsWith(text.toLowerCase()));
  if (matches.length === 1) return matches[0]!.code;
  if (matches.length > 1) {
    throw new SimulatorError("UNKNOWN_MEDICINE", `"${input}" matches several medicines: ${matches.map((m) => `${m.code} ${m.brand}`).join(", ")}`);
  }
  throw new SimulatorError("UNKNOWN_MEDICINE", `Unknown medicine "${input}". Use a code (M001) or a brand name (Crocin); "list" shows the catalogue.`);
}
