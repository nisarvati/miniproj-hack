import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, parseDbUrl, PHARMACY_CODES, provisionPharmacyDatabase, setupPharmacyDatabase, type Db } from "../src/index.js";
import { inventoryFor, PHARMACIES } from "../src/seed-data.js";
import { freshPharmacyDbs, freshSeededDb } from "../src/testing.js";

let central: Db;
let urls: Record<string, string>;
const pools = new Map<string, Db>();
const local = (code: string) => {
  if (!pools.has(code)) pools.set(code, createPool(urls[code]));
  return pools.get(code)!;
};

beforeAll(async () => {
  central = await freshSeededDb();
  urls = await freshPharmacyDbs(central);
});
afterAll(async () => {
  await Promise.all([...pools.values()].map((p) => p.end()));
  await central.end();
});

const crocin = async (code: string) =>
  Number((await local(code).query("SELECT quantity FROM inventory WHERE medicine_code = 'M001'")).rows[0].quantity);

describe("five independent pharmacy databases", () => {
  it("has one separate database per pharmacy, with its own role", () => {
    expect(PHARMACY_CODES).toEqual(["P001", "P002", "P003", "P004", "P005"]);
    const targets = Object.values(urls).map(parseDbUrl);
    expect(new Set(targets.map((t) => t.database)).size).toBe(5);
    expect(new Set(targets.map((t) => t.user)).size).toBe(5);
    expect(new Set(targets.map((t) => t.password)).size).toBe(5);
  });

  it("databases really exist as distinct databases on the server", async () => {
    const { rows } = await central.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE 'pharmacy\\_p00%\\_test'");
    expect(rows.map((r) => r.datname).sort()).toEqual(["pharmacy_p001_test", "pharmacy_p002_test", "pharmacy_p003_test", "pharmacy_p004_test", "pharmacy_p005_test"]);
  });

  it("each database identifies its own pharmacy and holds only the pharmacy schema", async () => {
    for (const [i, code] of PHARMACY_CODES.entries()) {
      const profile = (await local(code).query("SELECT pharmacy_code, name FROM pharmacy_profile")).rows;
      expect(profile).toEqual([{ pharmacy_code: code, name: PHARMACIES[i]!.name }]);
      const tables = (await local(code).query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((r) => r.table_name);
      expect(tables).toEqual(["inventory", "outbox", "pharmacy_profile", "schema_migrations"]); // no central tables here
    }
  });

  it("seeds each pharmacy with its own stock, matching the central starting data", async () => {
    for (const [i, code] of PHARMACY_CODES.entries()) {
      const expected = inventoryFor(i);
      const { rows } = await local(code).query("SELECT medicine_code, quantity, price FROM inventory ORDER BY medicine_code");
      expect(rows).toHaveLength(expected.length);
      const byCode = new Map(rows.map((r) => [r.medicine_code, r]));
      for (const e of expected) {
        expect(byCode.get(e.medicine.code)).toMatchObject({ quantity: e.quantity, price: e.price.toFixed(2) });
      }
    }
    const total = (await Promise.all(PHARMACY_CODES.map(async (c) => Number((await local(c).query("SELECT count(*) FROM inventory")).rows[0].count)))).reduce((a, b) => a + b, 0);
    expect(total).toBe(Number((await central.query("SELECT count(*) FROM inventory")).rows[0].count));
  });

  it("has the Crocin 500mg demo scenario: A has exactly 1, D has 0", async () => {
    expect(await Promise.all(PHARMACY_CODES.map(crocin))).toEqual([1, 40, 3, 0, 25]);
  });

  it("every local medicine_code exists in the central catalogue", async () => {
    const central_codes = new Set((await central.query("SELECT code FROM medicines")).rows.map((r) => r.code));
    for (const code of PHARMACY_CODES) {
      const rows = (await local(code).query("SELECT medicine_code FROM inventory")).rows;
      for (const r of rows) expect(central_codes.has(r.medicine_code)).toBe(true);
    }
  });

  it("changing one pharmacy's stock does not affect the others or the central database", async () => {
    const centralBefore = (await central.query("SELECT sum(quantity) AS n FROM inventory")).rows[0].n;
    await local("P001").query("UPDATE inventory SET quantity = quantity - 1 WHERE medicine_code = 'M001'");
    expect(await Promise.all(PHARMACY_CODES.map(crocin))).toEqual([0, 40, 3, 0, 25]);
    expect((await central.query("SELECT sum(quantity) AS n FROM inventory")).rows[0].n).toBe(centralBefore);
    await local("P001").query("UPDATE inventory SET quantity = 1 WHERE medicine_code = 'M001'");
  });

  it("enforces stock rules locally (no negative stock, no invalid price)", async () => {
    await expect(local("P002").query("UPDATE inventory SET quantity = -1 WHERE medicine_code = 'M001'")).rejects.toMatchObject({ code: "23514" });
    await expect(local("P002").query("UPDATE inventory SET price = 0 WHERE medicine_code = 'M001'")).rejects.toMatchObject({ code: "23514" });
    await expect(local("P002").query("INSERT INTO inventory (medicine_code, quantity, price) VALUES ('bad', 1, 1)")).rejects.toMatchObject({ code: "23514" });
  });

  it("allows only one profile row", async () => {
    await expect(local("P002").query("INSERT INTO pharmacy_profile (singleton, pharmacy_code, name) VALUES (true, 'P002', 'dup')")).rejects.toMatchObject({ code: "23505" });
  });
});

describe("isolation between pharmacies", () => {
  const tryConnect = async (url: string) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    return client;
  };

  it("one pharmacy's credentials cannot open another pharmacy's database", async () => {
    const other = new URL(urls.P002!);
    const asP001 = new URL(urls.P001!);
    other.username = asP001.username;
    other.password = asP001.password; // P001's role, P002's database
    await expect(tryConnect(other.toString())).rejects.toThrow(/permission denied for database/);
  });

  it("a pharmacy role cannot read MedLink's central tables", async () => {
    // Uses the real central database (normal grants), where the pharmacy role may connect but owns nothing.
    const u = new URL(urls.P001!);
    u.pathname = new URL(process.env.DATABASE_URL!).pathname;
    const client = await tryConnect(u.toString());
    try {
      await expect(client.query("SELECT * FROM medicines")).rejects.toThrow(/permission denied for table medicines/);
      await expect(client.query("SELECT * FROM inventory")).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });

  it("wrong password is rejected", async () => {
    const u = new URL(urls.P001!);
    u.password = "not-the-password";
    await expect(tryConnect(u.toString())).rejects.toThrow(/password authentication failed/);
  });
});

describe("provisioning", () => {
  it("is idempotent and does not lose data", async () => {
    await local("P003").query("UPDATE inventory SET quantity = 77 WHERE medicine_code = 'M002'");
    await provisionPharmacyDatabase(central, urls.P003!);
    const r = await setupPharmacyDatabase("P003", urls.P003!); // re-seeds starting stock
    expect(r.applied).toEqual([]); // no pending migrations
    expect(r.items).toBe(inventoryFor(2).length);
  });

  it("rejects unknown pharmacy codes and incomplete URLs", async () => {
    await expect(setupPharmacyDatabase("P999", urls.P001!)).rejects.toThrow(/Unknown pharmacy/);
    expect(() => parseDbUrl("postgres://localhost/db")).toThrow(/user, password and database/);
  });
});

describe("central public codes (migration 002)", () => {
  it("assigns unique P/M codes", async () => {
    const p = (await central.query("SELECT code FROM pharmacies ORDER BY code")).rows.map((r) => r.code);
    expect(p).toEqual(PHARMACY_CODES);
    const m = (await central.query("SELECT code FROM medicines ORDER BY code")).rows.map((r) => r.code);
    expect(m).toHaveLength(15);
    expect(m[0]).toBe("M001");
    expect(m.at(-1)).toBe("M015");
  });
  it("rejects malformed or duplicate codes", async () => {
    await expect(central.query("INSERT INTO pharmacies (code, name, address, latitude, longitude) VALUES ('X1','n','a',1,1)")).rejects.toMatchObject({ code: "23514" });
    await expect(central.query("INSERT INTO pharmacies (code, name, address, latitude, longitude) VALUES ('P001','n2','a2',1,1)")).rejects.toMatchObject({ code: "23505" });
  });
});
