import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../../errors.js";
import { MATCH_MODEL_VERSION } from "../ranking/match.js";
import { findSubstitutes, searchOffers, type SearchDeps } from "./service.js";

const DECIMAL = /^-?\d+(\.\d+)?$/;

const coordinate = (name: string, limit: number) =>
  z
    .string({ required_error: `${name} is required (decimal degrees)` })
    .trim()
    .regex(DECIMAL, `${name} must be a decimal number`)
    .transform(Number)
    .pipe(z.number().min(-limit, `${name} must be between -${limit} and ${limit}`).max(limit, `${name} must be between -${limit} and ${limit}`));

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

export const searchQuery = z.object({
  q: z.string().trim().min(1, "q is required").max(100),
  lat: coordinate("lat", 90),
  lng: coordinate("lng", 180),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  inStock: bool.optional(),
  maxDistanceKm: z.coerce.number().positive("maxDistanceKm must be more than 0").max(500).optional(),
  maxPrice: z.coerce.number().positive("maxPrice must be more than 0").max(1_000_000).optional(),
  sort: z.enum(["best", "distance", "price", "stock"]).default("best"),
});

const locationQuery = z.object({ lat: coordinate("lat", 90), lng: coordinate("lng", 180) });

export function searchRoutes(app: FastifyInstance, deps: SearchDeps) {
  app.get("/api/search", async (req) => {
    const { q, lat, lng, limit, inStock, maxDistanceKm, maxPrice, sort } = searchQuery.parse(req.query);
    const filters = { inStock, maxDistanceKm, maxPrice, sort };
    const { results, matches, live, sortApplied, sortNote, unverifiedCount, unverifiedFiltered, rejected, rejectionSummary } = await searchOffers(deps, { q, location: { latitude: lat, longitude: lng }, limit, filters });
    // Patient location is logged at ~1 km precision only.
    req.log.info({ q, approxLat: Math.round(lat * 100) / 100, approxLng: Math.round(lng * 100) / 100, results: results.length, live }, "search");
    return { data: results, meta: { count: results.length, matches, sortApplied, sortNote, unverifiedCount, unverifiedFiltered, weights: deps.config.ranking.weights, live, sort, rejected, rejectionSummary, matchModelVersion: MATCH_MODEL_VERSION, filters: { inStock: inStock ?? false, maxDistanceKm: maxDistanceKm ?? null, maxPrice: maxPrice ?? null } } };
  });

  /** Same-ingredient alternatives that can be bought nearby, for a medicine that is out of stock. */
  app.get("/api/medicines/:id/substitutes", async (req) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const { lat, lng } = locationQuery.parse(req.query);
    const found = await findSubstitutes(deps, id, { latitude: lat, longitude: lng });
    if (!found) throw new AppError(404, "NOT_FOUND", "Medicine not found");
    return {
      data: found.substitutes,
      meta: {
        count: found.substitutes.length,
        live: found.live,
        medicine: found.medicine,
        // Said by the API so every client says it: a substitute is a suggestion, not a prescription.
        notice: "Strength or form may differ. Check with a pharmacist or your doctor before switching.",
      },
    };
  });
}
