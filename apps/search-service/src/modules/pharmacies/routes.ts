import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { candidateDirections, DEMO_LISTING_LABEL, directoryCandidates, directoryExtras, type Db } from "@medlink/db";
import type { Config } from "../../config.js";
import { AppError } from "../../errors.js";
import { haversineKm } from "../geo/haversine.js";
import type { LiveStock } from "../live/live-stock.js";
import { getPharmacy, listPharmacies } from "./repo.js";
import { pharmacyStock } from "./stock.js";

const id = z.coerce.number().int().positive();
const DECIMAL = /^-?\d+(\.\d+)?$/;
const optionalCoordinate = (limit: number) => z.string().trim().regex(DECIMAL, "must be a decimal number").transform(Number).pipe(z.number().min(-limit).max(limit)).optional();
const locationQuery = z.object({ lat: optionalCoordinate(90), lng: optionalCoordinate(180) });
const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
const stockQuery = z.object({ q: z.string().trim().max(100).optional(), inStock: bool.optional() });

export function pharmacyRoutes(app: FastifyInstance, deps: { db: Db; config: Config; live?: LiveStock }) {
  const { db } = deps;

  app.get("/api/pharmacies", async () => {
    const pharmacies = await listPharmacies(db);
    return { data: pharmacies, meta: { count: pharmacies.length } };
  });

  /**
   * Directory listings that are NOT inventory providers: accepted entries not yet onboarded, and research leads (provisional,
   * needs-review). Read from the directory file; no database, no stock, no offers, and no coordinates are ever returned, so no
   * pin or distance can be built from them. `directions` says how far the address can be trusted for Google Maps.
   */
  app.get("/api/directory", async () => {
    const accepted = directoryExtras().map((p) => ({
      code: p.code,
      name: p.name,
      area: p.area,
      address: p.address,
      listingStatus: "accepted" as const,
      reason: p.location.note,
      directions: "address" as const,
    }));
    const leads = directoryCandidates().map((c) => ({
      code: c.code,
      name: c.name,
      area: c.area,
      address: c.address,
      listingStatus: c.listingStatus,
      reason: c.reason,
      directions: candidateDirections(c),
    }));
    const data = [...accepted, ...leads].map((e) => ({ ...e, demo: true as const, label: DEMO_LISTING_LABEL, inventory: "none" as const, locationVerified: false as const }));
    return { data, meta: { count: data.length } };
  });

  /** One pharmacy. With ?lat&lng, also how far it is from there. */
  app.get("/api/pharmacies/:id", async (req) => {
    const { id: pharmacyId } = z.object({ id }).parse(req.params);
    const { lat, lng } = locationQuery.parse(req.query);
    const pharmacy = await getPharmacy(db, pharmacyId);
    if (!pharmacy) throw new AppError(404, "NOT_FOUND", "Pharmacy not found");
    // No distance is claimed for a pharmacy whose map point is not verified.
    const distanceKm = lat !== undefined && lng !== undefined && pharmacy.locationVerified ? Math.round(haversineKm({ latitude: lat, longitude: lng }, pharmacy) * 100) / 100 : null;
    return { data: { ...pharmacy, distanceKm } };
  });

  /** Everything the pharmacy stocks, with live stock over the catalogue. `q` filters by name, `inStock` by availability. */
  app.get("/api/pharmacies/:id/stock", async (req) => {
    const { id: pharmacyId } = z.object({ id }).parse(req.params);
    const { q, inStock } = stockQuery.parse(req.query);
    const pharmacy = await getPharmacy(db, pharmacyId);
    if (!pharmacy) throw new AppError(404, "NOT_FOUND", "Pharmacy not found");

    const { items, live } = await pharmacyStock({ ...deps, log: req.log }, pharmacy);
    const needle = q?.toLowerCase();
    const shown = items.filter(
      (i) =>
        (!inStock || i.quantity > 0) &&
        (!needle || `${i.medicine.brandName} ${i.medicine.genericName} ${i.medicine.dosage} ${i.medicine.form}`.toLowerCase().includes(needle)),
    );
    const count = (s: string) => items.filter((i) => i.stockStatus === s).length;
    return {
      data: shown,
      meta: { count: shown.length, total: items.length, live, summary: { inStock: count("IN_STOCK"), lowStock: count("LOW_STOCK"), outOfStock: count("OUT_OF_STOCK") } },
    };
  });
}
