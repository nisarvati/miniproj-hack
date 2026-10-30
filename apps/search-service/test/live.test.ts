import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seed, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import type { InventoryEvent } from "@medlink/event-schema";
import { InventoryStateHandler } from "@medlink/inventory-sync";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RedisLiveStock, type LiveStock } from "../src/modules/live/live-stock.js";

let db: Db;
let redis: Redis;
let prefix: string;
let state: InventoryStateHandler;
let app: FastifyInstance;
const apps: FastifyInstance[] = [];
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });

// Seeded Crocin 500mg (M001): P001 1, P002 40, P003 3, P004 0, P005 25.  Search from Andheri West.
const WEST = "lat=19.1364&lng=72.8296";

beforeAll(async () => {
  db = await freshSeededDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await seed(db);
  redis = createRedis({ ...redisOptionsFromEnv(), failFast: true, onError: () => undefined });
  prefix = `test-${randomUUID().slice(0, 8)}`;
  state = new InventoryStateHandler(redis, { keyPrefix: prefix });
  app = await build(new RedisLiveStock(redis, { keyPrefix: prefix, timeoutMs: 1000 }));
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
  redis.disconnect();
});

async function build(live?: LiveStock) {
  const a = await buildApp(db, config, { logger: false, live });
  apps.push(a);
  return a;
}
const get = (url: string, target = app) => target.inject({ method: "GET", url });
const search = async (q: string, extra = "", target = app) => (await get(`/api/search?q=${encodeURIComponent(q)}&${WEST}${extra ? "&" + extra : ""}`, target)).json();
const crocin = async (extra = "") => (await search("Crocin 500mg", extra)).data as { pharmacy: { code: string }; quantity: number; price: number; stockStatus: string; source: string; updatedAt: string }[];
const row = (rows: Awaited<ReturnType<typeof crocin>>, code: string) => rows.find((r) => r.pharmacy.code === code);

let t = 0;
function event(over: Record<string, unknown>): InventoryEvent {
  return { schemaVersion: 1, eventId: randomUUID(), pharmacyId: "P001", medicineId: "M001", timestamp: new Date(Date.now() + 1000 * ++t).toISOString(), ...over } as InventoryEvent;
}
const sale = (pharmacyId: string, after: number, medicineId = "M001") => event({ eventType: "SALE", pharmacyId, medicineId, quantityDelta: -1, quantityAfter: after });
const restock = (pharmacyId: string, after: number, medicineId = "M001") => event({ eventType: "RESTOCK", pharmacyId, medicineId, quantityDelta: 1, quantityAfter: after });
const reprice = (pharmacyId: string, price: number, medicineId = "M001") => event({ eventType: "PRICE_UPDATED", pharmacyId, medicineId, price });
const added = (pharmacyId: string, medicineId: string, qty: number, price: number) => event({ eventType: "MEDICINE_ADDED", pharmacyId, medicineId, quantityDelta: qty, quantityAfter: qty, price });
const removed = (pharmacyId: string, medicineId: string) => event({ eventType: "MEDICINE_REMOVED", pharmacyId, medicineId, quantityDelta: -1, quantityAfter: 0 });

