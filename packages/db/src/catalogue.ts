import { readFileSync } from "node:fs";
import type { Db } from "./pool.js";

/**
 * The central medicine catalogue: which products exist, so they can be found. Nothing here says a pharmacy stocks a
 * product. Stock, price and freshness only ever arrive through a pharmacy's own database and the sync pipeline.
 *
 * Catalogue batches are JSON files in packages/db/catalogue/. `importCatalogue` applies one idempotently to `medicines`.
 */

export type CatalogueVerification = "retail-listings" | "manufacturer-document" | "multiple-sources" | "official-list" | "single-source";

export interface CatalogueRecord {
  /** Stable public code ("M016"): how pharmacy databases and events refer to the product. Never reassigned. */
  code: string;
  kind: "brand" | "generic";
  brand: string;
  generic: string;
  /** Strength in the form the search understands: "500mg", "400mg/325mg", "5%", "60000iu", "10g/15ml". */
  dosage: string;
  form: string;
  category?: string;
  status: "verified";
  /** Reference data kept with the batch; the medicines table has no columns for them. */
  manufacturer?: string;
  pack?: string;
  sources: string[];
  verification: CatalogueVerification;
  evidence?: string;
}

/** A name that could not be confidently resolved. Reported, never imported. */
export interface ReviewRecord {
  kind: "brand" | "generic";
  brand: string;
  status: "needs-review";
  reason: string;
}

export interface CatalogueBatch {
  batch: string;
  description?: string;
  verifiedOn?: string;
  sources: Record<string, string>;
  records: Array<CatalogueRecord | ReviewRecord>;
}

export const CATALOGUE_DIR = new URL("../catalogue/", import.meta.url);
export const DEFAULT_CATALOGUE_BATCH = new URL("batch-001.json", CATALOGUE_DIR);

export function readCatalogueBatch(file: URL | string = DEFAULT_CATALOGUE_BATCH): CatalogueBatch {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as CatalogueBatch;
  if (!parsed || !Array.isArray(parsed.records)) throw new Error(`Catalogue file ${String(file)} has no "records" array`);
  return parsed;
}

