import { createPool, loadPharmacyUrls, pharmacyUrlEnv, PHARMACIES, type Db } from "@medlink/db";
import {
  assertDemoSeedAllowed,
  DEFAULT_DEMO_SEED,
  DemoSeedBlocked,
  directorySeedTargets,
  directoryTargetProblem,
  loadCandidates,
  PharmacySimulator,
  planDemoSeed,
  runDemoSeed,
  summarise,
} from "@medlink/pharmacy-ops";

/**
 * npm run demo:seed -- [--seed=<text>] [--include-directory=P006,P007] [--write | --list]
 *
 * Spreads catalogue medicines over the demo pharmacies as SYNTHETIC demo stock, through the normal inventory path (each
 * pharmacy's own database + outbox). Without --write it is a dry run that only reads. Writing is refused unless every
 * database is on this machine and the environment is not production. It never deletes or overwrites anything.
 *
 * The default targets are the five original demo pharmacies only. Directory pharmacies (P006 and up) are real businesses
 * listed as demo entries: they are never seeded because a database URL happens to be configured, only when named with
 * --include-directory, and only if their database was set up for the demo (npm run demo:directory-setup) and holds no
 * stock of its own.
 */
const args = process.argv.slice(2);
const write = args.includes("--write");
const list = args.includes("--list");
const seed = args.find((a) => a.startsWith("--seed="))?.slice("--seed=".length) || DEFAULT_DEMO_SEED;
const includeArg = args.find((a) => a.startsWith("--include-directory="))?.slice("--include-directory=".length);
const include = includeArg ? includeArg.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean) : [];
const unknown = args.filter((a) => a !== "--write" && a !== "--list" && !a.startsWith("--seed=") && !a.startsWith("--include-directory="));

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
if (unknown.length) fail(`Unknown option ${unknown.join(" ")}. Usage: npm run demo:seed -- [--seed=<text>] [--include-directory=P006,P007] [--write | --list]`);
if (write && list) fail("Use --write or --list, not both.");

let urls: Record<string, string>;
try {
  urls = loadPharmacyUrls(); // the original five
  for (const c of include) {
    const url = process.env[pharmacyUrlEnv(c)];
    if (!url) fail(`${pharmacyUrlEnv(c)} is not set, so ${c} has no database to seed.`);
    urls[c] = url!;
  }
} catch (err) {
  fail(`${(err as Error).message}\n(copy .env.example to .env, then: npm run infra:up && npm run pharmacies:setup)`);
}
try {
  assertDemoSeedAllowed(process.env, urls!);
} catch (err) {
  if (write || !(err instanceof DemoSeedBlocked)) fail(err instanceof DemoSeedBlocked ? `${err.message}\nNothing was written.` : (err as Error).message);
  console.log(`(note: a write would be refused here: ${(err as Error).message})`);
}

const central = createPool(process.env.DATABASE_URL);
let active = [...PHARMACIES];
try {
  active = [...PHARMACIES, ...directorySeedTargets(include)];
} catch (err) {
  fail((err as Error).message);
}
const pharmacies: Record<string, Db> = Object.fromEntries(active.map((p) => [p.code, createPool(urls![p.code])]));
for (const pool of [central, ...Object.values(pharmacies)]) pool.on("error", () => undefined);

try {
  const candidates = await loadCandidates(central);
  let plan = planDemoSeed(candidates, seed, active);
  const refused: string[] = [];
  for (const code of include) {
    const problem = await directoryTargetProblem(pharmacies[code]!, code, plan);
    if (problem) refused.push(problem);
  }
  if (refused.length) {
    console.error(`${write ? "" : "[dry run] "}Not seeding: ${refused.join("; ")}`);
    if (write) process.exit(1);
    const skip = new Set(include.filter((c) => refused.some((m) => m.startsWith(c))));
    plan = { ...plan, rows: plan.rows.filter((r) => !skip.has(r.pharmacy)) };
  }
  if (list) {
    // Which rows look like this seed's output: same pharmacy, medicine, quantity and price as the plan. Read only.
    const sim = new PharmacySimulator(pharmacies);
    const stock = new Map(await Promise.all(active.map(async (p) => [p.code, await sim.stock(p.code)] as const)));
    const matching = plan.rows.filter((r) => {
      const line = stock.get(r.pharmacy)?.get(r.medicineCode);
      return line && line.quantity === r.quantity && line.price === r.price;
    });
    console.log(`Seed "${seed}": ${matching.length} of ${plan.rows.length} planned rows are listed exactly as planned (so they look like this demo data):`);
    for (const r of matching) console.log(`  ${r.pharmacy} ${r.medicineCode} ${r.brand} qty ${r.quantity} price ${r.price.toFixed(2)}`);
    process.exit(0);
  }
  const report = await runDemoSeed(new PharmacySimulator(pharmacies), plan, { dryRun: !write });

  const verb = write ? "Added" : "Would add";
  console.log(`${write ? "" : "[dry run, nothing written] "}Demo seed "${seed}": ${verb.toLowerCase()} ${report.added.length} synthetic inventory rows, ${report.skipped.length} already listed (left untouched)`);
  const sum = summarise(report.added, active);
  for (const p of active) {
    const s = sum.byPharmacy[p.code]!;
    console.log(`  ${p.code}  +${String(s.rows).padStart(3)}   in stock ${s.inStock}, low ${s.low}, zero ${s.zero}   ${p.name}`);
  }
  console.log(`  scenarios: ${Object.entries(sum.byScenario).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
  console.log(`  unlisted on purpose: ${plan.unlisted.map((c) => `${c.brand} (${c.code})`).join(", ") || "none"}`);
  for (const r of report.added.filter((x) => x.scenario !== "random")) console.log(`  [${r.scenario}] ${r.pharmacy} ${r.brand} qty ${r.quantity} price ${r.price.toFixed(2)}`);
  if (!write) console.log("Run again with --write to add them.");
  else console.log("Events are in each pharmacy's outbox: the connector and sync service carry them to search.");
} finally {
  await Promise.all([central, ...Object.values(pharmacies)].map((p) => p.end().catch(() => undefined)));
}
