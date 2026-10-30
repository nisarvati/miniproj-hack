import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_LISTING_LABEL,
  activePharmacies,
  candidateDirections,
  directoryCandidates,
  directoryExtras,
  directoryPharmacies,
  hasVerifiedLocation,
  isDemoPharmacy,
  isIndependentListing,
  knownPharmacies,
  loadActivePharmacyUrls,
  displayMappings,
  presentPharmacy,
  priceFactorFor,
  readDirectory,
  registerPharmacies,
  registrationBlocker,
  seed,
  validateCandidate,
  validateDirectoryEntry,
  verifiedPoint,
  type Db,
  type DirectoryPharmacy,
} from "../src/index.js";
import { PHARMACIES } from "../src/seed-data.js";
import { freshSeededDb } from "../src/testing.js";

const full = readDirectory();
const dir = directoryPharmacies();
const baseEnv = Object.fromEntries(PHARMACIES.map((p) => [`PHARMACY_${p.code}_DATABASE_URL`, `postgres://u:pw@localhost:5433/${p.code}`]));

const CHAIN_OR_ONLINE = /apollo|1mg|tata|pharmeasy|netmeds|medplus|wellness|zeno|noble|guardian|frank ross|health\s*&?\s*glow|medlife|practo|truemeds|mg\s?365|lifecare|jan aushadhi|sanjeevani|healthkart|cure\s?fit|dava\s?india|davaindia|generic medicine/i;
const FICTIONAL = /Pharmacy [A-E] -/;

/** A registrable entry: a new ID with a verified location (two map sources agreeing). Built from a real entry so the shape is right. */
const registrable = (over: Partial<DirectoryPharmacy> = {}): DirectoryPharmacy => {
  const base = dir.find((p) => p.code === "P004")!;
  return { ...base, code: "P090", status: "inactive-until-configured", displaysOver: undefined, name: "Registrable Test Chemist", address: "1 Test Road, Bandra West, Mumbai 400050", ...over };
};

