/**
 * The expanded catalogue through the search API. The catalogue says a product EXISTS and can be found; whether a
 * pharmacy has it, and how many, comes only from that pharmacy's inventory rows (here inserted directly, as the sync
 * service's mirror would write them: test data only).
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { directoryPharmacies, importCatalogue, readCatalogueBatch, seed, type CatalogueRecord, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { parseMedicineQuery } from "../src/modules/medicines/query.js";
import { searchMedicines } from "../src/modules/medicines/repo.js";

let db: Db;
let app: FastifyInstance;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
const verified = readCatalogueBatch().records.filter((r): r is CatalogueRecord => r.status === "verified");
const WEST = "lat=19.1364&lng=72.8296";

beforeAll(async () => {
  db = await freshSeededDb();
  await importCatalogue(db, readCatalogueBatch());
  app = await buildApp(db, config, { logger: false });
});
beforeEach(async () => {
  await seed(db); // resets the seeded stock only; catalogue rows stay
  await db.query("DELETE FROM inventory WHERE medicine_id IN (SELECT id FROM medicines WHERE code > 'M015')");
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const codeOf = async (brand: string, dosage?: string) =>
  (await db.query<{ code: string }>("SELECT code FROM medicines WHERE brand_name = $1 AND ($2::text IS NULL OR dosage = $2)", [brand, dosage ?? null])).rows[0]!.code;

/** Test-only stock for a catalogue product at a pharmacy. */
async function stock(pharmacy: string, medicine: string, quantity: number, price: number) {
  await db.query(
    `INSERT INTO inventory (pharmacy_id, medicine_id, quantity, price)
     SELECT p.id, m.id, $3, $4 FROM pharmacies p, medicines m WHERE p.code = $1 AND m.code = $2`,
    [pharmacy, medicine, quantity, price],
  );
}
interface Row {
  pharmacy: { code: string };
  medicine: { code: string; brandName: string; genericName: string; dosage: string; form: string };
  quantity: number;
  price: number;
  stockStatus: string;
  source: string;
}
const search = async (q: string, extra = "") => {
  const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${WEST}${extra}` });
  return { status: res.statusCode, rows: res.json().data as Row[], meta: res.json().meta };
};
const find = async (q: string) => (await searchMedicines(db, parseMedicineQuery(q), 50)).map((m) => m.code);

describe("every catalogued product can be found", () => {
  it("by its own name, and by its name with its strength", async () => {
    const misses: string[] = [];
    for (const r of verified) {
      if (!(await find(r.brand)).includes(r.code)) misses.push(`${r.brand}`);
      if (!(await find(`${r.brand} ${r.dosage}`)).includes(r.code)) misses.push(`${r.brand} ${r.dosage}`);
    }
    expect(misses).toEqual([]);
  });

  it("through the generic name, which lists the brands and the generic product together", async () => {
    const montair = await codeOf("Montair-LC");
    const generic = verified.find((r) => r.kind === "generic" && r.brand === "Montelukast + Levocetirizine")!;
    const codes = await find("levocetirizine");
    expect(codes).toContain(montair);
    expect(codes).toContain(generic.code);
    expect(codes).toContain(await codeOf("Levocet"));
  });

  it("whatever the case or spacing, and with a space where the name has a hyphen", async () => {
    const retaunch = await codeOf("Retaunch");
    expect(await find("retaunch")).toEqual([retaunch]);
    expect(await find("  RETAUNCH  ")).toEqual([retaunch]);
    expect(await find("Retaunch 150 mg")).toEqual([retaunch]); // any component of the strength matches, as for Combiflam
    expect(await find("Retaunch 300mg")).toEqual([]);
    expect(await find("Retaunch 150mg/500mg")).toEqual([retaunch]);
    expect(await find("montair lc")).toContain(await codeOf("Montair-LC"));
    expect(await find("zerodol sp")).toContain(await codeOf("Zerodol-SP"));
  });

  it("keeps strengths and similar-looking names apart", async () => {
    const omez20 = await codeOf("Omez", "20mg");
    const omez40 = await codeOf("Omez", "40mg");
    expect(await find("Omez")).toEqual(expect.arrayContaining([omez20, omez40]));
    expect(await find("Omez 40mg")).toEqual([omez40]);
    expect(await find("Omez 20mg")).toEqual([omez20]);
    // Four brands of one formula: each name finds only itself.
    for (const brand of ["Retaunch", "Nefrosave", "Nefrozon", "Renosave"]) expect(await find(brand)).toEqual([await codeOf(brand)]);
    // Cefixime 200 mg from three companies are three products.
    expect((await find("cefixime")).length).toBeGreaterThanOrEqual(3);
  });

  it("does not invent anything for unknown or held-back names", async () => {
    expect(await find("Viotace")).toEqual([]);
    expect(await find("zzzznotamedicine")).toEqual([]);
    const { status, rows } = await search("Viotace");
    expect(status).toBe(200);
    expect(rows).toEqual([]);
  });
});

describe("catalogue presence is not stock", () => {
  it("a catalogued product nobody stocks gives no results at all", async () => {
    const { status, rows } = await search("Retaunch");
    expect(status).toBe(200);
    expect(rows).toEqual([]);
  });

  it("a product stocked by one pharmacy shows only that pharmacy and what it reports", async () => {
    const code = await codeOf("Retaunch");
    await stock("P002", code, 12, 184.5);
    const { rows } = await search("Retaunch");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pharmacy: { code: "P002" }, quantity: 12, price: 184.5, stockStatus: "IN_STOCK", source: "catalogue" });
    expect(rows[0]!.medicine).toMatchObject({ code, brandName: "Retaunch", genericName: "N-Acetylcysteine + Taurine", dosage: "150mg/500mg" });
  });

  it("a product stocked by several pharmacies shows each one's own quantity, price and status", async () => {
    const code = await codeOf("Veenat");
    await stock("P001", code, 2, 410);
    await stock("P003", code, 30, 395.25);
    await stock("P005", code, 0, 402);
    const { rows } = await search("Veenat 400mg");
    const by = Object.fromEntries(rows.map((r) => [r.pharmacy.code, r]));
    expect(Object.keys(by).sort()).toEqual(["P001", "P003", "P005"]);
    expect(by.P001).toMatchObject({ quantity: 2, price: 410, stockStatus: "LOW_STOCK" });
    expect(by.P003).toMatchObject({ quantity: 30, price: 395.25, stockStatus: "IN_STOCK" });
    expect(by.P005).toMatchObject({ quantity: 0, price: 402, stockStatus: "OUT_OF_STOCK" });
    // Not stocked at P002 / P004: absent, never guessed.
    const only = await search("Veenat 400mg", "&inStock=true");
    expect(only.rows.map((r) => r.pharmacy.code).sort()).toEqual(["P001", "P003"]);
  });

  it("stock of one product never appears under a similar-looking one", async () => {
    await stock("P001", await codeOf("Retaunch"), 9, 100);
    expect((await search("Nefrosave")).rows).toEqual([]);
    expect((await search("N-Acetylcysteine")).rows.map((r) => r.medicine.brandName)).toEqual(["Retaunch"]);
  });

  it("existing medicines are unaffected by the import", async () => {
    const { rows } = await search("Crocin 500mg");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.quantity).sort((a, b) => a - b)).toEqual([0, 1, 3, 25, 40]);
    expect((await search("Cetzine")).rows.length).toBeGreaterThan(0);
    // Telma 40 and Dolo 650 were both seeded and listed in the batch: still one product each.
    expect((await db.query("SELECT 1 FROM medicines WHERE brand_name IN ('Telma', 'Dolo')")).rowCount).toBe(2);
  });
});

describe("catalogue matches in the search response", () => {
  interface Match { medicine: { id: number; code: string; brandName: string; dosage: string }; listed: boolean }
  const matchesOf = async (q: string, extra = "") => {
    const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${WEST}${extra}` });
    return { data: res.json().data as Row[], matches: res.json().meta.matches as Match[], meta: res.json().meta };
  };

  it("a catalogued medicine nobody lists comes back as a match with listed=false and no offers", async () => {
    const { data, matches } = await matchesOf("Retaunch");
    expect(data).toEqual([]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ listed: false, medicine: { code: await codeOf("Retaunch"), brandName: "Retaunch", dosage: "150mg/500mg" } });
    expect(Object.keys(matches[0]!).sort()).toEqual(["listed", "medicine"]); // no quantity, price or pharmacy
  });

  it("offers keep their pharmacy, price, quantity and freshness, and the match is listed", async () => {
    const code = await codeOf("Veenat");
    await stock("P001", code, 3, 410);
    await stock("P003", code, 0, 395.25);
    const { data, matches } = await matchesOf("Veenat");
    expect(data.map((r) => [r.pharmacy.code, r.quantity, r.price, r.stockStatus]).sort()).toEqual([["P001", 3, 410, "LOW_STOCK"], ["P003", 0, 395.25, "OUT_OF_STOCK"]]);
    expect(data.every((r) => !Number.isNaN(Date.parse((r as unknown as { updatedAt: string }).updatedAt)))).toBe(true);
    expect(matches).toMatchObject([{ listed: true, medicine: { code } }]);
  });

  it("listed means listed by someone, even at zero stock, and is unaffected by filters that hide the offers", async () => {
    const code = await codeOf("Veenat");
    await stock("P005", code, 0, 402);
    const filtered = await matchesOf("Veenat", "&inStock=true");
    expect(filtered.data).toEqual([]);
    expect(filtered.matches).toMatchObject([{ listed: true, medicine: { code } }]);
    const far = await matchesOf("Veenat", "&maxDistanceKm=0.01");
    expect(far.data).toEqual([]);
    expect(far.matches[0]!.listed).toBe(true);
  });

  it("several catalogue matches are all returned, each with its own listed flag", async () => {
    await stock("P002", await codeOf("Nefrosave"), 5, 150);
    const { data, matches } = await matchesOf("N-Acetylcysteine");
    const byBrand = Object.fromEntries(matches.map((m) => [m.medicine.brandName, m.listed]));
    expect(byBrand).toMatchObject({ Retaunch: false, Nefrosave: true, Nefrozon: false, Renosave: false });
    expect(Object.keys(byBrand).sort()).toEqual(["Nefrosave", "Nefrozon", "Renosave", "Retaunch"]); // all four brands of the formula, none dropped
    expect(data.map((r) => r.medicine.brandName)).toEqual(["Nefrosave"]);
  });

  it("no catalogue match is an empty list, not an error", async () => {
    const { data, matches, meta } = await matchesOf("Viotace");
    expect(data).toEqual([]);
    expect(matches).toEqual([]);
    expect(meta.count).toBe(0);
  });

  it("matching is the existing matching: strength and form still narrow it, and existing medicines keep their offers", async () => {
    expect((await matchesOf("Omez 40mg")).matches.map((m) => m.medicine.dosage)).toEqual(["40mg"]);
    expect((await matchesOf("Omez capsule")).matches).toHaveLength(2);
    expect((await matchesOf("Omez tablet")).matches).toEqual([]);
    const crocin = await matchesOf("Crocin 500mg");
    expect(crocin.data).toHaveLength(5);
    expect(crocin.matches).toMatchObject([{ listed: true, medicine: { brandName: "Crocin" } }]);
  });

  it("the response keeps every field existing clients read", async () => {
    await stock("P001", await codeOf("Veenat"), 9, 400);
    const { data, meta } = await matchesOf("Veenat");
    expect(Object.keys(data[0]!)).toEqual(expect.arrayContaining(["rank", "score", "scoreBreakdown", "medicine", "pharmacy", "quantity", "price", "stockStatus", "distanceKm", "updatedAt", "source"]));
    expect(Object.keys(meta)).toEqual(expect.arrayContaining(["count", "weights", "live", "sort", "filters"]));
  });
});

