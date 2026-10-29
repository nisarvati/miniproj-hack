import { createPool } from "./pool.js";
import { migrate, resetSchema, PHARMACY_MIGRATIONS_DIR } from "./migrate.js";
import { loadActivePharmacyUrls } from "./pharmacy-registry.js";
import { seed } from "./seed.js";
import { importCatalogue, readCatalogueBatch } from "./catalogue.js";
import { loadPharmacyUrls, PHARMACY_CODES, provisionPharmacyDatabase, setupAllPharmacies, setupPharmacyDatabase } from "./pharmacy.js";
import { createPool as pool } from "./pool.js";

const command = process.argv[2];
const db = createPool();

try {
  if (command === "migrate") {
    const applied = await migrate(db);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "No pending migrations");
  } else if (command === "seed") {
    console.log("Seeded:", await seed(db));
  } else if (command === "catalogue:import") {
    // npm run db:catalogue -- [--dry-run] [path/to/batch.json]
    const args = process.argv.slice(3);
    const file = args.find((a) => !a.startsWith("--"));
    const report = await importCatalogue(db, readCatalogueBatch(file), { dryRun: args.includes("--dry-run") });
    console.log(`${report.dryRun ? "[dry run, nothing written] " : ""}Catalogue import: imported ${report.imported.length}, already present ${report.matched.length}, needs review ${report.skipped.length}, rejected ${report.rejected.length}`);
    for (const r of report.rejected) console.log(`  rejected  ${r.name}: ${r.reason}`);
    for (const r of report.skipped) console.log(`  review    ${r.name}: ${r.reason}`);
  } else if (command === "reset") {
    await resetSchema(db);
    console.log("Applied:", (await migrate(db)).join(", "));
    console.log("Seeded:", await seed(db));
  } else if (command === "pharmacies:setup") {
    console.log("Pharmacy databases ready (items per pharmacy):", await setupAllPharmacies(db));
  } else if (command === "pharmacies:migrate") {
    // Applies only the pharmacy schema migrations that are still pending, to every active pharmacy's own database. Additive: it never
    // seeds, never overwrites stock and never drops anything (unlike pharmacies:setup and pharmacies:reset).
    for (const [code, url] of Object.entries(loadActivePharmacyUrls())) {
      const p = pool(url);
      try {
        const applied = await migrate(p, PHARMACY_MIGRATIONS_DIR);
        console.log(`${code}  ${applied.length ? `applied ${applied.join(", ")}` : "up to date"}`);
      } finally {
        await p.end();
      }
    }
  } else if (command === "pharmacies:reset") {
    // Back to the starting demo state: drops each pharmacy's schema, re-applies migrations, re-seeds stock.
    const urls = loadPharmacyUrls();
    for (const code of PHARMACY_CODES) {
      await provisionPharmacyDatabase(db, urls[code]!);
      const p = pool(urls[code]);
      try {
        await resetSchema(p);
      } finally {
        await p.end();
      }
      await setupPharmacyDatabase(code, urls[code]!);
    }
    console.log("Pharmacy databases reset to the starting state");
  } else if (command === "pharmacies:status") {
    const urls = loadPharmacyUrls();
    for (const code of PHARMACY_CODES) {
      const p = pool(urls[code]);
      try {
        const { rows } = await p.query<{ name: string; items: string; units: string; crocin: number | null }>(
          `SELECT (SELECT name FROM pharmacy_profile) AS name, count(*) AS items, sum(quantity) AS units,
                  max(quantity) FILTER (WHERE medicine_code = 'M001') AS crocin
           FROM inventory`,
        );
        const r = rows[0]!;
        console.log(`${code}  ${r.name.padEnd(27)} items=${r.items} units=${r.units} crocin500=${r.crocin ?? "-"}`);
      } catch (err) {
        console.log(`${code}  UNAVAILABLE (${(err as Error).message})`);
      } finally {
        await p.end();
      }
    }
  } else {
    console.error("Usage: cli.ts <migrate|seed|catalogue:import|reset|pharmacies:setup|pharmacies:migrate|pharmacies:reset|pharmacies:status>");
    process.exitCode = 1;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
