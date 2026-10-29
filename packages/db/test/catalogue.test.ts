import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  importCatalogue,
  readCatalogueBatch,
  seed,
  validateRecord,
  type CatalogueBatch,
  type CatalogueRecord,
  type Db,
  type ReviewRecord,
} from "../src/index.js";
import { MEDICINES } from "../src/seed-data.js";
import { freshSeededDb } from "../src/testing.js";

let db: Db;
const batch = readCatalogueBatch();
const verified = batch.records.filter((r): r is CatalogueRecord => r.status === "verified");
const review = batch.records.filter((r): r is ReviewRecord => r.status === "needs-review");

beforeAll(async () => {
  db = await freshSeededDb();
});
beforeEach(async () => {
  // Back to the 15 seeded medicines and their stock: each test imports what it needs.
  await db.query("DELETE FROM medicines WHERE code NOT IN (SELECT code FROM medicines ORDER BY id LIMIT 15)");
  await seed(db);
});
afterAll(async () => {
  await db.end();
});

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;
const count = async (table: string) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).n);
const inventorySnapshot = async () => (await db.query("SELECT pharmacy_id, medicine_id, quantity, price::text AS price, updated_at FROM inventory ORDER BY id")).rows;
const rec = (over: Partial<CatalogueRecord>): CatalogueRecord => ({
  code: "M900",
  kind: "brand",
  brand: "Testmed",
  generic: "Testgeneric",
  dosage: "10mg",
  form: "tablet",
  status: "verified",
  sources: ["https://example.test/testmed"],
  verification: "retail-listings",
  ...over,
});
const tiny = (...records: Array<CatalogueRecord | ReviewRecord>): CatalogueBatch => ({ batch: "test", sources: {}, records });

describe("the shipped catalogue batch", () => {
  it("is a substantial batch of well-formed, verified records", () => {
    expect(verified.length).toBeGreaterThanOrEqual(100);
    expect(verified.length).toBeLessThanOrEqual(200);
    for (const r of verified) expect(validateRecord(r), `${r.brand} ${r.dosage}`).toBeNull();
  });

  it("has no duplicate products and no duplicate codes, and leaves the demo medicines' identities alone", () => {
    const variants = verified.map((r) => `${r.brand}|${r.dosage}|${r.form}`.toLowerCase());
    expect(new Set(variants).size).toBe(variants.length);
    const codes = verified.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of verified) {
      const seeded = MEDICINES.find((m) => m.code === r.code);
      if (seeded) expect([seeded.brand, seeded.dosage, seeded.form]).toEqual([r.brand, r.dosage, r.form]);
    }
  });

  it("covers common and specialty categories, and both brands and generics", () => {
    const categories = new Set(verified.map((r) => r.category));
    for (const c of ["Pain and fever", "Allergy", "Gastrointestinal", "Respiratory", "Dermatology and trichology", "Endocrinology and chronic care", "Fertility and reproductive health", "Neurology and psychiatry", "Gastroenterology and hepatology", "Oncology", "Hospital and specialty", "Vitamins and nutrition"]) {
      expect(categories, c).toContain(c);
    }
    expect(verified.some((r) => r.kind === "generic")).toBe(true);
    expect(verified.filter((r) => r.kind === "brand").length).toBeGreaterThan(50);
  });

  it("records where each product comes from and how it was verified", () => {
    for (const r of verified) {
      expect(r.sources.every((s) => s.startsWith("https://"))).toBe(true);
      expect(Object.keys(batch.sources)).toContain(r.verification);
    }
    // Generics are taken from the official PMBJP list and cite its drug code.
    for (const r of verified.filter((x) => x.kind === "generic")) {
      expect(r.verification).toBe("official-list");
      expect(r.evidence).toMatch(/^PMBJP drug code \d+$/);
    }
  });

  it("keeps brand-versus-generic and strength/form distinctions", () => {
    const find = (brand: string) => verified.filter((r) => r.brand === brand);
    // Different strengths are different products.
    expect(find("Omez").map((r) => r.dosage).sort()).toEqual(["20mg", "40mg"]);
    // A brand points at its generic, and the generic exists as its own product with the same generic name.
    const montair = find("Montair-LC")[0]!;
    const generic = verified.find((r) => r.kind === "generic" && r.generic === montair.generic && r.dosage === montair.dosage)!;
    expect(generic.code).not.toBe(montair.code);
    // Several brands of one formula stay separate products.
    expect(["Retaunch", "Nefrosave", "Nefrozon", "Renosave"].map((b) => find(b)[0]?.generic)).toEqual(Array(4).fill("N-Acetylcysteine + Taurine"));
  });

  it("imports Retaunch (listed by several pharmacies) and holds Viotace for manual verification", () => {
    const retaunch = verified.find((r) => r.brand === "Retaunch")!;
    expect(retaunch).toMatchObject({ generic: "N-Acetylcysteine + Taurine", dosage: "150mg/500mg", form: "tablet", manufacturer: "Medigen Life Sciences" });
    expect(retaunch.sources.length).toBeGreaterThanOrEqual(3);

    expect(verified.find((r) => /viotace/i.test(r.brand))).toBeUndefined();
    const viotace = review.find((r) => r.brand === "Viotace")!;
    expect(viotace.reason).toMatch(/manual|confirmed/i);
  });
});