describe("the Mumbai demo directory of independent pharmacies", () => {
  it("holds up to 10 well-formed entries with unique IDs, proposed as P001 onwards", () => {
    expect(dir.length).toBeGreaterThanOrEqual(1);
    expect(dir.length).toBeLessThanOrEqual(10);
    expect(dir.map((p) => p.code)).toEqual(dir.map((_, i) => `P${String(1 + i).padStart(3, "0")}`));
    expect(new Set(dir.map((p) => p.name)).size).toBe(dir.length);
    for (const p of dir) expect(validateDirectoryEntry(p), p.code).toBeNull();
  });

  it("shows P001 to P005 as a display mapping over the existing demo pharmacies, never as a rename", () => {
    const mappings = displayMappings();
    expect(mappings.map((p) => p.code)).toEqual(["P001", "P002", "P003", "P004", "P005"]);
    expect(mappings.map((p) => p.displaysOver)).toEqual(["Pharmacy A - Andheri West", "Pharmacy B - Andheri East", "Pharmacy C - Juhu", "Pharmacy D - Bandra West", "Pharmacy E - Powai"]);
    expect(mappings.map((p) => p.name)).toEqual(["Paras Medical and General Store", "Roopam Medical and General Stores", "United Medical and General Stores", "Bandra Medical Stores", "Faiza Medical and General Stores"]);
    expect(mappings.map((p) => p.address)).toEqual([
      "35/D-2, Vaibhav CHS, SVP Nagar, Versova, Andheri West, Mumbai, Maharashtra 400053",
      "Shop 8, Shopping Centre, 18-A M.M. Road, Bhavani Nagar, Marol, Andheri East, Mumbai, Maharashtra 400059",
      "Chakala, Andheri East, Mumbai, Maharashtra 400099",
      "Shop 139, Hill Road, near Union Bank of India, Bandra West, Mumbai, Maharashtra 400050",
      "Shop 19, near Mina Centre, Ahmed Zakaria Nagar, Bandra East, Mumbai, Maharashtra 400051",
    ]);
    for (const p of mappings) {
      expect(p.status).toBe("display-mapping");
      expect(registrationBlocker(p)).toMatch(/shown over an existing demo pharmacy/);
    }
    // P003 invents no shop number: the exact storefront stays unestablished.
    expect(mappings[2]!.address).not.toMatch(/shop|no\.\s*\d/i);
    expect(mappings[2]!.addressAsListed).toMatch(/NOT established/);
    // The persisted fixtures are still the fictional demo pharmacies, and the registry does not add the mapped IDs as pharmacies.
    expect(PHARMACIES.map((p) => p.name)).toEqual(["Pharmacy A - Andheri West", "Pharmacy B - Andheri East", "Pharmacy C - Juhu", "Pharmacy D - Bandra West", "Pharmacy E - Powai"]);
    expect(knownPharmacies().slice(0, 5)).toEqual(PHARMACIES);
    expect(directoryExtras().map((p) => p.code)).toEqual(["P006"]);
  });

  it("presents a persisted row through its directory identity, with simulated inventory, and keeps unverified points out of use", () => {
    const row = (code: string) => ({ code, name: PHARMACIES.find((p) => p.code === code)!.name, address: "Fictional address", latitude: 19.1, longitude: 72.9 });
    const p1 = presentPharmacy(row("P001"));
    // Paras is verified from its OpenStreetMap node alone (basis "openstreetmap-node"), so its point is that node's, not the row's demo point.
    expect(p1).toMatchObject({ name: "Paras Medical and General Store", demo: true, independent: true, locationVerified: true, latitude: 19.13639, longitude: 72.82323, inventorySimulated: true });
    expect(p1.address).toBe(displayMappings()[0]!.address);
    // Roopam has two directory points 450 m apart and no OpenStreetMap record: unverified, so the row's demo point is kept only for internal ranking.
    const p2 = presentPharmacy(row("P002"));
    expect(p2).toMatchObject({ name: "Roopam Medical and General Stores", locationVerified: false, latitude: 19.1, longitude: 72.9 });
    const p4 = presentPharmacy(row("P004"));
    expect(p4).toMatchObject({ name: "Bandra Medical Stores", locationVerified: true, latitude: 19.05548, longitude: 72.83152, inventorySimulated: true });
    // A code with no directory identity passes through unchanged and is not marked independent.
    expect(presentPharmacy({ code: "P090", name: "X", address: "Y", latitude: 1, longitude: 2 })).toEqual({ name: "X", address: "Y", latitude: 1, longitude: 2, demo: false, independent: false, locationVerified: true, inventorySimulated: false });
  });

  it("excludes chains, online pharmacies and the earlier chain candidates", () => {
    for (const p of dir) {
      expect(`${p.name} ${p.address} ${p.sources.map((s) => s.url).join(" ")}`).not.toMatch(CHAIN_OR_ONLINE);
      expect(`${p.name} ${p.address}`).not.toMatch(FICTIONAL);
    }
    const excluded = full.excluded.map((e) => e.name).join(" | ");
    for (const n of ["Apollo", "Tata 1mg", "Zeno", "Noble", "Wellness Forever", "Dava India", "Jan Aushadhi"]) expect(excluded).toContain(n);
    for (const e of full.excluded) expect(e.reason.length).toBeGreaterThan(5);
    // A franchise of a chain found among your leads is recorded as unresolved with the reason.
    expect(full.unresolved.find((u) => u.name.startsWith("Jay Maharashtra"))!.reason).toMatch(/Dava India/);
  });

  it("records, for every source, what it verifies and whether it was read directly or only seen as a snippet", () => {
    for (const p of dir) {
      expect(p.sources.length).toBeGreaterThanOrEqual(2);
      expect(p.sources.filter((s) => s.countsAsIndependent !== false).length).toBeGreaterThanOrEqual(2);
      for (const s of p.sources) {
        expect(s.url.startsWith("https://")).toBe(true);
        expect(s.verifies.length).toBeGreaterThan(10);
        expect(s.inspected).toMatch(/directly|snippet/);
      }
      expect(p.checkedOn).toBe("2026-10-22");
      expect(["high", "medium", "low"]).toContain(p.confidence);
      expect(p.classification.evidence.length).toBeGreaterThan(0);
      expect(Array.isArray(p.discrepancies)).toBe(true);
      expect(p.area).toMatch(/Andheri|Bandra|Powai|Chandivali|Dadar|Borivali|Kandivali|Dombivli/);
      // No personal data in the record: no phone numbers or emails.
      expect(JSON.stringify(p).replace(/https?:\/\/[^"\s]+/g, "").replace(/node \d+/gi, "")).not.toMatch(/\+?\d{10,}|@[a-z0-9-]+\.[a-z]{2,}/i);
    }
    // A directory that copies OpenStreetMap never counts as a second source.
    for (const p of dir) for (const s of p.sources.filter((x) => x.type === "directory-derived-from-osm")) expect(s.countsAsIndependent).toBe(false);
    // The Justdial pages could not be read (403) and are never claimed as inspected directly.
    for (const p of dir) for (const s of p.sources.filter((x) => x.url.includes("justdial.com"))) expect(s.inspected).toMatch(/snippet/);
  });

  it("only treats a point as verified when two independent map sources agree, or an OpenStreetMap node is declared as the basis, and never invents one", () => {
    const verified = dir.filter((p) => p.location.status === "verified");
    expect(verified.map((p) => p.name)).toEqual(["Paras Medical and General Store", "United Medical and General Stores", "Bandra Medical Stores"]);
    for (const p of dir) {
      const point = verifiedPoint(p);
      if (p.location.status === "verified") {
        expect(point).not.toBeNull();
        if (p.location.basis === "openstreetmap-node") {
          // Declared, never inferred: an OpenStreetMap pharmacy node sits at the point.
          expect(p.location.candidates.some((c) => c.kind === "osm-storefront-node" && c.source.startsWith("https://www.openstreetmap.org/node/") && c.latitude === point!.latitude && c.longitude === point!.longitude)).toBe(true);
        } else {
          expect(new Set(p.location.candidates.map((c) => c.source)).size).toBeGreaterThanOrEqual(2);
        }
      } else {
        expect(point).toBeNull();
        expect(p.location.latitude).toBeUndefined(); // an unverified shop carries no coordinates, only observed candidates
        expect(hasVerifiedLocation(p.code)).toBe(false);
      }
      for (const c of p.location.candidates) expect(c.source.startsWith("https://")).toBe(true);
    }
    // Disagreeing directory points are kept as a conflict, not averaged or picked.
    const roopam = dir.find((p) => p.name.startsWith("Roopam"))!;
    expect(roopam.location.status).toBe("conflicting");
    expect(roopam.location.candidates).toHaveLength(2);
  });

  it("rejects coordinate claims that would mislead", () => {
    const base = dir.find((p) => p.name === "Bandra Medical Stores")!;
    const bad = (location: DirectoryPharmacy["location"]) => validateDirectoryEntry({ ...base, location });
    expect(bad({ ...base.location, latitude: 28.6 })).toMatch(/two independent map sources within 100 m/);
    expect(bad({ ...base.location, candidates: [base.location.candidates[0]!] })).toMatch(/two independent map sources/);
    expect(bad({ ...base.location, candidates: base.location.candidates.map((c) => ({ ...c, source: base.location.candidates[0]!.source })) })).toMatch(/two independent map sources/);
    expect(bad({ ...base.location, status: "single-source" })).toMatch(/only a verified location may carry coordinates/);
    expect(bad({ status: "conflicting", candidates: [base.location.candidates[0]!, base.location.candidates[1]!], note: "x" })).toMatch(/more than 100 m apart/);
    expect(bad({ status: "single-source", candidates: [{ ...base.location.candidates[0]!, latitude: 28.6 }], note: "x" })).toMatch(/outside the Mumbai region/);
  });

  it("accepts a single OpenStreetMap node as the basis only when it is declared, and still refuses everything else", () => {
    const paras = dir.find((p) => p.name.startsWith("Paras"))!;
    const bad = (location: DirectoryPharmacy["location"]) => validateDirectoryEntry({ ...paras, location });
    expect(validateDirectoryEntry(paras)).toBeNull();
    expect(bad({ ...paras.location, basis: undefined })).toMatch(/two independent map sources/); // one source is not enough unless the basis is declared
    expect(bad({ ...paras.location, basis: "two-sources" })).toMatch(/two independent map sources/);
    // The point must be at an OpenStreetMap pharmacy node, not at a directory's directions link and not somewhere else.
    expect(bad({ ...paras.location, latitude: 19.14, longitude: 72.84 })).toMatch(/OpenStreetMap pharmacy node within 100 m/);
    expect(bad({ ...paras.location, candidates: paras.location.candidates.map((c) => ({ ...c, kind: "directory-directions-link" })) })).toMatch(/OpenStreetMap pharmacy node within 100 m/);
    expect(bad({ ...paras.location, candidates: paras.location.candidates.map((c) => ({ ...c, source: "https://magicpin.in/x" })) })).toMatch(/OpenStreetMap pharmacy node within 100 m/);
    // Without a verified status the basis does nothing: coordinates are still refused.
    expect(bad({ ...paras.location, status: "single-source" })).toMatch(/only a verified location may carry coordinates/);
  });

  it("keeps the exact demo, non-partnership label on every entry and in the description", () => {
    expect(DEMO_LISTING_LABEL).toBe("Demo directory listing — not a confirmed MedLink partner.");
    expect(full.label).toBe(DEMO_LISTING_LABEL);
    expect(full.description).toMatch(/not MedLink partners/);
    expect(full.description).toMatch(/synthetic demo data/);
    expect(full.description).toMatch(/DISPLAY MAPPING/);
    expect(full.description).toMatch(/untouched/);
    for (const p of dir) {
      expect(p.demo).toBe(true);
      expect(p.label).toBe(DEMO_LISTING_LABEL);
    }
  });

  it("records what could not be verified instead of guessing", () => {
    const unresolved = full.unresolved.map((u) => u.name).join(" | ");
    for (const n of ["Arihant", "Annpurna", "Sangam Medical Stores", "Rajesh Medical", "New Grace", "Get Well", "Bombay Medical", "Siddh Ambica", "Medicentre", "Sahakar", "Golden Pharmacy", "Shree Laxmi", "Jai Gurudev"]) expect(unresolved).toContain(n);
    for (const u of full.unresolved) expect(u.reason.length).toBeGreaterThan(15);
    // Leads that failed verification are never in the directory.
    expect(dir.some((p) => /arihant|annpurna|sangam|rajesh|new grace|get\s?well|bombay medical|ambica|medicentre|sahakar|golden|laxmi|gurudev/i.test(p.name))).toBe(false);
    expect(full.notVerified.map((n) => n.name).join(" | ")).toContain("Noble Medicals");
  });

  it("rejects entries that would mislead", () => {
    const base = dir[0]!;
    const bad = (over: Partial<DirectoryPharmacy>) => validateDirectoryEntry({ ...base, ...over } as DirectoryPharmacy);
    expect(bad({ status: "inactive-until-configured" })).toMatch(/original pharmacies/);
    expect(bad({ displaysOver: undefined })).toMatch(/demo identity it is shown over/);
    expect(bad({ demo: false as never })).toMatch(/flagged demo/);
    expect(bad({ label: "Demo" })).toMatch(/label is missing/);
    expect(bad({ sources: [base.sources[0]!] })).toMatch(/at least two sources/);
    expect(bad({ sources: base.sources.map((s) => ({ ...s, countsAsIndependent: false })) })).toMatch(/two independent sources/);
    expect(bad({ sources: base.sources.map((s) => ({ ...s, inspected: "" })) })).toMatch(/how it was inspected/);
    expect(bad({ sources: base.sources.map((s, i) => (i ? { ...s, url: "http://x" } : s)) })).toMatch(/https url/);
    expect(bad({ classification: { independent: "established", evidence: [] } })).toMatch(/independent local pharmacy/);
    expect(bad({ name: " " })).toMatch(/name is required/);
  });
});

describe("the registry is configuration driven", () => {
  it("with nothing extra configured it is exactly the original five", () => {
    expect(activePharmacies(baseEnv).map((p) => p.code)).toEqual(["P001", "P002", "P003", "P004", "P005"]);
    expect(activePharmacies({})).toHaveLength(5);
    expect(Object.keys(loadActivePharmacyUrls(baseEnv))).toEqual(["P001", "P002", "P003", "P004", "P005"]);
    expect(activePharmacies(baseEnv).slice(0, 5)).toEqual(PHARMACIES);
  });

  it("a new directory pharmacy joins only when its own database URL is set, and a display mapping never does", () => {
    const extra = directoryExtras()[0]!;
    expect(extra.code).toBe("P006");
    expect(activePharmacies(baseEnv).some((p) => p.code === extra.code)).toBe(false);
    const env = { ...baseEnv, [`PHARMACY_${extra.code}_DATABASE_URL`]: "postgres://u:pw@localhost:5433/p6" };
    const active = activePharmacies(env);
    expect(active.map((p) => p.code)).toEqual(["P001", "P002", "P003", "P004", "P005", extra.code]);
    const joined = active.find((p) => p.code === extra.code)!;
    expect(joined.name).toBe(extra.name);
    expect(Number.isNaN(joined.latitude)).toBe(true); // unverified location: no usable point
    expect(Object.keys(loadActivePharmacyUrls(env))).toContain(extra.code);
    // Setting URLs for P001 to P005 changes nothing: those IDs are still the original fictional pharmacies.
    expect(activePharmacies(baseEnv).slice(0, 5).map((p) => p.name)).toEqual(PHARMACIES.map((p) => p.name));
  });

  it("still demands the original five", () => {
    expect(() => loadActivePharmacyUrls({})).toThrow(/PHARMACY_P001_DATABASE_URL/);
  });

  it("knows the IDs, flags every pharmacy as a demo listing, and treats every directory identity as independent", () => {
    expect(knownPharmacies()).toHaveLength(5 + directoryExtras().length);
    for (const p of knownPharmacies()) expect(isDemoPharmacy(p.code)).toBe(true);
    expect(isDemoPharmacy("P999")).toBe(false);
    for (const p of dir) expect(isIndependentListing(p.code)).toBe(true);
    expect(isIndependentListing("P090")).toBe(false);
    for (const code of ["P001", "P003", "P004"]) expect(hasVerifiedLocation(code)).toBe(true); // P004: two sources; P001, P003: an OpenStreetMap node
    for (const code of ["P002", "P005", "P006"]) expect(hasVerifiedLocation(code)).toBe(false); // conflicting, and no OpenStreetMap record found, respectively
    expect(hasVerifiedLocation("P090")).toBe(true); // not a directory identity: its row's point is used as before
  });

  it("gives directory pharmacies a stable synthetic price level", () => {
    for (const p of dir) {
      expect(priceFactorFor(p.code)).toBe(priceFactorFor(p.code));
      expect(priceFactorFor(p.code)).toBeGreaterThanOrEqual(0.92);
      expect(priceFactorFor(p.code)).toBeLessThanOrEqual(1.08);
    }
  });
});

describe("registerPharmacies (central table only)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await freshSeededDb();
  });
  beforeEach(async () => {
    await db.query("DELETE FROM pharmacies WHERE code > 'P005'");
    await seed(db);
  });
  afterAll(async () => {
    await db.end();
  });
  const rows = async () => (await db.query("SELECT code, name, address, latitude, longitude FROM pharmacies ORDER BY code")).rows;
  const count = async () => (await rows()).length;

  it("refuses every real directory entry today: display mappings are not registrations and unverified points cannot be registered", async () => {
    const before = await rows();
    const report = await registerPharmacies(db, dir);
    expect(report.registered).toEqual([]);
    expect(report.conflicts).toHaveLength(dir.length);
    expect(report.conflicts.filter((c) => /shown over an existing demo pharmacy/.test(c.reason)).map((c) => c.code)).toEqual(["P001", "P002", "P003", "P004", "P005"]);
    expect(report.conflicts.find((c) => c.code === "P006")!.reason).toMatch(/not verified/);
    expect(await rows()).toEqual(before); // the persisted P001 to P005 rows are untouched
  });

  it("a dry run reports a registrable entry and writes nothing, not even identity values", async () => {
    const before = await rows();
    const seq = (await db.query("SELECT last_value::text AS v, is_called FROM pharmacies_id_seq")).rows[0];
    const dry = await registerPharmacies(db, [registrable()], { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, registered: ["P090"], conflicts: [] });
    expect(await rows()).toEqual(before);
    expect((await db.query("SELECT last_value::text AS v, is_called FROM pharmacies_id_seq")).rows[0]).toEqual(seq);
  });

  it("registers a verified new pharmacy with its verified point, leaving the original five untouched, and is idempotent", async () => {
    const before = (await rows()).filter((r) => r.code <= "P005");
    const entry = registrable();
    expect((await registerPharmacies(db, [entry])).registered).toEqual(["P090"]);
    const after = await rows();
    expect(after.filter((r) => r.code <= "P005")).toEqual(before);
    expect(after.find((r) => r.code === "P090")).toEqual({ code: "P090", name: entry.name, address: entry.address, latitude: entry.location.latitude, longitude: entry.location.longitude });
    const again = await registerPharmacies(db, [entry]);
    expect(again.registered).toEqual([]);
    expect(again.alreadyRegistered).toEqual(["P090"]);
    expect(await count()).toBe(6);
  });

  it("never overwrites an existing row and reports the conflict", async () => {
    await db.query("INSERT INTO pharmacies (code, name, address, latitude, longitude) VALUES ('P090', 'Someone else', 'Elsewhere', 19.1, 72.9)");
    await db.query("INSERT INTO pharmacies (code, name, address, latitude, longitude) VALUES ('P091', 'Clash Chemist', 'Same Road', 19.1, 72.9)");
    const report = await registerPharmacies(db, [registrable(), registrable({ code: "P092", name: "Clash Chemist", address: "Same Road" })]);
    expect(report.conflicts.map((c) => c.code)).toEqual(["P090", "P092"]);
    expect(report.conflicts[0]!.reason).toMatch(/never changed/);
    expect(report.conflicts[1]!.reason).toMatch(/already belong to P091/);
    expect((await rows()).find((r) => r.code === "P090")!.name).toBe("Someone else");
  });

  it("refuses an unverified location without stopping the others", async () => {
    const unverified = registrable({ code: "P093", location: { status: "single-source", candidates: [registrable().location.candidates[0]!], note: "one source only" } });
    const report = await registerPharmacies(db, [unverified, registrable({ code: "P094", name: "Second Test Chemist" })]);
    expect(report.conflicts).toEqual([{ code: "P093", reason: expect.stringMatching(/not verified/) }]);
    expect(report.registered).toEqual(["P094"]);
  });
});

