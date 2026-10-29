import type { SearchResult } from "./api";

type MedicineRef = SearchResult["medicine"];

/**
 * Medicines worth offering "notify me" for: every pharmacy in the results is out of stock. A medicine that is in
 * stock anywhere is not offered, since the patient can simply go there.
 */
export function unavailableMedicines(results: SearchResult[]): { medicine: MedicineRef; pharmacyCount: number }[] {
  const byMedicine = new Map<number, { medicine: MedicineRef; total: number; out: number }>();
  for (const r of results) {
    const entry = byMedicine.get(r.medicine.id) ?? { medicine: r.medicine, total: 0, out: 0 };
    entry.total++;
    if (r.stockStatus === "OUT_OF_STOCK") entry.out++;
    byMedicine.set(r.medicine.id, entry);
  }
  return [...byMedicine.values()].filter((e) => e.out === e.total).map((e) => ({ medicine: e.medicine, pharmacyCount: e.total }));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lenient on purpose: the server has the final say. This only catches obvious typos before a round trip. */
export const looksLikeEmail = (s: string): boolean => EMAIL.test(s.trim()) && s.trim().length <= 254;

const KEY = "medlink:notify-email";

/** The email remembered on this device, so a returning user sees their notifications. Storage may be blocked. */
export function loadSavedEmail(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): string | null {
  try {
    const v = storage?.getItem(KEY);
    return v && looksLikeEmail(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveEmail(email: string, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, email.trim().toLowerCase());
  } catch {
    /* private mode or blocked storage: the feature works, it just isn't remembered */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
