import type { InventoryStateHandler } from "@medlink/inventory-sync";
import type { PharmacySimulator, StockLine } from "./simulator.js";

export interface ComparedItem {
  medicineCode: string;
  /** The pharmacy's own database: the source of truth. */
  pharmacy: StockLine | null;
  /** What MedLink has in Redis after syncing. */
  synced: { quantity: number; price: number | null } | null;
  inSync: boolean;
}

export interface Comparison {
  pharmacyCode: string;
  items: ComparedItem[];
  inSync: boolean;
}

/**
 * The proof that the synchronisation worked: the pharmacy's own stock against MedLink's Redis state,
 * medicine by medicine. A medicine is in sync when quantity and price are equal; one the pharmacy does not
 * carry must not be listed in Redis either.
 */
export async function compareStock(simulator: PharmacySimulator, state: InventoryStateHandler, pharmacyCode: string): Promise<Comparison> {
  const [stock, listed] = await Promise.all([simulator.stock(pharmacyCode), state.listItems(pharmacyCode)]);
  const synced = new Map(listed.map((i) => [i.medicineId, i]));

  const items: ComparedItem[] = [];
  for (const code of [...new Set([...stock.keys(), ...synced.keys()])].sort()) {
    const pharmacy = stock.get(code) ?? null;
    const item = synced.get(code);
    const redis = item ? { quantity: item.quantity, price: item.price } : null;
    const inSync = pharmacy === null ? redis === null : redis !== null && redis.quantity === pharmacy.quantity && redis.price === pharmacy.price;
    items.push({ medicineCode: code, pharmacy, synced: redis, inSync });
  }
  return { pharmacyCode, items, inSync: items.every((i) => i.inSync) };
}

/** Waits for the pipeline to catch up: resolves as soon as the two agree, or with the last comparison at the timeout. */
export async function waitUntilInSync(
  simulator: PharmacySimulator,
  state: InventoryStateHandler,
  pharmacyCode: string,
  timeoutMs = 15_000,
  pollMs = 100,
): Promise<Comparison> {
  const started = Date.now();
  for (;;) {
    const c = await compareStock(simulator, state, pharmacyCode);
    if (c.inSync || Date.now() - started >= timeoutMs) return c;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
