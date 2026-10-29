import { createHash } from "node:crypto";
import { directoryExtras, knownPharmacies, MEDICINES, PHARMACIES, shippedCatalogue, type Db, type SeedPharmacy } from "@medlink/db";
import { SimulatorError } from "./catalogue.js";
import type { PharmacySimulator } from "./simulator.js";

/**
 * Synthetic demo stock for local development: a varied, repeatable spread of catalogue medicines over the demo
 * pharmacies. It is NOT real stock and makes no claim about any real pharmacy.
 *
 * The plan is a pure function of (seed, medicines): same seed, same plan. Writing goes through the normal inventory
 * path (`PharmacySimulator.addMedicine`: the pharmacy's own database, with the outbox event recorded in the same
 * transaction), so the connector, Redis Streams and sync service carry it like any other change. Nothing here deletes,
 * updates or resets anything, and nothing touches the central catalogue.
 */

export const DEFAULT_DEMO_SEED = "medlink-demo-1";

export type Tier = "common" | "mid" | "rare";
export type Scenario = "random" | "multi-price" | "single-pharmacy" | "zero-stock";

export interface Candidate {
  code: string;
  brand: string;
}

export interface PlannedRow {
  pharmacy: string;
  medicineCode: string;
  brand: string;
  quantity: number;
  price: number;
  scenario: Scenario;
}

export interface DemoPlan {
  seed: string;
  rows: PlannedRow[];
  /** Catalogue medicines deliberately left unlisted by every pharmacy. */
  unlisted: Candidate[];
}

const COMMON = new Set(["Pain and fever", "Allergy", "Gastrointestinal", "Vitamins and nutrition", "Respiratory", "First aid and topical", "Cardiology", "Endocrinology and chronic care"]);
const RARE = new Set(["Hospital and specialty", "Oncology", "Oncology and supportive care", "Nephrology"]);
/** Chance that one pharmacy lists a medicine of the tier: common ones turn up in several pharmacies, rare ones in few. */
export const LIST_PROBABILITY: Record<Tier, number> = { common: 0.65, mid: 0.35, rare: 0.12 };

/** How common a medicine is, from its catalogue category. Medicines outside the shipped batch count as "mid". */
export function tierOf(code: string): Tier {
  const rec = shippedCatalogue().find((r) => r.code === code);
  if (!rec?.category) return "mid";
  if (COMMON.has(rec.category)) return "common";
  return RARE.has(rec.category) ? "rare" : "mid";
}

