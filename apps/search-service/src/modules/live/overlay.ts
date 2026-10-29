import type { Db } from "@medlink/db";
import { medicinesByCodes, type Medicine } from "../medicines/repo.js";
import { pharmaciesByCodes, type Pharmacy } from "../pharmacies/repo.js";
import { liveKey, type LiveStock } from "./live-stock.js";

/** What the catalogue database says about one medicine at one pharmacy. */
export interface BaseOffer {
  pharmacy: Pharmacy;
  medicine: Medicine;
  quantity: number;
  price: number;
  updatedAt: Date;
}

export interface Offer extends BaseOffer {
  /** "live": from the event pipeline's current state. "catalogue": the central database's last known value. */
  source: "live" | "catalogue";
}

export interface OverlayResult {
  offers: Offer[];
  /** False if live stock is not configured or did not answer: everything is then "catalogue". */
  live: boolean;
}

export interface OverlayDeps {
  db: Db;
  live?: LiveStock;
  log?: { warn(obj: object, msg?: string): void };
}

/**
 * Lays live stock over the catalogue rows.
 *
 *  - A pair Redis knows is taken from Redis (quantity, price, time of the last event), so a change at the pharmacy
 *    shows up as soon as it has been synced.
 *  - A pair Redis marks removed is dropped: the pharmacy stopped stocking it, whatever the central table says.
 *  - A pair only Redis knows (a medicine the pharmacy added through an event, never copied to the central table)
 *    is added, using the catalogue for the pharmacy's and medicine's details.
 *  - A pair Redis has never heard of keeps its catalogue value, so a half-filled Redis never makes stock vanish.
 *  - If Redis is down or slow, everything falls back to the catalogue. Search must work without it.
 *
 * `extra` are additional (pharmacy, medicine) pairs worth asking Redis about: the ones its indexes list.
 */
export async function overlayLive(
  deps: OverlayDeps,
  base: BaseOffer[],
  extra: (live: LiveStock) => Promise<{ pharmacyCode: string; medicineCode: string }[]> = async () => [],
): Promise<OverlayResult> {
  const catalogue = (): OverlayResult => ({ offers: base.map((b) => ({ ...b, source: "catalogue" as const })), live: false });
  if (!deps.live) return catalogue();

  try {
    const known = new Map(base.map((b) => [liveKey(b.pharmacy.code, b.medicine.code), b]));
    const pairs = new Map<string, { pharmacyCode: string; medicineCode: string }>();
    for (const b of base) pairs.set(liveKey(b.pharmacy.code, b.medicine.code), { pharmacyCode: b.pharmacy.code, medicineCode: b.medicine.code });
    for (const p of await extra(deps.live)) pairs.set(liveKey(p.pharmacyCode, p.medicineCode), p);

    const items = await deps.live.getMany([...pairs.values()]);

    // Details for pharmacies / medicines that only Redis mentions.
    const pharmacyByCode = new Map(base.map((b) => [b.pharmacy.code, b.pharmacy]));
    const medicineByCode = new Map(base.map((b) => [b.medicine.code, b.medicine]));
    const needPharmacies = [...new Set([...items.keys()].map((k) => k.split("|")[0]!))].filter((c) => !pharmacyByCode.has(c));
    const needMedicines = [...new Set([...items.keys()].map((k) => k.split("|")[1]!))].filter((c) => !medicineByCode.has(c));
    for (const p of await pharmaciesByCodes(deps.db, needPharmacies)) pharmacyByCode.set(p.code, p);
    for (const m of await medicinesByCodes(deps.db, needMedicines)) medicineByCode.set(m.code, m);

    const offers = new Map<string, Offer>(base.map((b) => [liveKey(b.pharmacy.code, b.medicine.code), { ...b, source: "catalogue" as const }]));
    for (const [key, item] of items) {
      if (item.removed) {
        offers.delete(key);
        continue;
      }
      const [pharmacyCode, medicineCode] = key.split("|") as [string, string];
      const pharmacy = pharmacyByCode.get(pharmacyCode);
      const medicine = medicineByCode.get(medicineCode);
      // A field Redis has not seen yet (a price update that came before any quantity, say) comes from the catalogue.
      const price = item.price ?? known.get(key)?.price ?? null;
      const quantity = item.quantity ?? known.get(key)?.quantity ?? null;
      if (!pharmacy || !medicine || price === null || quantity === null) continue; // not enough to show; keep the catalogue row, if any
      offers.set(key, { pharmacy, medicine, quantity, price, updatedAt: item.updatedAt, source: "live" });
    }
    return { offers: [...offers.values()], live: true };
  } catch (err) {
    deps.log?.warn({ error: (err as Error).message }, "live stock unavailable; using the catalogue database");
    return catalogue();
  }
}
