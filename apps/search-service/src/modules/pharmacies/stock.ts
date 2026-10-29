import type { Db } from "@medlink/db";
import type { Config } from "../../config.js";
import { stockStatus, type StockStatus } from "../inventory/stock.js";
import type { LiveStock } from "../live/live-stock.js";
import { overlayLive, type BaseOffer } from "../live/overlay.js";
import { type Medicine } from "../medicines/repo.js";
import type { Pharmacy } from "./repo.js";

export interface PharmacyStockItem {
  medicine: Omit<Medicine, "relevance">;
  quantity: number;
  price: number;
  stockStatus: StockStatus;
  updatedAt: string;
  source: "live" | "catalogue";
}

/** Everything a pharmacy lists, with live stock over the catalogue (see overlayLive). */
export async function pharmacyStock(
  deps: { db: Db; config: Config; live?: LiveStock; log?: { warn(obj: object, msg?: string): void } },
  pharmacy: Pharmacy,
): Promise<{ items: PharmacyStockItem[]; live: boolean }> {
  const { rows } = await deps.db.query<{
    id: string; code: string; brand_name: string; generic_name: string; dosage: string; form: string;
    quantity: number; price: string; updated_at: Date;
  }>(
    `SELECT m.id, m.code, m.brand_name, m.generic_name, m.dosage, m.form, i.quantity, i.price, i.updated_at
     FROM inventory i JOIN medicines m ON m.id = i.medicine_id
     WHERE i.pharmacy_id = $1`,
    [pharmacy.id],
  );
  const base: BaseOffer[] = rows.map((r) => ({
    pharmacy,
    medicine: { id: Number(r.id), code: r.code, brandName: r.brand_name, genericName: r.generic_name, dosage: r.dosage, form: r.form, relevance: 1 },
    quantity: r.quantity,
    price: Number(r.price),
    updatedAt: r.updated_at,
  }));

  const { offers, live } = await overlayLive(deps, base, async (liveStock) =>
    [...(await liveStock.pharmacyItems(pharmacy.code)).keys()].map((medicineCode) => ({ pharmacyCode: pharmacy.code, medicineCode })),
  );
  const mine = offers.filter((o) => o.pharmacy.code === pharmacy.code);

  const items = mine
    .map((o): PharmacyStockItem => {
      const { relevance: _relevance, ...medicine } = o.medicine;
      return {
        medicine,
        quantity: o.quantity,
        price: o.price,
        stockStatus: stockStatus(o.quantity, deps.config.LOW_STOCK_THRESHOLD),
        updatedAt: o.updatedAt.toISOString(),
        source: o.source,
      };
    })
    .sort((a, b) => a.medicine.brandName.localeCompare(b.medicine.brandName) || a.medicine.dosage.localeCompare(b.medicine.dosage));
  return { items, live };
}
