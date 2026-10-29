import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, directoryExtras, provisionPharmacyDatabase, resetSchema, setupDirectoryPharmacyDatabase, type Db } from "../src/index.js";
import { freshSeededDb, testPharmacyUrls } from "../src/testing.js";

/**
 * Uses an isolated throwaway database (`pharmacy_p006_demo_test`) owned by the existing P001 test role, so no role is
 * created; the database is dropped afterwards. Dev pharmacy databases are never touched.
 */
const DB_NAME = "pharmacy_p006_demo_test";
let admin: Db;
let url: string;
let code: string;

beforeAll(async () => {
  admin = await freshSeededDb();
  const u = new URL(testPharmacyUrls().P001!);
  u.pathname = `/${DB_NAME}`;
  url = u.toString();
  code = directoryExtras()[0]!.code;
  await provisionPharmacyDatabase(admin, url);
  const pool = createPool(url);
  try {
    await resetSchema(pool);
  } finally {
    await pool.end();
  }
});
afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.end();
});

const q = async <T>(sql: string) => {
  const pool = createPool(url);
  try {
    return (await pool.query(sql)).rows as T[];
  } finally {
    await pool.end();
  }
};

describe("setupDirectoryPharmacyDatabase", () => {
  it("creates the schema and profile and leaves the inventory and outbox EMPTY", async () => {
    const r = await setupDirectoryPharmacyDatabase(code, url);
    expect(r.profile).toBe("created");
    expect(await q("SELECT pharmacy_code FROM pharmacy_profile")).toEqual([{ pharmacy_code: code }]);
    expect(await q("SELECT 1 FROM inventory")).toEqual([]);
    expect(await q("SELECT 1 FROM outbox")).toEqual([]);
  });

  it("is idempotent and never overwrites existing stock or the profile", async () => {
    await q(`INSERT INTO inventory (medicine_code, quantity, price) VALUES ('M001', 7, 12.5)`);
    expect((await setupDirectoryPharmacyDatabase(code, url)).profile).toBe("existing");
    expect(await q("SELECT medicine_code, quantity FROM inventory")).toEqual([{ medicine_code: "M001", quantity: 7 }]);
    expect(await q("SELECT pharmacy_code FROM pharmacy_profile")).toEqual([{ pharmacy_code: code }]);
  });

  it("refuses the original five, unknown codes, and a database that belongs to another pharmacy", async () => {
    for (const bad of ["P001", "P005", "P999"]) await expect(setupDirectoryPharmacyDatabase(bad, url)).rejects.toThrow(/not a directory pharmacy/);
    const others = directoryExtras().map((p) => p.code).filter((c) => c !== code);
    if (others[0]) await expect(setupDirectoryPharmacyDatabase(others[0], url)).rejects.toThrow(/already belongs to/);
  });
});