describe("importCatalogue", () => {
  it("adds the batch to medicines, reporting imported, matched, skipped and rejected records", async () => {
    const before = await count("medicines");
    const report = await importCatalogue(db, batch);
    expect(report.rejected).toEqual([]);
    expect(report.skipped.map((s) => s.name)).toContain("Viotace");
    // Dolo 650 (M002) and Telma 40 (M013) are already seeded: matched, not duplicated.
    expect(report.matched.map((m) => m.code).sort()).toEqual(["M002", "M013"]);
    expect(report.imported).toHaveLength(verified.length - 2);
    expect(await count("medicines")).toBe(before + verified.length - 2);

    const retaunch = await one("SELECT code, brand_name, generic_name, dosage, form FROM medicines WHERE brand_name = 'Retaunch'");
    expect(retaunch).toMatchObject({ generic_name: "N-Acetylcysteine + Taurine", dosage: "150mg/500mg", form: "tablet" });
    expect(await count("medicines WHERE brand_name ILIKE 'viotace%'")).toBe(0);
  });

  it("is idempotent: a second run imports nothing and changes nothing", async () => {
    await importCatalogue(db, batch);
    const snapshot = (await db.query("SELECT id, code, brand_name, generic_name, dosage, form, created_at FROM medicines ORDER BY id")).rows;
    const again = await importCatalogue(db, batch);
    expect(again.imported).toEqual([]);
    expect(again.matched).toHaveLength(verified.length);
    expect(again.rejected).toEqual([]);
    expect((await db.query("SELECT id, code, brand_name, generic_name, dosage, form, created_at FROM medicines ORDER BY id")).rows).toEqual(snapshot);
  });

  it("catalogue presence is not stock: pharmacy inventory is untouched and new products have none", async () => {
    const stock = await inventorySnapshot();
    await importCatalogue(db, batch);
    expect(await inventorySnapshot()).toEqual(stock);
    expect(await count("inventory WHERE medicine_id IN (SELECT id FROM medicines WHERE code > 'M015')")).toBe(0);
    await importCatalogue(db, batch);
    expect(await inventorySnapshot()).toEqual(stock);
  });

  it("a dry run reports what would happen and changes nothing, not even the id sequence", async () => {
    const sequence = async () =>
      (await one("SELECT last_value::text AS last, is_called FROM medicines_id_seq")) as { last: string; is_called: boolean };
    const before = await count("medicines");
    const seqBefore = await sequence();
    const rows = (await db.query("SELECT * FROM medicines ORDER BY id")).rows;
    const dry = await importCatalogue(db, batch, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.imported).toHaveLength(verified.length - 2);
    expect(await count("medicines")).toBe(before);
    expect((await db.query("SELECT * FROM medicines ORDER BY id")).rows).toEqual(rows);
    expect(await sequence()).toEqual(seqBefore);

    // The report is the one a real run gives, and the real run then continues from the same ids.
    const real = await importCatalogue(db, batch);
    expect(real.imported).toEqual(dry.imported);
    expect(real.matched).toEqual(dry.matched);
    expect(real.rejected).toEqual(dry.rejected);
    expect(real.skipped).toEqual(dry.skipped);
    const ids = (await db.query<{ id: string }>("SELECT id FROM medicines WHERE code > 'M015' ORDER BY id")).rows.map((r) => Number(r.id));
    expect(ids[0]).toBe(Number(seqBefore.last) + 1); // the dry run consumed no ids
    expect(ids[ids.length - 1]! - ids[0]!).toBe(ids.length - 1);
  });

  it("a dry run also reports conflicts without writing", async () => {
    const dry = await importCatalogue(db, tiny(rec({ code: "M003" }), rec({ code: "M930", brand: "Fine" })), { dryRun: true });
    expect(dry.rejected[0]!.reason).toMatch(/already belongs to "Calpol"/);
    expect(dry.imported.map((i) => i.code)).toEqual(["M930"]);
    expect(await count("medicines")).toBe(15);
  });

  it("leaves existing records and their identifiers alone (case differences are the same product)", async () => {
    const before = await one("SELECT * FROM medicines WHERE code = 'M001'");
    const report = await importCatalogue(db, tiny(rec({ code: "M001", brand: "CROCIN", generic: "paracetamol", dosage: "500mg", form: "Tablet".toLowerCase() })));
    expect(report.matched).toHaveLength(1);
    expect(report.imported).toEqual([]);
    expect(await one("SELECT * FROM medicines WHERE code = 'M001'")).toEqual(before);
    expect(await count("medicines")).toBe(15);
  });

  it("does not let a seeded product's identity change", async () => {
    const wrongCode = await importCatalogue(db, tiny(rec({ code: "M777", brand: "Crocin", generic: "Paracetamol", dosage: "500mg", form: "tablet" })));
    expect(wrongCode.rejected[0]!.reason).toMatch(/already in the catalogue as M001/);
    const wrongGeneric = await importCatalogue(db, tiny(rec({ code: "M001", brand: "Crocin", generic: "Ibuprofen", dosage: "500mg", form: "tablet" })));
    expect(wrongGeneric.rejected[0]!.reason).toMatch(/never overwritten/);
    expect((await one<{ generic_name: string }>("SELECT generic_name FROM medicines WHERE code = 'M001'")).generic_name).toBe("Paracetamol");
  });

  it("refuses a code that already belongs to another product", async () => {
    const report = await importCatalogue(db, tiny(rec({ code: "M003" })));
    expect(report.rejected[0]!.reason).toMatch(/already belongs to "Calpol"/);
    expect(await count("medicines")).toBe(15);
  });

  it("rejects duplicates inside the batch and keeps the first", async () => {
    const report = await importCatalogue(db, tiny(rec({ code: "M900" }), rec({ code: "M901", brand: "TESTMED" }), rec({ code: "M900", brand: "Other" })));
    expect(report.imported.map((i) => i.code)).toEqual(["M900"]);
    expect(report.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/duplicate of another record/), expect.stringMatching(/code M900 is used by another record/)]);
  });

  it("rejects malformed records without aborting the rest", async () => {
    const bad = [
      rec({ code: "900" }),
      rec({ code: "M902", dosage: "ten milligrams" }),
      rec({ code: "M903", dosage: "10MG" }),
      rec({ code: "M904", brand: "  " }),
      rec({ code: "M905", sources: [] }),
      rec({ code: "M906", sources: ["http://insecure.test"] }),
      rec({ code: "M907", verification: "trust-me" as never }),
      rec({ code: "M908", form: "Tablet" }),
    ];
    const report = await importCatalogue(db, tiny(...bad, rec({ code: "M909", brand: "Fine" })));
    expect(report.rejected).toHaveLength(bad.length);
    expect(report.imported.map((i) => i.code)).toEqual(["M909"]);
  });

  it("normalises whitespace in names", async () => {
    await importCatalogue(db, tiny(rec({ code: "M910", brand: "  Spaced   Name ", generic: "Some   Generic" })));
    expect(await one("SELECT brand_name, generic_name FROM medicines WHERE code = 'M910'")).toEqual({ brand_name: "Spaced Name", generic_name: "Some Generic" });
  });

  it("never imports something flagged for review, and reports it", async () => {
    const report = await importCatalogue(db, tiny({ kind: "brand", brand: "Mystery", status: "needs-review", reason: "unclear" }));
    expect(report.skipped).toEqual([{ name: "Mystery", reason: "unclear" }]);
    expect(await count("medicines")).toBe(15);
  });

  it("is atomic: a database failure part-way leaves nothing behind", async () => {
    await db.query("ALTER TABLE medicines ADD CONSTRAINT test_fail CHECK (brand_name <> 'Boom')");
    try {
      await expect(importCatalogue(db, tiny(rec({ code: "M920", brand: "Fine" }), rec({ code: "M921", brand: "Boom" })))).rejects.toThrow();
      expect(await count("medicines")).toBe(15);
    } finally {
      await db.query("ALTER TABLE medicines DROP CONSTRAINT test_fail");
    }
  });
});
