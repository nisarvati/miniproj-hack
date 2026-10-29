import pg from "pg";
import { createPool, loadPharmacyUrls, migrate, provisionPharmacyDatabase, resetSchema, seed, setupPharmacyDatabase, type Db } from "./index.js";

/**
 * Tests run against a dedicated `<db>_test` database so resetting the schema
 * can never touch development data. Created on demand.
 */
export async function createTestDb(): Promise<Db> {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is not set (copy .env.example to .env and run `npm run db:up`)");
  const url = new URL(base);
  const testName = `${url.pathname.slice(1)}_test`;

  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [testName]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${testName}"`);
  } finally {
    await admin.end();
  }

  url.pathname = `/${testName}`;
  return createPool(url.toString());
}

export async function freshSeededDb(): Promise<Db> {
  const db = await createTestDb();
  await resetSchema(db);
  await migrate(db);
  await seed(db);
  return db;
}

/** Same roles as development, but databases suffixed `_test`, so tests never touch dev pharmacy data. */
export function testPharmacyUrls(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const urls = loadPharmacyUrls(env);
  return Object.fromEntries(
    Object.entries(urls).map(([code, url]) => {
      const u = new URL(url);
      u.pathname = `${u.pathname}_test`;
      return [code, u.toString()];
    }),
  );
}

/** Provisions, resets and seeds the five test pharmacy databases. */
export async function freshPharmacyDbs(admin: Db): Promise<Record<string, string>> {
  const urls = testPharmacyUrls();
  for (const [code, url] of Object.entries(urls)) {
    await provisionPharmacyDatabase(admin, url);
    const pool = createPool(url);
    try {
      await resetSchema(pool);
    } finally {
      await pool.end();
    }
    await setupPharmacyDatabase(code, url);
  }
  return urls;
}
