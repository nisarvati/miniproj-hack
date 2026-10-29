import { createPool, directoryExtras, pharmacyUrlEnv, setupDirectoryPharmacyDatabase } from "@medlink/db";
import { assertDemoSeedAllowed, DemoSeedBlocked } from "@medlink/pharmacy-ops";

/**
 * npm run demo:directory-setup -- <P006> [--write]
 *
 * Prepares ONE directory pharmacy's own database for demo use: applies the pharmacy schema and records its profile. The
 * inventory is left EMPTY and no event is written. Without --write it only reads. Writing is refused unless the environment
 * is local development or test and every database is on this machine. The role and database must already exist (that is
 * provisioning, a separate step), and the pharmacy is not registered centrally here (see demo:register).
 */
const args = process.argv.slice(2);
const write = args.includes("--write");
const codes = args.filter((a) => !a.startsWith("--")).map((a) => a.toUpperCase());
const unknown = args.filter((a) => a.startsWith("--") && a !== "--write");
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
if (unknown.length || codes.length !== 1) fail("Usage: npm run demo:directory-setup -- <P006> [--write]");
const code = codes[0]!;
const entry = directoryExtras().find((p) => p.code === code);
if (!entry) fail(`${code} is not a directory pharmacy (P006 and up).`);
const url = process.env[pharmacyUrlEnv(code)];
if (!url) fail(`${pharmacyUrlEnv(code)} is not set, so there is no database to set up. Provisioning it is a separate, approved step.`);

try {
  assertDemoSeedAllowed(process.env, { [code]: url! });
} catch (err) {
  if (write || !(err instanceof DemoSeedBlocked)) fail(err instanceof DemoSeedBlocked ? `${err.message}\nNothing was written.` : (err as Error).message);
  console.log(`(note: a write would be refused here: ${(err as Error).message})`);
}

if (!write) {
  const pool = createPool(url!);
  pool.on("error", () => undefined);
  try {
    const profile = await pool.query<{ pharmacy_code: string }>("SELECT pharmacy_code FROM pharmacy_profile").then((r) => r.rows[0]?.pharmacy_code, () => undefined);
    console.log(`[dry run, nothing written] ${code} ${entry!.name}: ${profile === code ? "already set up" : profile ? `database belongs to ${profile}` : "would apply the pharmacy schema and record its profile, with no stock"}.`);
  } finally {
    await pool.end().catch(() => undefined);
  }
} else {
  const r = await setupDirectoryPharmacyDatabase(code, url!);
  console.log(`${code} ${entry!.name}: profile ${r.profile}; migrations applied: ${r.applied.length ? r.applied.join(", ") : "none new"}. Inventory is empty.`);
}