/** Deterministic number in [0, 1) from the seed and any keys: independent of order, so adding a medicine moves nothing else. */
export function unit(seed: string, ...keys: string[]): number {
  const h = createHash("sha256").update([seed, ...keys].join("\u0000")).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A synthetic list price, log-uniform within a range that fits the tier and kind, the same for every pharmacy before its factor. */
function basePrice(seed: string, code: string, tier: Tier): number {
  const generic = shippedCatalogue().find((r) => r.code === code)?.kind === "generic";
  const [lo, hi] = generic ? [8, 150] : tier === "common" ? [25, 450] : tier === "mid" ? [60, 900] : [300, 6000];
  return Math.exp(Math.log(lo) + unit(seed, "price", code) * (Math.log(hi) - Math.log(lo)));
}

function priceAt(seed: string, code: string, tier: Tier, pharmacy: SeedPharmacy): number {
  const factor = pharmacy.priceFactor * (0.97 + 0.06 * unit(seed, "jitter", pharmacy.code, code));
  return Math.max(1, round2(basePrice(seed, code, tier) * factor));
}

function quantityAt(seed: string, pharmacy: string, code: string, tier: Tier): number {
  const u = unit(seed, "qty", pharmacy, code);
  const v = unit(seed, "qty2", pharmacy, code);
  if (u < 0.1) return 0; // listed, sold out
  if (u < 0.3) return 1 + Math.floor(v * 5); // low stock
  return tier === "rare" ? 2 + Math.floor(v * 29) : 6 + Math.floor(v * 145);
}

/** The medicines the intentional test cases use. If one is missing from the catalogue, a seeded pick stands in. */
const WANTED = { multiPrice: "Amlong", single: "Retaunch", zeroStock: "Cabgolin", unlisted: ["Nefrozon", "Dutas"] };
const SINGLE_AT = "P002";
const ZERO_AT = "P004";

/**
 * Plans the demo stock. `candidates` are catalogue medicines (central `medicines` rows); the demo medicines M001 to M015
 * are excluded because they already have their own predictable starting stock. `pharmacies` are the configured demo
 * pharmacies (default: the original five); each decision is keyed by pharmacy code, so adding pharmacies never changes
 * what the existing ones get.
 */
export function planDemoSeed(candidates: Candidate[], seed = DEFAULT_DEMO_SEED, pharmacies: readonly SeedPharmacy[] = PHARMACIES): DemoPlan {
  const seeded = new Set(MEDICINES.map((m) => m.code));
  const pool = candidates.filter((c) => !seeded.has(c.code)).sort((a, b) => a.code.localeCompare(b.code));
  const taken = new Set<string>();

  const pick = (brand: string, role: string): Candidate | undefined => {
    const exact = pool.find((c) => c.brand === brand && !taken.has(c.code));
    const chosen = exact ?? [...pool].filter((c) => !taken.has(c.code)).sort((a, b) => unit(seed, role, a.code) - unit(seed, role, b.code))[0];
    if (chosen) taken.add(chosen.code);
    return chosen;
  };

  const rows: PlannedRow[] = [];
  const unlisted = [...WANTED.unlisted.map((b) => pick(b, "unlisted:" + b))].filter((c): c is Candidate => !!c);

  const multi = pick(WANTED.multiPrice, "multi");
  if (multi) {
    const tier = tierOf(multi.code);
    pharmacies.forEach((p) => {
      rows.push({ pharmacy: p.code, medicineCode: multi.code, brand: multi.brand, quantity: 8 + Math.floor(unit(seed, "multi-qty", p.code) * 90), price: priceAt(seed, multi.code, tier, p), scenario: "multi-price" });
    });
  }
  const single = pick(WANTED.single, "single");
  if (single) {
    const at = pharmacies.find((p) => p.code === SINGLE_AT);
    if (at) rows.push({ pharmacy: SINGLE_AT, medicineCode: single.code, brand: single.brand, quantity: 14, price: priceAt(seed, single.code, tierOf(single.code), at), scenario: "single-pharmacy" });
  }
  const zero = pick(WANTED.zeroStock, "zero");
  if (zero) {
    const at = pharmacies.find((p) => p.code === ZERO_AT);
    if (at) rows.push({ pharmacy: ZERO_AT, medicineCode: zero.code, brand: zero.brand, quantity: 0, price: priceAt(seed, zero.code, tierOf(zero.code), at), scenario: "zero-stock" });
  }

  // Everything else: each pharmacy independently lists a medicine with the probability of its tier.
  for (const c of pool) {
    if (taken.has(c.code)) continue;
    const tier = tierOf(c.code);
    pharmacies.forEach((p) => {
      if (unit(seed, "lists", p.code, c.code) >= LIST_PROBABILITY[tier]) return;
      rows.push({ pharmacy: p.code, medicineCode: c.code, brand: c.brand, quantity: quantityAt(seed, p.code, c.code, tier), price: priceAt(seed, c.code, tier, p), scenario: "random" });
    });
  }
  rows.sort((a, b) => a.pharmacy.localeCompare(b.pharmacy) || a.medicineCode.localeCompare(b.medicineCode));
  return { seed, rows, unlisted };
}

/** Catalogue medicines from the central database (read only). */
export async function loadCandidates(central: Db): Promise<Candidate[]> {
  const { rows } = await central.query<{ code: string; brand_name: string }>("SELECT code, brand_name FROM medicines ORDER BY code");
  return rows.map((r) => ({ code: r.code, brand: r.brand_name }));
}

// ---- safety ----

export class DemoSeedBlocked extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Demo seeding is blocked: ${reasons.join("; ")}`);
    this.name = "DemoSeedBlocked";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const NON_PRODUCTION_ENVS = new Set(["development", "dev", "local", "test"]);

/**
 * Allows writing only when the environment can be positively identified as local development or an isolated test: not
 * production, and every database it would read or write is on this machine. Anything unknown is blocked.
 */
export function assertDemoSeedAllowed(env: NodeJS.ProcessEnv, pharmacyUrls: Record<string, string>): void {
  const reasons: string[] = [];
  if (env.NODE_ENV === "production") reasons.push("NODE_ENV is production");
  for (const name of ["MEDLINK_ENV", "APP_ENV"]) {
    const v = env[name];
    if (v && !NON_PRODUCTION_ENVS.has(v.toLowerCase())) reasons.push(`${name}=${v} is not a development or test environment`);
  }
  const targets: Record<string, string | undefined> = { DATABASE_URL: env.DATABASE_URL, ...Object.fromEntries(Object.entries(pharmacyUrls).map(([c, u]) => [`PHARMACY_${c}_DATABASE_URL`, u])) };
  if (!env.DATABASE_URL) reasons.push("DATABASE_URL is not set (the central catalogue is needed to choose medicines)");
  for (const [name, url] of Object.entries(targets)) {
    if (!url) continue;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reasons.push(`${name} is not a valid URL`);
      continue;
    }
    if (!LOCAL_HOSTS.has(u.hostname)) reasons.push(`${name} points at ${u.hostname}, not this machine`);
    if (/prod/i.test(decodeURIComponent(u.pathname))) reasons.push(`${name} names a database that looks like production`);
  }
  if (reasons.length) throw new DemoSeedBlocked(reasons);
}

// ---- directory pharmacies (explicit opt-in only) ----

/**
 * Directory pharmacies (P006 and up) are real businesses listed as demo entries. The default seed never includes them;
 * they are seeded only when named explicitly. Returns the seed pharmacies for the named codes, or throws naming the problem.
 */
export function directorySeedTargets(codes: string[]): SeedPharmacy[] {
  const allowed = new Set(directoryExtras().map((p) => p.code));
  const bad = codes.filter((c) => !allowed.has(c));
  if (bad.length) throw new DemoSeedBlocked([`${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} not a directory pharmacy (P006 and up); the original five are seeded by default`]);
  return knownPharmacies().filter((p) => codes.includes(p.code));
}

/**
 * Why a directory pharmacy's database may not receive demo stock, or null if it may. It must have been set up for the demo
 * (schema and a profile for this code) and hold nothing but rows this plan itself would write: an empty start, or a
 * repeat run. Any other stock is treated as the pharmacy's own and the seed refuses to add beside it.
 */
export async function directoryTargetProblem(db: Db, code: string, plan: DemoPlan): Promise<string | null> {
  let profile: string | undefined;
  try {
    profile = (await db.query<{ pharmacy_code: string }>("SELECT pharmacy_code FROM pharmacy_profile")).rows[0]?.pharmacy_code;
  } catch {
    return `${code}'s database has no pharmacy schema yet: run the explicit directory setup first`;
  }
  if (profile !== code) return profile ? `${code}'s database belongs to ${profile}` : `${code}'s database has no profile yet: run the explicit directory setup first`;
  const planned = new Map(plan.rows.filter((r) => r.pharmacy === code).map((r) => [r.medicineCode, r]));
  const { rows } = await db.query<{ medicine_code: string; quantity: number; price: string }>("SELECT medicine_code, quantity, price FROM inventory");
  const foreign = rows.filter((r) => {
    const want = planned.get(r.medicine_code);
    return !want || want.quantity !== r.quantity || want.price !== Number(r.price);
  });
  return foreign.length ? `${code} already has ${foreign.length} stock row(s) this seed did not write; demo stock is only added to an empty or previously seeded pharmacy` : null;
}

