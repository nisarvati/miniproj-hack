import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Db } from "./pool.js";
import { PHARMACIES, type SeedPharmacy } from "./seed-data.js";

/**
 * The pharmacy registry: the five original demo pharmacies (seed-data, unchanged) plus a directory of real Mumbai
 * locations used as DEMO LISTINGS (packages/db/pharmacy-directory/mumbai-demo.json).
 *
 * Directory pharmacies are inactive until configured: one only joins `activePharmacies` when its own
 * PHARMACY_<code>_DATABASE_URL is set, because every pharmacy owns a separate database. Nothing here provisions anything.
 */

export interface DirectorySource {
  url: string;
  type: string;
  /** What this source establishes, in a sentence. */
  verifies: string;
  /** How it was checked: read directly, or only seen as a search-result snippet. */
  inspected: string;
  /** false for a source that merely repeats another (an OpenStreetMap-derived directory): it does not count as corroboration. */
  countsAsIndependent?: boolean;
}

export interface LocationCandidate {
  latitude: number;
  longitude: number;
  source: string;
  kind: string;
  note: string;
}

/**
 * "verified": two independent map sources agree within 100 m; latitude and longitude are then set.
 * Anything else keeps only the observed `candidates`, which are never used for directions or distances.
 */
export interface DirectoryLocation {
  status: "verified" | "single-source" | "conflicting" | "unavailable";
  /**
   * How a verified point was established. Absent or "two-sources": two independent map sources agree within 100 m (the default rule).
   * "openstreetmap-node": the project owner decided (2026-10-30) that one OpenStreetMap pharmacy node may verify a point when its name
   * and address were re-read and match the listing. It must be declared; it is never inferred, and it never applies to a directory point.
   */
  basis?: "two-sources" | "openstreetmap-node";
  latitude?: number;
  longitude?: number;
  kind?: string;
  candidates: LocationCandidate[];
  note: string;
}

export interface DirectoryPharmacy {
  /** The proposed pharmacy ID. */
  code: string;
  /**
   * "display-mapping": the app SHOWS this name and address for the existing demo pharmacy with the same ID (P001 to P005). The persisted
   * rows, databases, inventory, events and Redis state stay the fictional demo identity; nothing is renamed or registered.
   * "inactive-until-configured": a new ID that joins only when its database URL is set.
   */
  status: "display-mapping" | "inactive-until-configured";
  /** For a display mapping, the fictional demo identity (as persisted) it is shown over. */
  displaysOver?: string;
  /** The business name exactly as publicly listed. */
  name: string;
  neighbourhood: string;
  /** The requested target area, e.g. "Andheri West". */
  area: string;
  address: string;
  addressAsListed: string;
  location: DirectoryLocation;
  confidence: "high" | "medium" | "low";
  classification: { independent: "established" | "single-outlet-evidence"; evidence: string[] };
  sources: DirectorySource[];
  discrepancies: string[];
  checkedOn: string;
  demo: true;
  label: string;
}

/**
 * A research lead that is NOT an accepted directory pharmacy. It never becomes a pharmacy row, a database, an inventory provider
 * or a registration, and it can never carry a verified point (an entry with one would have been accepted). It exists so the lead,
 * its address as supplied, and why it is not accepted are recorded and shown honestly.
 *   provisional: found in one source at (or near) the supplied address; not corroborated.
 *   needs-review: not found, conflicting, or too incomplete to place.
 *   excluded: a chain or franchise, closed, or a duplicate.
 */
export interface DirectoryCandidate {
  code: string;
  name: string;
  area: string;
  /** The address exactly as supplied by the requester; never completed or corrected here. */
  address: string;
  addressStatus: "complete" | "incomplete";
  listingStatus: "provisional" | "needs-review" | "excluded";
  reason: string;
  location: { status: "single-source" | "unavailable"; candidates: LocationCandidate[]; note: string };
  classification: { independent: "unknown" | "single-outlet-evidence" | "chain"; note: string };
  sources: DirectorySource[];
  checkedOn: string;
  demo: true;
  label: string;
}

