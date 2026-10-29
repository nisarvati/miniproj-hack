import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@medlink/db";
import { parseMedicineQuery } from "./query.js";
import { searchMedicines } from "./repo.js";

const searchQuery = z.object({
  q: z.string().trim().min(1, "q is required").max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function medicineRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/medicines/search", async (req) => {
    const { q, limit } = searchQuery.parse(req.query);
    const medicines = await searchMedicines(db, parseMedicineQuery(q), limit);
    req.log.info({ q, results: medicines.length }, "medicine search");
    return { data: medicines, meta: { count: medicines.length } };
  });
}