describe("directory candidates (research leads that are not accepted pharmacies)", () => {
  const cands = directoryCandidates();
  const byName = (n: string) => cands.find((c) => c.name.startsWith(n))!;

  it("are all well formed, with unique new IDs that never reuse an accepted pharmacy's ID", () => {
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) expect(validateCandidate(c), c.name).toBeNull();
    const codes = [...cands.map((c) => c.code), ...dir.map((p) => p.code)];
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of cands) expect(Number(c.code.slice(1))).toBeGreaterThan(6);
  });

  it("are separate from the pharmacies: never extras, never known, never active, never registrable", () => {
    for (const c of cands) {
      expect(directoryExtras().some((p) => p.code === c.code)).toBe(false);
      expect(knownPharmacies().some((p) => p.code === c.code)).toBe(false);
      expect(activePharmacies({ [`PHARMACY_${c.code}_DATABASE_URL`]: "postgres://u:pw@localhost/x", ...baseEnv }).some((p) => p.code === c.code)).toBe(false);
      expect(hasVerifiedLocation(c.code)).toBe(false);
      expect(isDemoPharmacy(c.code)).toBe(false);
    }
  });

  it("never carry a verified point, and a lead with a point keeps it only as an observed candidate", () => {
    for (const c of cands) {
      expect(["single-source", "unavailable"]).toContain(c.location.status);
      expect(c.location).not.toHaveProperty("latitude");
    }
    expect(byName("New Grace").location.candidates).toHaveLength(1);
  });

  it("keeps the chain candidate excluded and marks incomplete addresses so directions are not offered for them", () => {
    expect(byName("Zeelab")).toMatchObject({ listingStatus: "excluded", classification: { independent: "chain" } });
    expect(candidateDirections(byName("Zeelab"))).toBe("unavailable");
    expect(candidateDirections(byName("Sahakar"))).toBe("unavailable");
    expect(candidateDirections(byName("Annpurna"))).toBe("unavailable");
    expect(candidateDirections(byName("Arihant"))).toBe("approximate");
    expect(candidateDirections(byName("Golden"))).toBe("address");
  });

  it("separates the lead list into accepted, provisional, needs-review and excluded without losing any of your 18", () => {
    const names = [...cands.map((c) => c.name), ...dir.map((p) => p.name)].join(" | ");
    for (const n of ["Arihant", "Annpurna", "Roopam", "Sangam", "Rajesh", "New Grace", "Cure Chemist", "Bandra Medical Stores", "Faiza", "Mahavir", "Dharamnath", "Medicentre", "K.D. Chemist", "All India Drug House", "Sahakar", "Golden Pharmacy", "Shree Laxmi", "Zeelab"]) expect(names).toContain(n);
    expect(new Set(cands.map((c) => c.listingStatus))).toEqual(new Set(["provisional", "needs-review", "excluded"]));
  });

  it("rejects a malformed candidate", () => {
    const ok = byName("Golden");
    expect(validateCandidate({ ...ok, code: "P001" })).toMatch(/original/);
    expect(validateCandidate({ ...ok, code: "P006" })).toMatch(/already an accepted/);
    expect(validateCandidate({ ...ok, label: "x" })).toMatch(/label/);
    expect(validateCandidate({ ...ok, sources: [] })).toMatch(/at least one source/);
    expect(validateCandidate({ ...ok, location: { ...ok.location, latitude: 19.1 } as never })).toMatch(/no coordinates/);
    expect(validateCandidate({ ...byName("Zeelab"), classification: { independent: "unknown", note: "x" }, reason: "x" })).toMatch(/chain, closed or a duplicate/);
  });
});