export interface Directory {
  directory: string;
  label: string;
  description: string;
  retrieved: string;
  method: string;
  locationRule: string;
  verification: string;
  notVerified: { name: string; reason: string }[];
  excluded: { name: string; reason: string }[];
  /** Candidates whose location is known but whose ownership or location could not be settled: never registered. */
  unresolved: { name: string; area: string; reason: string }[];
  pharmacies: DirectoryPharmacy[];
  /** Leads that are not accepted pharmacies (see DirectoryCandidate). Optional so older files still load. */
  candidates?: DirectoryCandidate[];
}

export const DEMO_LISTING_LABEL = "Demo directory listing — not a confirmed MedLink partner.";

export const DIRECTORY_FILE = new URL("../pharmacy-directory/mumbai-demo.json", import.meta.url);

let cached: Directory | undefined;
export function readDirectory(file: URL | string = DIRECTORY_FILE): Directory {
  if (file !== DIRECTORY_FILE) return JSON.parse(readFileSync(file, "utf8")) as Directory;
  cached ??= JSON.parse(readFileSync(DIRECTORY_FILE, "utf8")) as Directory;
  return cached;
}

export const directoryPharmacies = (): DirectoryPharmacy[] => readDirectory().pharmacies;

const isBaseCode = (code: string) => PHARMACIES.some((p) => p.code === code);

/** Directory entries that would add a new pharmacy (P006 and up). */
export const directoryExtras = (): DirectoryPharmacy[] => directoryPharmacies().filter((p) => !isBaseCode(p.code));

/** Directory entries shown over an existing demo pharmacy (P001 to P005). Presentation only: the persisted identity is unchanged. */
export const displayMappings = (): DirectoryPharmacy[] => directoryPharmacies().filter((p) => isBaseCode(p.code));

/** The verified point of an entry, or null when the location is not verified. */
export const verifiedPoint = (p: DirectoryPharmacy): { latitude: number; longitude: number } | null =>
  p.location.status === "verified" && typeof p.location.latitude === "number" && typeof p.location.longitude === "number" ? { latitude: p.location.latitude, longitude: p.location.longitude } : null;

/** True for pharmacies the app shows under a directory identity (the real independent candidates), whether over a demo ID or a new one. */
export const isIndependentListing = (code: string): boolean => directoryPharmacies().some((p) => p.code === code);

/** False when the directory identity's map point is not verified: clients then give directions by address and show no distance or pin. */
export const hasVerifiedLocation = (code: string): boolean => {
  const entry = directoryPharmacies().find((p) => p.code === code);
  if (!entry && directoryCandidates().some((c) => c.code === code)) return false; // a lead is never a verified location
  return entry ? verifiedPoint(entry) !== null : true;
};

/** What the API and the app show for one pharmacy: the persisted row, presented through the directory identity when there is one. */
export interface PharmacyPresentation {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  demo: boolean;
  independent: boolean;
  locationVerified: boolean;
  /** true: any stock shown for it is synthetic demo data that the named pharmacy has not confirmed. */
  inventorySimulated: boolean;
}

/**
 * Presents a persisted pharmacy row. With a directory identity: its name and address, its VERIFIED point if it has one (otherwise
 * the row's own demo point is kept only for internal ranking and is flagged unverified so clients neither pin nor measure it),
 * and the flags that mark it a demo directory listing with simulated inventory. Without one, the row passes through unchanged.
 * Pure: it reads nothing from the database and writes nothing.
 */
export function presentPharmacy(row: { code: string; name: string; address: string; latitude: number; longitude: number }): PharmacyPresentation {
  const entry = directoryPharmacies().find((p) => p.code === row.code);
  if (!entry) return { name: row.name, address: row.address, latitude: row.latitude, longitude: row.longitude, demo: isDemoPharmacy(row.code), independent: false, locationVerified: true, inventorySimulated: isDemoPharmacy(row.code) };
  const point = verifiedPoint(entry);
  return { name: entry.name, address: entry.address, latitude: point?.latitude ?? row.latitude, longitude: point?.longitude ?? row.longitude, demo: true, independent: true, locationVerified: point !== null, inventorySimulated: true };
}

