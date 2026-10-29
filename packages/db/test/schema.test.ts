import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/index.js";
import { migrate, seed } from "../src/index.js";
import { freshSeededDb } from "../src/testing.js";

let db: Db;

beforeAll(async () => {
  db = await freshSeededDb();
});
afterAll(async () => {
  await db.end();
});

const count = async (table: string) =>
  Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

describe("schema", () => {
  it("creates all tables", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(["users", "medicines", "pharmacies", "inventory", "schema_migrations"]));
  });

  it("migrate is idempotent", async () => {
    expect(await migrate(db)).toEqual([]);
  });

  it("rejects duplicate (pharmacy, medicine) inventory rows", async () => {
    await expect(
      db.query(
        `INSERT INTO inventory (pharmacy_id, medicine_id, quantity, price)
         SELECT pharmacy_id, medicine_id, 1, 10 FROM inventory LIMIT 1`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects negative quantity", async () => {
    await expect(db.query("UPDATE inventory SET quantity = -1 WHERE id = (SELECT min(id) FROM inventory)")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("rejects non-positive price", async () => {
    await expect(db.query("UPDATE inventory SET price = 0 WHERE id = (SELECT min(id) FROM inventory)")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("rejects inventory for unknown pharmacy or medicine", async () => {
    await expect(
      db.query("INSERT INTO inventory (pharmacy_id, medicine_id, quantity, price) VALUES (999999, 1, 1, 1)"),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects invalid pharmacy coordinates", async () => {
    await expect(
      db.query("INSERT INTO pharmacies (code, name, address, latitude, longitude) VALUES ('P900','x','y',91,0)"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects duplicate user emails and half-specified user location", async () => {
    await db.query("INSERT INTO users (name, email) VALUES ('A', 'a@example.com')");
    await expect(db.query("INSERT INTO users (name, email) VALUES ('B', 'a@example.com')")).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.query("INSERT INTO users (name, email, latitude) VALUES ('C', 'c@example.com', 10)"),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects duplicate medicine variants", async () => {
    await expect(
      db.query("INSERT INTO medicines (code, brand_name, generic_name, dosage, form) VALUES ('M900','Crocin','Paracetamol','500mg','tablet')"),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("seed data", () => {
  it("populates medicines, pharmacies and inventory", async () => {
    expect(await count("medicines")).toBe(15);
    expect(await count("pharmacies")).toBe(5);
    expect(await count("inventory")).toBeGreaterThan(40);
  });

  it("is idempotent", async () => {
    const before = await count("inventory");
    await seed(db);
    expect(await count("inventory")).toBe(before);
    expect(await count("medicines")).toBe(15);
  });

  it("includes in-stock, low-stock and out-of-stock rows", async () => {
    const { rows } = await db.query<{ out: string; low: string; ok: string }>(
      `SELECT count(*) FILTER (WHERE quantity = 0) AS out,
              count(*) FILTER (WHERE quantity BETWEEN 1 AND 5) AS low,
              count(*) FILTER (WHERE quantity > 5) AS ok
       FROM inventory`,
    );
    expect(Number(rows[0]!.out)).toBeGreaterThan(0);
    expect(Number(rows[0]!.low)).toBeGreaterThan(0);
    expect(Number(rows[0]!.ok)).toBeGreaterThan(0);
  });

  it("sets up the Crocin 500mg demo scenario (Pharmacy A has exactly 1)", async () => {
    const { rows } = await db.query<{ name: string; quantity: number }>(
      `SELECT p.name, i.quantity FROM inventory i
       JOIN pharmacies p ON p.id = i.pharmacy_id
       JOIN medicines m ON m.id = i.medicine_id
       WHERE m.brand_name = 'Crocin' AND m.dosage = '500mg' ORDER BY p.name`,
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ name: expect.stringContaining("Pharmacy A"), quantity: 1 });
  });
});

describe("medicine search primitives", () => {
  const search = async (term: string) =>
    (
      await db.query<{ brand_name: string }>(
        `SELECT brand_name FROM medicines
         WHERE lower(brand_name) LIKE '%' || lower($1) || '%' OR lower(generic_name) LIKE '%' || lower($1) || '%'`,
        [term],
      )
    ).rows.map((r) => r.brand_name);

  it("finds by partial, case-insensitive brand name", async () => {
    expect(await search("croc")).toContain("Crocin");
    expect(await search("CROCIN")).toContain("Crocin");
  });

  it("finds by generic name", async () => {
    expect(await search("paracetamol")).toEqual(expect.arrayContaining(["Crocin", "Dolo", "Calpol", "Combiflam"]));
  });

  it("has trigram indexes available for these lookups", async () => {
    const { rows } = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'medicines'",
    );
    expect(rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(["medicines_brand_trgm", "medicines_generic_trgm"]),
    );
  });
});
