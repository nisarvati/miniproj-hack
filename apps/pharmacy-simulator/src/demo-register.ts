import { activePharmacies, createPool, directoryExtras, loadActivePharmacyUrls, pharmacyUrlEnv, registerPharmacies } from "@medlink/db";
import { assertDemoSeedAllowed, DemoSeedBlocked } from "@medlink/pharmacy-ops";

/**
 * npm run demo:register -- [--write]
 *
 * Adds the Mumbai demo-directory pharmacies that are CONFIGURED (their PHARMACY_<code>_DATABASE_URL is set) to the central
 * `pharmacies` table, so search can show them. It only inserts missing rows (no migration, nothing existing is changed),
 * never provisions a database, and is a dry run unless --write is given. Pharmacies without a configured database are
 * listed, not registered. Writing is refused unless every database is on this machine.
 */
const write = process.argv.includes("--write");
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

let urls: Record<string, string>;
try {
  urls = loadActivePharmacyUrls();
} catch (err) {
  fail(`${(err as Error).message}\n(copy .env.example to .env first)`);
}
try {
  assertDemoSeedAllowed(process.env, urls!);
} catch (err) {
  if (write || !(err instanceof DemoSeedBlocked)) fail(err instanceof DemoSeedBlocked ? `${err.message}\nNothing was written.` : (err as Error).message);
  console.log(`(note: a write would be refused here: ${(err as Error).message})`);
}

const configured = new Set(activePharmacies().map((p) => p.code));
const entries = directoryExtras().filter((p) => configured.has(p.code));
const waiting = directoryExtras().filter((p) => !configured.has(p.code));

const central = createPool(process.env.DATABASE_URL);
central.on("error", () => undefined);
try {
  const report = await registerPharmacies(central, entries, { dryRun: !write });
  console.log(`${write ? "" : "[dry run, nothing written] "}Demo pharmacy registration: ${report.registered.length} ${write ? "registered" : "to register"}, ${report.alreadyRegistered.length} already registered, ${report.conflicts.length} conflicts`);
  for (const c of report.conflicts) console.log(`  conflict  ${c.code}: ${c.reason}`);
  if (waiting.length) {
    console.log(`${waiting.length} directory pharmacies have no database configured yet (not registered):`);
    for (const p of waiting) console.log(`  ${p.code}  ${pharmacyUrlEnv(p.code)}  ${p.name}`);
  }
  if (!write && entries.length) console.log("Run again with --write to register them.");
} finally {
  await central.end().catch(() => undefined);
}