describe("live stock in search", () => {
  it("without live stock configured: the catalogue database answers, and says so", async () => {
    const plain = await build();
    const body = await search("Crocin 500mg", "", plain);
    expect(body.meta.live).toBe(false);
    expect(body.data.every((r: { source: string }) => r.source === "catalogue")).toBe(true);
    expect(body.data).toHaveLength(5);
  });

  it("with live stock but nothing synced yet: the same numbers, from the catalogue, so a half-filled Redis loses nothing", async () => {
    const body = await search("Crocin 500mg");
    expect(body.meta.live).toBe(true);
    expect(body.data.map((r: { quantity: number }) => r.quantity).sort((a: number, b: number) => a - b)).toEqual([0, 1, 3, 25, 40]);
    expect(body.data.every((r: { source: string }) => r.source === "catalogue")).toBe(true);
  });

  it("a sale at a pharmacy shows up in the results, marked live, with the time of the event", async () => {
    const e = sale("P002", 0);
    await state.apply(e);
    const rows = await crocin();
    expect(row(rows, "P002")).toMatchObject({ quantity: 0, stockStatus: "OUT_OF_STOCK", source: "live", updatedAt: e.timestamp });
    expect(row(rows, "P001")).toMatchObject({ quantity: 1, source: "catalogue" }); // untouched pharmacies keep their catalogue value
  });

  it("a restock turns an out-of-stock pharmacy into the best match", async () => {
    expect(row(await crocin(), "P004")).toMatchObject({ stockStatus: "OUT_OF_STOCK" });
    await state.apply(restock("P004", 30));
    const rows = await crocin();
    expect(row(rows, "P004")).toMatchObject({ quantity: 30, stockStatus: "IN_STOCK", source: "live" });
  });

  it("a price change shows up", async () => {
    await state.apply(reprice("P001", 19.5));
    expect(row(await crocin(), "P001")).toMatchObject({ price: 19.5, quantity: 1, source: "live" });
  });

  it("a price update seen before any quantity keeps the catalogue's quantity instead of reading as zero", async () => {
    await state.apply(reprice("P003", 29)); // quantity never seen by Redis
    expect(row(await crocin(), "P003")).toMatchObject({ price: 29, quantity: 3, source: "live" });
  });

  it("a medicine the pharmacy stopped stocking disappears, whatever the central table says", async () => {
    await state.apply(removed("P001", "M001"));
    expect(row(await crocin(), "P001")).toBeUndefined();
    expect(await crocin()).toHaveLength(4);
  });

  it("a medicine added at a pharmacy through an event appears even though the central table never had it", async () => {
    // P004 carries no Cetzine (M008) in the central table
    expect((await search("Cetzine")).data.filter((r: { pharmacy: { code: string } }) => r.pharmacy.code === "P004")).toHaveLength(0);
    await state.apply(added("P004", "M008", 20, 22.88));
    const found = (await search("Cetzine")).data.find((r: { pharmacy: { code: string } }) => r.pharmacy.code === "P004");
    expect(found).toMatchObject({ quantity: 20, price: 22.88, source: "live", pharmacy: { code: "P004", name: "Bandra Medical Stores" }, medicine: { brandName: "Cetzine", code: "M008" } });
  });

  it("live state for other medicines does not leak into a search that did not ask for them", async () => {
    await state.apply(added("P004", "M008", 20, 22.88));
    expect((await crocin()).every((r) => r.pharmacy.code !== undefined)).toBe(true);
    const body = await search("Crocin 500mg");
    expect(body.data.every((r: { medicine: { code: string } }) => r.medicine.code === "M001")).toBe(true);
  });

  it("an older event arriving late does not overwrite newer live stock", async () => {
    const older = sale("P002", 11);
    const newer = sale("P002", 5);
    await state.apply(newer);
    await state.apply(older);
    expect(row(await crocin(), "P002")?.quantity).toBe(5);
  });

  it("falls back to the catalogue, without an error, when Redis is down", async () => {
    const dead = createRedis({ url: "redis://127.0.0.1:1", failFast: true, commandTimeoutMs: 200, onError: () => undefined });
    try {
      const down = await build(new RedisLiveStock(dead, { keyPrefix: prefix, timeoutMs: 300 }));
      const started = Date.now();
      const res = await get(`/api/search?q=Crocin+500mg&${WEST}`, down);
      expect(res.statusCode).toBe(200);
      expect(res.json().meta.live).toBe(false);
      expect(res.json().data).toHaveLength(5);
      expect(res.json().data.every((r: { source: string }) => r.source === "catalogue")).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      dead.disconnect();
    }
  });

  it("a Redis that never answers cannot make search wait", async () => {
    const hanging = { hgetall: () => new Promise(() => undefined), smembers: () => new Promise(() => undefined), ping: () => new Promise(() => undefined) } as unknown as Redis;
    const slow = await build(new RedisLiveStock(hanging, { timeoutMs: 100 }));
    const started = Date.now();
    const res = await get(`/api/search?q=Crocin+500mg&${WEST}`, slow);
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.live).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("health reports live stock separately and never fails because of it", async () => {
    expect((await get("/api/health")).json()).toEqual({ status: "ok", checks: { database: "up", live: "up" } });
    const dead = createRedis({ url: "redis://127.0.0.1:1", failFast: true, commandTimeoutMs: 200, onError: () => undefined });
    try {
      const down = await build(new RedisLiveStock(dead, { timeoutMs: 200 }));
      const res = await get("/api/health", down);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ok", checks: { database: "up", live: "down" } });
    } finally {
      dead.disconnect();
    }
  });
});

describe("filters and sorting", () => {
  it("inStock drops sold-out pharmacies", async () => {
    const rows = await crocin("inStock=true");
    expect(rows.map((r) => r.pharmacy.code).sort()).toEqual(["P001", "P002", "P003", "P005"]);
    expect(rows.every((r) => r.quantity > 0)).toBe(true);
  });

  it("maxDistanceKm and maxPrice narrow the results", async () => {
    // P001, P003 and P004 have verified locations. A distance limit keeps verified pharmacies inside it and drops the ones whose distance cannot be established.
    const near = await crocin("maxDistanceKm=20");
    expect(near.map((r) => r.pharmacy.code).sort()).toEqual(["P001", "P003", "P004"]);
    expect((await crocin("maxDistanceKm=3")).map((r) => r.pharmacy.code)).toEqual(["P001"]); // 0.67 km; P003 is 4.1 km and P004 9 km away
    const cheap = await crocin("maxPrice=25");
    expect(cheap.every((r) => r.price <= 25)).toBe(true);
    expect(cheap.length).toBeLessThan(5);
  });

  it("filters act on live stock, not the catalogue", async () => {
    await state.apply(sale("P002", 0));
    expect(row(await crocin("inStock=true"), "P002")).toBeUndefined();
    await state.apply(restock("P004", 9));
    expect(row(await crocin("inStock=true"), "P004")).toBeDefined();
  });

  it("sort=distance orders by distance, sort=price by price, sort=stock by quantity, sold-out last", async () => {
    const byDistance = (await search("Crocin 500mg", "sort=distance")).data as { distanceKm: number | null; quantity: number }[];
    const inStockDistances = byDistance.filter((r) => r.quantity > 0).map((r) => r.distanceKm);
    // Known distances come first, nearest first; pharmacies with no verified distance follow.
    const known = inStockDistances.filter((d): d is number => d !== null);
    expect(known.length).toBeGreaterThan(1);
    expect(inStockDistances).toEqual([...[...known].sort((a, b) => a - b), ...inStockDistances.filter((d) => d === null)]);
    expect(byDistance.at(-1)!.quantity).toBe(0);

    const byPrice = (await search("Crocin 500mg", "sort=price")).data as { price: number; quantity: number }[];
    const prices = byPrice.filter((r) => r.quantity > 0).map((r) => r.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));

    const byStock = (await search("Crocin 500mg", "sort=stock")).data as { quantity: number }[];
    expect(byStock.map((r) => r.quantity)).toEqual([40, 25, 3, 1, 0]);
  });

  it("rank follows the order shown, whatever the sort", async () => {
    const rows = (await search("Crocin 500mg", "sort=price")).data as { rank: number }[];
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("echoes the filters in meta and rejects nonsense", async () => {
    const body = await search("Crocin 500mg", "inStock=1&maxDistanceKm=8&sort=price");
    expect(body.meta).toMatchObject({ sort: "price", filters: { inStock: true, maxDistanceKm: 8, maxPrice: null } });
    for (const bad of ["inStock=maybe", "maxPrice=-1", "maxDistanceKm=0", "sort=cheapest"]) {
      const res = await get(`/api/search?q=crocin&${WEST}&${bad}`);
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it("filters that remove everything give an empty list, not an error", async () => {
    expect(await crocin("maxPrice=1")).toEqual([]);
  });
});

describe("GET /api/medicines/:id/substitutes", () => {
  const idOf = async (code: string) => Number((await db.query("SELECT id FROM medicines WHERE code = $1", [code])).rows[0].id);
  const subs = async (code: string, extra = "") => get(`/api/medicines/${await idOf(code)}/substitutes?${WEST}${extra}`);

  it("suggests other medicines with the same active ingredient that can be bought nearby", async () => {
    const res = await subs("M001"); // Crocin 500mg tablet (Paracetamol)
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const names = body.data.map((s: { medicine: { brandName: string } }) => s.medicine.brandName).sort();
    expect(names).toEqual(["Calpol", "Dolo"]);
    expect(body.meta.medicine).toMatchObject({ brandName: "Crocin", genericName: "Paracetamol" });
    expect(body.meta.notice).toMatch(/pharmacist or your doctor/);
    const dolo = body.data.find((s: { medicine: { brandName: string } }) => s.medicine.brandName === "Dolo");
    expect(dolo).toMatchObject({ sameStrength: false, sameForm: true });
    expect(dolo.best.stockStatus).not.toBe("OUT_OF_STOCK");
    expect(dolo.pharmaciesInStock).toBeGreaterThan(0);
    const calpol = body.data.find((s: { medicine: { brandName: string } }) => s.medicine.brandName === "Calpol");
    expect(calpol).toMatchObject({ sameStrength: false, sameForm: false });
  });

  it("puts the closest match (same form) before the others", async () => {
    const body = (await subs("M001")).json();
    expect(body.data[0].medicine.brandName).toBe("Dolo");
  });

  it("never suggests the medicine itself, or a different ingredient", async () => {
    const names = (await subs("M001")).json().data.map((s: { medicine: { code: string } }) => s.medicine.code);
    expect(names).not.toContain("M001");
    expect(names).not.toContain("M004"); // Combiflam: ibuprofen + paracetamol is a different ingredient
  });

  it("leaves out an alternative nobody has in stock", async () => {
    await db.query("UPDATE inventory SET quantity = 0 WHERE medicine_id = (SELECT id FROM medicines WHERE code = 'M002')");
    const names = (await subs("M001")).json().data.map((s: { medicine: { brandName: string } }) => s.medicine.brandName);
    expect(names).toEqual(["Calpol"]);
  });

  it("uses live stock: an alternative that just sold out everywhere is dropped", async () => {
    const dolo = await db.query("SELECT p.code FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id WHERE i.medicine_id = (SELECT id FROM medicines WHERE code = 'M002') AND i.quantity > 0");
    for (const r of dolo.rows) await state.apply(sale(r.code, 0, "M002"));
    const names = (await subs("M001")).json().data.map((s: { medicine: { brandName: string } }) => s.medicine.brandName);
    expect(names).not.toContain("Dolo");
  });

  it("an empty list when there is no other medicine with that ingredient", async () => {
    const res = await subs("M012"); // Glycomet (Metformin): the only one
    expect(res.json()).toMatchObject({ data: [], meta: { count: 0 } });
  });

  it("404 for an unknown medicine, 400 for a missing or bad location", async () => {
    expect((await get(`/api/medicines/999999/substitutes?${WEST}`)).statusCode).toBe(404);
    expect((await get(`/api/medicines/${await idOf("M001")}/substitutes`)).statusCode).toBe(400);
    expect((await get(`/api/medicines/${await idOf("M001")}/substitutes?lat=abc&lng=1`)).statusCode).toBe(400);
    expect((await get(`/api/medicines/abc/substitutes?${WEST}`)).statusCode).toBe(400);
  });
});

describe("pharmacy pages", () => {
  const idOf = async (code: string) => Number((await db.query("SELECT id FROM pharmacies WHERE code = $1", [code])).rows[0].id);
  const stock = async (code: string, extra = "") => (await get(`/api/pharmacies/${await idOf(code)}/stock${extra ? "?" + extra : ""}`)).json();

  it("lists the pharmacies with their codes", async () => {
    const body = (await get("/api/pharmacies")).json();
    expect(body.data.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(["P001", "P002", "P003", "P004", "P005"]));
  });

  it("returns one pharmacy, with the distance when a location is given", async () => {
    const id = await idOf("P001");
    const plain = (await get(`/api/pharmacies/${id}`)).json().data;
    expect(plain).toMatchObject({ code: "P001", name: "Paras Medical and General Store", distanceKm: null, demo: true, independent: true, locationVerified: true, inventorySimulated: true });
    // No location given: no distance. With one, P001 (verified from its OpenStreetMap node) gets a real one, about 0.7 km from Andheri West...
    expect((await get(`/api/pharmacies/${id}?${WEST}`)).json().data.distanceKm).toBeCloseTo(0.67, 1);
    // ...P002 (Roopam) has no verified point, so none is claimed even when a location is given...
    const roopam = (await get(`/api/pharmacies/${await idOf("P002")}?${WEST}`)).json().data;
    expect(roopam).toMatchObject({ code: "P002", locationVerified: false, distanceKm: null });
    // ...and P004 (Bandra Medical Stores) has a verified point and gets one.
    const bandra = (await get(`/api/pharmacies/${await idOf("P004")}?${WEST}`)).json().data;
    expect(bandra).toMatchObject({ name: "Bandra Medical Stores", locationVerified: true, latitude: 19.05548, longitude: 72.83152 });
    expect(bandra.distanceKm).toBeCloseTo(9.0, 1);
    expect((await get("/api/pharmacies/999999")).statusCode).toBe(404);
    expect((await get("/api/pharmacies/abc")).statusCode).toBe(400);
  });

  it("lists everything the pharmacy stocks, with a summary", async () => {
    const body = await stock("P001");
    expect(body.meta.total).toBe(14); // 15 medicines, one not carried
    expect(body.meta.live).toBe(true);
    expect(body.meta.summary.inStock + body.meta.summary.lowStock + body.meta.summary.outOfStock).toBe(14);
    const names = body.data.map((i: { medicine: { brandName: string } }) => i.medicine.brandName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(body.data.find((i: { medicine: { code: string } }) => i.medicine.code === "M001")).toMatchObject({ quantity: 1, stockStatus: "LOW_STOCK", source: "catalogue" });
  });

  it("filters by name and availability", async () => {
    expect((await stock("P001", "q=croc")).data).toHaveLength(1);
    expect((await stock("P001", "q=paracetamol")).data.length).toBeGreaterThan(1); // by generic name
    expect((await stock("P001", "q=zzzz")).data).toEqual([]);
    const inStock = await stock("P001", "inStock=true");
    expect(inStock.data.every((i: { quantity: number }) => i.quantity > 0)).toBe(true);
    expect(inStock.meta.total).toBe(14);
  });

  it("shows live stock: a sale, a restock, a removal and an addition", async () => {
    await state.apply(sale("P001", 0));
    await state.apply(restock("P001", 77, "M002"));
    await state.apply(removed("P001", "M005"));
    await state.apply(added("P001", "M012", 9, 31)); // P001 does not carry M012 (Glycomet)
    const body = await stock("P001");
    const by = (code: string) => body.data.find((i: { medicine: { code: string } }) => i.medicine.code === code);
    expect(by("M001")).toMatchObject({ quantity: 0, stockStatus: "OUT_OF_STOCK", source: "live" });
    expect(by("M002")).toMatchObject({ quantity: 77, source: "live" });
    expect(by("M005")).toBeUndefined();
    expect(by("M012")).toMatchObject({ quantity: 9, price: 31, source: "live" });
    expect(body.meta.total).toBe(14); // -1 removed, +1 added
  });

  it("does not show another pharmacy's live stock", async () => {
    await state.apply(sale("P002", 0));
    expect((await stock("P001")).data.find((i: { medicine: { code: string } }) => i.medicine.code === "M001").source).toBe("catalogue");
  });

  it("falls back to the catalogue when Redis is down", async () => {
    const dead = createRedis({ url: "redis://127.0.0.1:1", failFast: true, commandTimeoutMs: 200, onError: () => undefined });
    try {
      const down = await build(new RedisLiveStock(dead, { timeoutMs: 300 }));
      const res = await get(`/api/pharmacies/${await idOf("P001")}/stock`, down);
      expect(res.statusCode).toBe(200);
      expect(res.json().meta).toMatchObject({ live: false, total: 14 });
    } finally {
      dead.disconnect();
    }
  });

  it("validates the query", async () => {
    expect((await get(`/api/pharmacies/${await idOf("P001")}/stock?inStock=maybe`)).statusCode).toBe(400);
    expect((await get("/api/pharmacies/999999/stock")).statusCode).toBe(404);
  });
});
