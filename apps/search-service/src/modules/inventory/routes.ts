import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@medlink/db";
import type { Config } from "../../config.js";
import { AppError } from "../../errors.js";
import { getInventory, listInventory, type InventoryItem } from "./repo.js";
import { stockStatus } from "./stock.js";

const id = z.coerce.number().int().positive();

const listQuery = z.object({
  pharmacyId: id.optional(),
  medicineId: id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function inventoryRoutes(app: FastifyInstance, db: Db, config: Config) {
  const present = (i: InventoryItem) => ({ ...i, stockStatus: stockStatus(i.quantity, config.LOW_STOCK_THRESHOLD) });

  app.get("/api/inventory", async (req) => {
    const q = listQuery.parse(req.query);
    const items = await listInventory(db, q);
    return { data: items.map(present), meta: { limit: q.limit, offset: q.offset, count: items.length } };
  });

  app.get("/api/inventory/:id", async (req) => {
    const { id: itemId } = z.object({ id }).parse(req.params);
    const item = await getInventory(db, itemId);
    if (!item) throw new AppError(404, "NOT_FOUND", "Inventory item not found");
    return { data: present(item) };
  });
}
