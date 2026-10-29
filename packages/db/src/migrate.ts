import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db } from "./pool.js";

const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = path.join(PKG_DIR, "migrations");
/** Schema applied to every pharmacy's own database. */
export const PHARMACY_MIGRATIONS_DIR = path.join(PKG_DIR, "pharmacy-migrations");

/** Applies pending *.sql files in filename order, each in its own transaction. Returns applied names. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    // Advisory lock so concurrent runners can't apply the same migration twice.
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => undefined);
    client.release();
  }
  return applied;
}

/** Drops everything in the public schema. Dev/test only. */
export async function resetSchema(db: Db): Promise<void> {
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}