/** True for every pharmacy MedLink knows today: all of them are demo listings with synthetic stock. */
export const isDemoPharmacy = (code: string): boolean => isBaseCode(code) || directoryExtras().some((p) => p.code === code);

/** Every code a pharmacy can have, active or not. */
export const knownPharmacyCodes = (): string[] => [...PHARMACIES.map((p) => p.code), ...directoryExtras().map((p) => p.code)];

/** A stable, synthetic price level for a directory pharmacy (0.92 to 1.08), so its demo prices differ from the others'. */
export function priceFactorFor(code: string): number {
  const u = createHash("sha256").update(`price-factor:${code}`).digest().readUInt32BE(0) / 0x1_0000_0000;
  return Math.round((0.92 + u * 0.16) * 100) / 100;
}

/** An unverified location has no usable point: it is NaN so nothing can accidentally rank or route by it. */
const asSeed = (p: DirectoryPharmacy): SeedPharmacy => {
  const point = verifiedPoint(p);
  return { code: p.code, name: p.name, address: p.address, latitude: point?.latitude ?? Number.NaN, longitude: point?.longitude ?? Number.NaN, priceFactor: priceFactorFor(p.code) };
};

/** The original five plus every directory pharmacy that adds a new ID, configured or not (for validating a code, not for connecting). */
export const knownPharmacies = (): SeedPharmacy[] => [...PHARMACIES, ...directoryExtras().map(asSeed)];

export const pharmacyUrlEnv = (code: string) => `PHARMACY_${code}_DATABASE_URL`;

/**
 * The pharmacies in use: the original five always, plus each directory pharmacy whose database URL is configured.
 * With nothing extra configured this is exactly the original five.
 */
export function activePharmacies(env: NodeJS.ProcessEnv = process.env): SeedPharmacy[] {
  const extra = directoryExtras()
    .filter((p) => !!env[pharmacyUrlEnv(p.code)])
    .map(asSeed);
  return [...PHARMACIES, ...extra];
}

/** The database URL of every active pharmacy; throws naming what is missing for the original five. */
export function loadActivePharmacyUrls(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const urls: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of activePharmacies(env)) {
    const v = env[pharmacyUrlEnv(p.code)];
    if (v) urls[p.code] = v;
    else missing.push(pharmacyUrlEnv(p.code));
  }
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  return urls;
}