// ---- running ----

export interface SeedReport {
  dryRun: boolean;
  seed: string;
  /** Rows added (or that would be added in a dry run). */
  added: PlannedRow[];
  /** Planned rows the pharmacy already lists: left exactly as they are. */
  skipped: PlannedRow[];
}

/**
 * Adds the planned rows that a pharmacy does not already list. Never updates or removes anything, so existing stock (real
 * or manual) is preserved and a second run adds nothing. A dry run only reads.
 */
export async function runDemoSeed(sim: PharmacySimulator, plan: DemoPlan, options: { dryRun: boolean }): Promise<SeedReport> {
  const report: SeedReport = { dryRun: options.dryRun, seed: plan.seed, added: [], skipped: [] };
  const stock = new Map<string, Awaited<ReturnType<PharmacySimulator["stock"]>>>();
  for (const row of plan.rows) {
    if (!stock.has(row.pharmacy)) stock.set(row.pharmacy, await sim.stock(row.pharmacy));
    if (stock.get(row.pharmacy)!.has(row.medicineCode)) {
      report.skipped.push(row);
      continue;
    }
    if (options.dryRun) {
      report.added.push(row);
      continue;
    }
    try {
      await sim.addMedicine(row.pharmacy, row.medicineCode, row.quantity, row.price);
      report.added.push(row);
    } catch (err) {
      if (err instanceof SimulatorError && err.code === "ALREADY_STOCKED") report.skipped.push(row); // listed since we looked
      else throw err;
    }
  }
  return report;
}

/** Per-pharmacy and per-scenario counts, for printing. */
export function summarise(rows: PlannedRow[], pharmacies: readonly SeedPharmacy[] = PHARMACIES) {
  const byPharmacy: Record<string, { rows: number; inStock: number; low: number; zero: number }> = {};
  for (const p of pharmacies) byPharmacy[p.code] = { rows: 0, inStock: 0, low: 0, zero: 0 };
  for (const r of rows) {
    const s = (byPharmacy[r.pharmacy] ??= { rows: 0, inStock: 0, low: 0, zero: 0 });
    s.rows++;
    if (r.quantity === 0) s.zero++;
    else if (r.quantity <= 5) s.low++;
    else s.inStock++;
  }
  const byScenario: Record<string, number> = {};
  for (const r of rows) byScenario[r.scenario] = (byScenario[r.scenario] ?? 0) + 1;
  return { byPharmacy, byScenario };
}
