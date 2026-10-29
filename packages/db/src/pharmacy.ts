import type { Db } from "./pool.js";
import { createPool } from "./pool.js";
import { migrate, PHARMACY_MIGRATIONS_DIR } from "./migrate.js";
import { directoryExtras } from "./pharmacy-registry.js";
import { inventoryFor, PHARMACIES } from "./seed-data.js";

/** Codes of the simulated pharmacies. Each owns an independent database. */
export const PHARMACY_CODES: readonly string[] = PHARMACIES.map((p) => p.code);

export const pharmacyUrlEnvName = (code: string) => `PHARMACY_${code}_DATABASE_URL`;

/** Reads PHARMACY_<code>_DATABASE_URL for every pharmacy; fails with a message naming whatever is missing. */
export function loadPharmacyUrls(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const urls: Record<string, string> = {};
  const missing: string[] = [];
  for (const code of PHARMACY_CODES) {
    const v = env[pharmacyUrlEnvName(code)];
    if (v) urls[code] = v;
    else missing.push(pharmacyUrlEnvName(code));
  }
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  return urls;
}

export interface DbTarget {
  user: string;
  password: string;
  database: string;
}

export function parseDbUrl(url: string): DbTarget {
  const u = new URL(url);
  const target = {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)),
  };
  if (!target.user || !target.password || !target.database) {
    throw new Error("Pharmacy database URL must include user, password and database name");
  }
  return target;
}

/**
 * Creates (idempotently) the pharmacy's own role and database from its connection URL.
 * - the role owns the database and has no privileges anywhere else
 * - CONNECT is revoked from PUBLIC so no other pharmacy's role can even open this database
 * `admin` is a privileged connection (it needs CREATEROLE and CREATEDB); identifiers and the
 * password are quoted server-side with format(%I / %L).
 */
export async function provisionPharmacyDatabase(admin: Db, url: string): Promise<void> {
  const { user, password, database } = parseDbUrl(url);
  const run = async (template: string, ...args: string[]) => {
    const { rows } = await admin.query<{ sql: string }>("SELECT format($1, VARIADIC $2::text[]) AS sql", [template, args]);
    await admin.query(rows[0]!.sql);
  };

  const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
  if (role.rowCount) await run("ALTER ROLE %I WITH LOGIN PASSWORD %L", user, password);
  else await run("CREATE ROLE %I WITH LOGIN PASSWORD %L", user, password);

  const db = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (!db.rowCount) await run("CREATE DATABASE %I OWNER %I", database, user);
  await run("REVOKE CONNECT ON DATABASE %I FROM PUBLIC", database);
  await run("GRANT CONNECT ON DATABASE %I TO %I", database, user);
}

/** Applies the pharmacy schema and (re)loads this pharmacy's starting stock, using the pharmacy's own credentials. */
export async function setupPharmacyDatabase(code: string, url: string): Promise<{ applied: string[]; items: number }> {
  const idx = PHARMACIES.findIndex((p) => p.code === code);
  if (idx < 0) throw new Error(`Unknown pharmacy code ${code}`);
  const pool = createPool(url);
  try {
    const applied = await migrate(pool, PHARMACY_MIGRATIONS_DIR);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO pharmacy_profile (pharmacy_code, name) VALUES ($1, $2)
         ON CONFLICT (singleton) DO UPDATE SET pharmacy_code = EXCLUDED.pharmacy_code, name = EXCLUDED.name`,
        [code, PHARMACIES[idx]!.name],
      );
      const rows = inventoryFor(idx);
      for (const r of rows) {
        await client.query(
          `INSERT INTO inventory (medicine_code, quantity, price) VALUES ($1, $2, $3)
           ON CONFLICT (medicine_code) DO UPDATE SET quantity = EXCLUDED.quantity, price = EXCLUDED.price, updated_at = now()`,
          [r.medicine.code, r.quantity, r.price],
        );
      }
      await client.query("COMMIT");
      return { applied, items: rows.length };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Explicit, demo-only setup of a DIRECTORY pharmacy (P006 and up): applies the pharmacy schema and records its profile,
 * and nothing else. The inventory starts EMPTY; no stock is inserted and no outbox event is written. Idempotent, and it
 * never replaces an existing profile. Refuses the original five (use `setupPharmacyDatabase`) and any code that is not a
 * directory listing. It does not provision the role or database and does not register the pharmacy centrally.
 */
export async function setupDirectoryPharmacyDatabase(code: string, url: string): Promise<{ applied: string[]; profile: "created" | "existing" }> {
  const entry = directoryExtras().find((p) => p.code === code);
  if (!entry) throw new Error(`${code} is not a directory pharmacy (P006 and up); the original five use setupPharmacyDatabase`);
  const pool = createPool(url);
  try {
    const applied = await migrate(pool, PHARMACY_MIGRATIONS_DIR);
    const { rows } = await pool.query<{ pharmacy_code: string }>(
      "INSERT INTO pharmacy_profile (pharmacy_code, name) VALUES ($1, $2) ON CONFLICT (singleton) DO NOTHING RETURNING pharmacy_code",
      [code, entry.name],
    );
    if (!rows.length) {
      const existing = await pool.query<{ pharmacy_code: string }>("SELECT pharmacy_code FROM pharmacy_profile");
      if (existing.rows[0]?.pharmacy_code !== code) throw new Error(`This database already belongs to ${existing.rows[0]?.pharmacy_code}, not ${code}`);
    }
    return { applied, profile: rows.length ? "created" : "existing" };
  } finally {
    await pool.end();
  }
}

/** Provisions and seeds every pharmacy database. */
export async function setupAllPharmacies(admin: Db, urls = loadPharmacyUrls()): Promise<Record<string, number>> {
  const items: Record<string, number> = {};
  for (const code of PHARMACY_CODES) {
    await provisionPharmacyDatabase(admin, urls[code]!);
    items[code] = (await setupPharmacyDatabase(code, urls[code]!)).items;
  }
  return items;
}