const distanceM = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** Why a directory entry is malformed or misleading, or null if it is well formed. (Registrability is `registrationBlocker`.) */
export function validateDirectoryEntry(p: DirectoryPharmacy): string | null {
  if (!/^P\d{3,}$/.test(p.code)) return `bad code ${p.code}`;
  if (p.status !== "display-mapping" && p.status !== "inactive-until-configured") return "status must be display-mapping or inactive-until-configured";
  if (p.status === "display-mapping" && (!isBaseCode(p.code) || !p.displaysOver?.trim())) return "a display mapping must use an existing demo pharmacy's ID and name the demo identity it is shown over";
  if (p.status === "inactive-until-configured" && isBaseCode(p.code)) return `${p.code} is one of the original pharmacies: use status display-mapping`;
  for (const f of ["name", "neighbourhood", "area", "address", "addressAsListed", "checkedOn"] as const) if (!p[f]?.trim()) return `${f} is required`;
  const loc = p.location;
  if (!loc || !["verified", "single-source", "conflicting", "unavailable"].includes(loc.status) || !Array.isArray(loc.candidates) || !loc.note?.trim()) return "a location status, candidates and note are required";
  for (const c of loc.candidates) {
    if (!Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return "location candidates need coordinates";
    if (c.latitude < 18.85 || c.latitude > 19.35 || c.longitude < 72.75 || c.longitude > 73.25) return "coordinates are outside the Mumbai region";
    if (!c.source?.startsWith("https://")) return "every location candidate needs an https source";
  }
  if (loc.status === "verified") {
    if (typeof loc.latitude !== "number" || typeof loc.longitude !== "number") return "a verified location needs coordinates";
    const point = { latitude: loc.latitude, longitude: loc.longitude };
    const near = loc.candidates.filter((c) => distanceM(point, c) <= 100);
    if (loc.basis === "openstreetmap-node") {
      if (!near.some((c) => c.kind === "osm-storefront-node" && c.source.startsWith("https://www.openstreetmap.org/node/"))) return "an OpenStreetMap-verified location needs an OpenStreetMap pharmacy node within 100 m of the point";
    } else if (new Set(near.map((c) => c.source)).size < 2) return "a verified location needs two independent map sources within 100 m of the point";
  } else if (loc.latitude !== undefined || loc.longitude !== undefined) {
    return "only a verified location may carry coordinates; an unverified one keeps its observed points as candidates";
  }
  if (loc.status === "conflicting") {
    const pts = loc.candidates;
    if (pts.length < 2 || !pts.some((a) => pts.some((b) => distanceM(a, b) > 100))) return "a conflicting location needs at least two candidates more than 100 m apart";
  }
  if (!Array.isArray(p.sources) || p.sources.length < 2) return "at least two sources are required";
  if (p.sources.some((s) => !s.url?.startsWith("https://") || !s.verifies?.trim() || !s.type || !s.inspected?.trim())) return "every source needs an https url, a type, what it verifies and how it was inspected";
  if (p.sources.filter((s) => s.countsAsIndependent !== false).length < 2) return "at least two independent sources are required (a directory that copies OpenStreetMap does not count)";
  if (!["high", "medium", "low"].includes(p.confidence)) return "a confidence level is required";
  if (!p.classification || !["established", "single-outlet-evidence"].includes(p.classification.independent) || !p.classification.evidence?.length) return "evidence that this is an independent local pharmacy is required";
  if (!Array.isArray(p.discrepancies)) return "discrepancies must be listed (an empty list if none)";
  if (p.demo !== true) return "every directory entry must be flagged demo";
  if (p.label !== DEMO_LISTING_LABEL) return "the demo, non-partnership label is missing";
  return null;
}

export const directoryCandidates = (): DirectoryCandidate[] => readDirectory().candidates ?? [];

/**
 * How Google Maps directions may be offered for a lead: "address" (a complete address found in a listing), "approximate" (a
 * complete address that is only a lead, never confirmed), or "unavailable" (incomplete address, or a chain/closed/duplicate).
 * Candidates never use coordinates.
 */
export function candidateDirections(c: Pick<DirectoryCandidate, "listingStatus" | "addressStatus">): "address" | "approximate" | "unavailable" {
  if (c.listingStatus === "excluded" || c.addressStatus !== "complete") return "unavailable";
  return c.listingStatus === "provisional" ? "address" : "approximate";
}

/** Why a candidate is malformed or misleading, or null if it is well formed. */
export function validateCandidate(c: DirectoryCandidate): string | null {
  if (!/^P\d{3,}$/.test(c.code)) return `bad code ${c.code}`;
  if (isBaseCode(c.code)) return `${c.code} is one of the original pharmacies`;
  if (directoryPharmacies().some((p) => p.code === c.code)) return `${c.code} is already an accepted directory pharmacy`;
  for (const f of ["name", "area", "address", "reason", "checkedOn"] as const) if (!c[f]?.trim()) return `${f} is required`;
  if (!["provisional", "needs-review", "excluded"].includes(c.listingStatus)) return "listingStatus must be provisional, needs-review or excluded";
  if (!["complete", "incomplete"].includes(c.addressStatus)) return "addressStatus must be complete or incomplete";
  if (!c.location || !["single-source", "unavailable"].includes(c.location.status) || !Array.isArray(c.location.candidates) || !c.location.note?.trim()) return "a candidate's location is single-source or unavailable, with candidates and a note; it can never be verified";
  if ("latitude" in c.location || "longitude" in c.location) return "a candidate carries no coordinates of its own, only observed candidate points";
  if (c.location.status === "unavailable" && c.location.candidates.length) return "an unavailable location has no candidate points";
  if (c.location.status === "single-source" && c.location.candidates.length !== 1) return "a single-source location has exactly one candidate point";
  for (const p of c.location.candidates) {
    if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || p.latitude < 18.85 || p.latitude > 19.35 || p.longitude < 72.75 || p.longitude > 73.25) return "candidate points need coordinates inside the Mumbai region";
    if (!p.source?.startsWith("https://")) return "every candidate point needs an https source";
  }
  if (c.sources.some((s) => !s.url?.startsWith("https://") || !s.verifies?.trim() || !s.type || !s.inspected?.trim())) return "every source needs an https url, a type, what it verifies and how it was inspected";
  if (c.listingStatus === "provisional" && !c.sources.length) return "a provisional lead needs at least one source";
  if (c.listingStatus === "excluded" && c.classification?.independent !== "chain" && !/closed|duplicate/i.test(c.reason)) return "an excluded lead must be a chain, closed or a duplicate";
  if (!c.classification || !["unknown", "single-outlet-evidence", "chain"].includes(c.classification.independent) || !c.classification.note?.trim()) return "a classification and note are required";
  if (c.demo !== true) return "every directory entry must be flagged demo";
  if (c.label !== DEMO_LISTING_LABEL) return "the demo, non-partnership label is missing";
  return null;
}