/** Verified products of the shipped batch(es), for tools that need to know which codes are real (the simulator, the portal). */
let shipped: CatalogueRecord[] | undefined;
export function shippedCatalogue(): CatalogueRecord[] {
  shipped ??= readCatalogueBatch().records.filter((r): r is CatalogueRecord => r.status === "verified");
  return shipped;
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const variantKey = (r: { brand: string; dosage: string; form: string }) => `${r.brand}|${r.dosage}|${r.form}`.toLowerCase();

// Same units the search parser recognises, so a product can be found by its strength ("Zerodol 100mg", "minoxidil 5%").
const NUM = "\\d+(?:\\.\\d+)?";
const UNIT = "(?:mg|mcg|g|ml|iu|%)";
const DOSAGE = new RegExp(`^${NUM}${UNIT}(?:/${NUM}${UNIT})*$`);
const VERIFICATIONS: readonly string[] = ["retail-listings", "manufacturer-document", "multiple-sources", "official-list", "single-source"];

/** Why a record cannot be imported, or null if it is well formed. Pure; no database access. */
export function validateRecord(raw: unknown): string | null {
  const r = raw as Partial<CatalogueRecord> | null;
  if (!r || typeof r !== "object") return "not an object";
  if (r.status !== "verified") return `status must be "verified" (got ${JSON.stringify(r.status)})`;
  if (typeof r.code !== "string" || !/^M\d{3,}$/.test(r.code)) return `code must look like M016 (got ${JSON.stringify(r.code)})`;
  for (const field of ["brand", "generic", "form"] as const) {
    if (!clean(r[field])) return `${field} is required`;
  }
  if (!clean(r.dosage) || !DOSAGE.test(clean(r.dosage))) {
    return `dosage must be a strength such as 500mg, 10mg/5mg, 5% or 60000iu (got ${JSON.stringify(r.dosage)})`;
  }
  if (clean(r.dosage) !== clean(r.dosage).toLowerCase()) return "dosage must be lower case";
  if (clean(r.form) !== clean(r.form).toLowerCase()) return "form must be lower case";
  if (r.kind !== "brand" && r.kind !== "generic") return `kind must be "brand" or "generic"`;
  if (!Array.isArray(r.sources) || r.sources.length === 0 || r.sources.some((s) => typeof s !== "string" || !/^https:\/\//.test(s))) {
    return "at least one https source is required";
  }
  if (!r.verification || !VERIFICATIONS.includes(r.verification)) return `verification must be one of ${VERIFICATIONS.join(", ")}`;
  return null;
}

export interface ImportReport {
  dryRun: boolean;
  /** New rows in `medicines`. */
  imported: { code: string; name: string }[];
  /** Already in the catalogue under the same code: left untouched. */
  matched: { code: string; name: string }[];
  /** Names flagged "needs-review" in the batch. */
  skipped: { name: string; reason: string }[];
  /** Records that were not imported because they are malformed, duplicated or would collide with existing identities. */
  rejected: { name: string; reason: string }[];
}

const label = (r: { brand: string; dosage?: string; form?: string }) => [r.brand, r.dosage, r.form].filter(Boolean).join(" ");

/**
 * Idempotent: running it again imports nothing and matches everything. It only ever INSERTs missing products. It never
 * updates an existing medicine and never touches `inventory`, so pharmacy stock and prices cannot change. One
 * transaction. A dry run opens it READ ONLY and issues no INSERT at all, so it cannot consume identity-sequence values
 * (a rolled-back INSERT would); the report is the same because every check reads the database and the batch, not
 * the rows it would add.
 */
export async function importCatalogue(db: Db, batch: CatalogueBatch, options: { dryRun?: boolean } = {}): Promise<ImportReport> {
  const report: ImportReport = { dryRun: !!options.dryRun, imported: [], matched: [], skipped: [], rejected: [] };
  const client = await db.connect();
  try {
    await client.query(options.dryRun ? "BEGIN READ ONLY" : "BEGIN");
    const seenVariants = new Set<string>();
    const seenCodes = new Set<string>();

    for (const raw of batch.records) {
      if ((raw as ReviewRecord).status === "needs-review") {
        const r = raw as ReviewRecord;
        report.skipped.push({ name: clean(r.brand), reason: clean(r.reason) });
        continue;
      }
      const problem = validateRecord(raw);
      const r = raw as CatalogueRecord;
      if (problem) {
        report.rejected.push({ name: clean(r?.brand) || "(unnamed)", reason: problem });
        continue;
      }
      const rec = { ...r, brand: clean(r.brand), generic: clean(r.generic), dosage: clean(r.dosage), form: clean(r.form) };
      const name = label(rec);

      const key = variantKey(rec);
      if (seenVariants.has(key)) {
        report.rejected.push({ name, reason: "duplicate of another record in this batch (same brand, dosage and form)" });
        continue;
      }
      if (seenCodes.has(rec.code)) {
        report.rejected.push({ name, reason: `code ${rec.code} is used by another record in this batch` });
        continue;
      }
      seenVariants.add(key);
      seenCodes.add(rec.code);

      const existing = await client.query<{ code: string; generic_name: string }>(
        "SELECT code, generic_name FROM medicines WHERE lower(brand_name) = lower($1) AND lower(dosage) = lower($2) AND lower(form) = lower($3)",
        [rec.brand, rec.dosage, rec.form],
      );
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.code !== rec.code) {
          report.rejected.push({ name, reason: `already in the catalogue as ${row.code}; the batch says ${rec.code}. Identifiers are never changed` });
        } else if (row.generic_name.toLowerCase() !== rec.generic.toLowerCase()) {
          report.rejected.push({ name, reason: `already ${row.code} with generic "${row.generic_name}", not "${rec.generic}". Existing records are never overwritten` });
        } else {
          report.matched.push({ code: rec.code, name });
        }
        continue;
      }
      const taken = await client.query<{ brand_name: string }>("SELECT brand_name FROM medicines WHERE code = $1", [rec.code]);
      if (taken.rows[0]) {
        report.rejected.push({ name, reason: `code ${rec.code} already belongs to "${taken.rows[0].brand_name}"` });
        continue;
      }
      if (!options.dryRun) {
        await client.query("INSERT INTO medicines (code, brand_name, generic_name, dosage, form) VALUES ($1, $2, $3, $4, $5)", [
          rec.code,
          rec.brand,
          rec.generic,
          rec.dosage,
          rec.form,
        ]);
      }
      report.imported.push({ code: rec.code, name });
    }

    await client.query(options.dryRun ? "ROLLBACK" : "COMMIT");
    return report;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