describe("directory pharmacies in the search API", () => {
  const dir = directoryPharmacies();
  const bandra = dir.find((p) => p.name === "Bandra Medical Stores")!;
  const unverified = dir.find((p) => p.code === "P006")!; // Mahavir Chemist: its map point is not verified
  const point = bandra.location as { latitude: number; longitude: number };
  // Test-only central rows (the real P004 stays a fictional pharmacy until an approved replacement): one with a verified point
  // (the real Bandra Medical Stores point, under a test ID that is not in the registry, so not a demo listing) and one for the unverified P006.
  const FIXTURES = [
    { code: "P090", name: "Test Chemist (verified point)", address: bandra.address, latitude: point.latitude, longitude: point.longitude },
    { code: "P006", name: unverified.name, address: unverified.address, latitude: 19.2447426, longitude: 72.8515683 },
  ];
  type Offer = Row & { distanceKm: number; pharmacy: { code: string; name: string; address: string; latitude: number; longitude: number; demo: boolean; independent: boolean; locationVerified: boolean } };
  const HERE = `lat=${point.latitude}&lng=${point.longitude}`;

  beforeAll(async () => {
    await db.query("DELETE FROM pharmacies WHERE code > 'P005'");
    for (const f of FIXTURES) await db.query("INSERT INTO pharmacies (code, name, address, latitude, longitude) VALUES ($1, $2, $3, $4, $5)", [f.code, f.name, f.address, f.latitude, f.longitude]);
  });
  afterAll(async () => {
    await db.query("DELETE FROM pharmacies WHERE code > 'P005'");
  });

  const near = async (q: string) => (await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&${HERE}&sort=distance` })).json().data as Offer[];

  it("sends each pharmacy's own identity, address, location and demo flags, and says when the point is not verified", async () => {
    const veenat = await codeOf("Veenat");
    await stock("P090", veenat, 12, 401.5);
    await stock("P006", veenat, 3, 389);
    const results = await near("Veenat");
    const by = Object.fromEntries(results.map((r) => [r.pharmacy.code, r]));
    expect(by.P090).toMatchObject({ quantity: 12, price: 401.5, distanceKm: 0, pharmacy: { name: FIXTURES[0]!.name, address: bandra.address, latitude: point.latitude, longitude: point.longitude, demo: false, independent: false, locationVerified: true } });
    expect(by.P006).toMatchObject({ quantity: 3, price: 389, pharmacy: { name: unverified.name, demo: true, independent: true, locationVerified: false } });
  });

  it("keeps each pharmacy's stock separate from the others and from the original five", async () => {
    await stock("P006", await codeOf("Retaunch"), 4, 351);
    const rows = await near("Retaunch");
    expect(rows.map((r) => r.pharmacy.code)).toEqual(["P006"]);
    expect((await near("Crocin 500mg")).map((r) => r.pharmacy.code).sort()).toEqual(["P001", "P002", "P003", "P004", "P005"]);
  });

  it("shows P001 to P005 under their directory identities while the persisted rows stay the fictional demo pharmacies", async () => {
    type P = { code: string; name: string; address: string; latitude: number; longitude: number; demo: boolean; independent: boolean; locationVerified: boolean; inventorySimulated: boolean };
    const res = (await app.inject({ method: "GET", url: "/api/pharmacies" })).json().data as P[];
    const by = Object.fromEntries(res.map((p) => [p.code, p]));
    const expected: Record<string, [string, string, boolean]> = {
      P001: ["Paras Medical and General Store", "35/D-2, Vaibhav CHS, SVP Nagar, Versova, Andheri West, Mumbai, Maharashtra 400053", false],
      P002: ["Roopam Medical and General Stores", "Shop 8, Shopping Centre, 18-A M.M. Road, Bhavani Nagar, Marol, Andheri East, Mumbai, Maharashtra 400059", false],
      P003: ["United Medical and General Stores", "Chakala, Andheri East, Mumbai, Maharashtra 400099", false],
      P004: ["Bandra Medical Stores", "Shop 139, Hill Road, near Union Bank of India, Bandra West, Mumbai, Maharashtra 400050", true],
      P005: ["Faiza Medical and General Stores", "Shop 19, near Mina Centre, Ahmed Zakaria Nagar, Bandra East, Mumbai, Maharashtra 400051", false],
    };
    for (const [code, [name, address, verified]] of Object.entries(expected)) {
      expect(by[code], code).toMatchObject({ name, address, demo: true, independent: true, locationVerified: verified, inventorySimulated: true });
    }
    expect(by.P004).toMatchObject({ latitude: 19.05548, longitude: 72.83152 }); // the only verified point
    expect(JSON.stringify(res)).not.toMatch(/Pharmacy [A-E] -/); // no stale fictional name in the API output
    // The persisted rows are untouched.
    const persisted = (await db.query("SELECT code, name FROM pharmacies WHERE code <= 'P005' ORDER BY code")).rows.map((r) => r.name);
    expect(persisted).toEqual(["Pharmacy A - Andheri West", "Pharmacy B - Andheri East", "Pharmacy C - Juhu", "Pharmacy D - Bandra West", "Pharmacy E - Powai"]);
    expect(res.find((p) => p.code === "P006")).toMatchObject({ demo: true, independent: true, locationVerified: false, inventorySimulated: true });
  });
});