/** Why an entry cannot be added to the central pharmacies table, or null if it can. */
export function registrationBlocker(p: DirectoryPharmacy): string | null {
  const bad = validateDirectoryEntry(p);
  if (bad) return bad;
  if (p.status === "display-mapping") return `${p.code} is shown over an existing demo pharmacy; its persisted row is not renamed or registered`;
  if (!verifiedPoint(p)) return `the location is "${p.location.status}", not verified; the central table needs a verified point and distances must not be claimed from an unverified one`;
  return null;
}

export interface RegisterReport {
  dryRun: boolean;
  registered: string[];
  alreadyRegistered: string[];
  conflicts: { code: string; reason: string }[];
}

/**
 * Adds the given directory pharmacies to the central `pharmacies` table (a plain INSERT: no migration, no change to
 * existing rows). An existing row is never updated; a code or name+address that already exists with different data is
 * reported as a conflict. The caller chooses which pharmacies (normally the configured ones).
 */
export async function registerPharmacies(central: Db, entries: DirectoryPharmacy[], options: { dryRun?: boolean } = {}): Promise<RegisterReport> {
  const report: RegisterReport = { dryRun: !!options.dryRun, registered: [], alreadyRegistered: [], conflicts: [] };
  const client = await central.connect();
  try {
    await client.query(options.dryRun ? "BEGIN READ ONLY" : "BEGIN");
    for (const p of entries) {
      const bad = registrationBlocker(p);
      if (bad) {
        report.conflicts.push({ code: p.code, reason: bad });
        continue;
      }
      const byCode = await client.query<{ name: string; address: string; latitude: number; longitude: number }>("SELECT name, address, latitude, longitude FROM pharmacies WHERE code = $1", [p.code]);
      if (byCode.rows[0]) {
        const r = byCode.rows[0];
        if (r.name === p.name && r.address === p.address && r.latitude === p.location.latitude && r.longitude === p.location.longitude) report.alreadyRegistered.push(p.code);
        else report.conflicts.push({ code: p.code, reason: `${p.code} already exists as "${r.name}"; existing rows are never changed` });
        continue;
      }
      const clash = await client.query<{ code: string }>("SELECT code FROM pharmacies WHERE name = $1 AND address = $2", [p.name, p.address]);
      if (clash.rows[0]) {
        report.conflicts.push({ code: p.code, reason: `name and address already belong to ${clash.rows[0].code}` });
        continue;
      }
      if (!options.dryRun) {
        await client.query("INSERT INTO pharmacies (code, name, address, latitude, longitude) VALUES ($1, $2, $3, $4, $5)", [p.code, p.name, p.address, p.location.latitude, p.location.longitude]);
      }
      report.registered.push(p.code);
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
