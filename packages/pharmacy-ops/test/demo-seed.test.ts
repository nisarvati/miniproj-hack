import { describe, expect, it } from "vitest";
import { directoryExtras, knownPharmacies, MEDICINES, PHARMACIES, shippedCatalogue, type Db } from "@medlink/db";
import { assertDemoSeedAllowed, DemoSeedBlocked, directorySeedTargets, directoryTargetProblem, LIST_PROBABILITY, planDemoSeed, tierOf, unit, type Candidate } from "../src/index.js";

const candidates: Candidate[] = [...MEDICINES.map((m) => ({ code: m.code, brand: m.brand })), ...shippedCatalogue().map((r) => ({ code: r.code, brand: r.brand }))];
const byBrand = (brand: string) => candidates.find((c) => c.brand === brand)!;
const rowsOf = (plan: ReturnType<typeof planDemoSeed>, brand: string) => plan.rows.filter((r) => r.medicineCode === byBrand(brand).code);
const key = (plan: ReturnType<typeof planDemoSeed>) => JSON.stringify(plan.rows);

describe("planDemoSeed", () => {
  it("is deterministic: the same seed gives the same plan", () => {
    expect(key(planDemoSeed(candidates, "s1"))).toBe(key(planDemoSeed(candidates, "s1")));
    expect(key(planDemoSeed([...candidates].reverse(), "s1"))).toBe(key(planDemoSeed(candidates, "s1")));
    expect(planDemoSeed(candidates).seed).toBe("medlink-demo-1");
  });

  it("a different seed gives a different spread but the same intentional scenarios", () => {
    const a = planDemoSeed(candidates, "alpha");
    const b = planDemoSeed(candidates, "beta");
    expect(key(a)).not.toBe(key(b));
    for (const plan of [a, b]) {
      const multi = rowsOf(plan, "Amlong");
      expect(multi.map((r) => r.pharmacy)).toEqual(PHARMACIES.map((p) => p.code));
      expect(multi.every((r) => r.quantity > 0 && r.scenario === "multi-price")).toBe(true);
      expect(new Set(multi.map((r) => r.price)).size).toBe(5); // five pharmacies, five different prices
      expect(rowsOf(plan, "Retaunch")).toMatchObject([{ pharmacy: "P002", quantity: 14, scenario: "single-pharmacy" }]);
      expect(rowsOf(plan, "Cabgolin")).toMatchObject([{ pharmacy: "P004", quantity: 0, scenario: "zero-stock" }]);
      expect(plan.unlisted.map((c) => c.brand).sort()).toEqual(["Dutas", "Nefrozon"]);
      for (const c of plan.unlisted) expect(plan.rows.some((r) => r.medicineCode === c.code)).toBe(false);
    }
    // The random part differs in prices as well as in who lists what.
    expect(rowsOf(a, "Amlong").map((r) => r.price)).not.toEqual(rowsOf(b, "Amlong").map((r) => r.price));
  });

  it("produces valid, unique rows that fit the pharmacy schema, for existing pharmacies and catalogue medicines only", () => {
    const plan = planDemoSeed(candidates);
    const pairs = plan.rows.map((r) => `${r.pharmacy}|${r.medicineCode}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const known = new Set(candidates.map((c) => c.code));
    const seeded = new Set(MEDICINES.map((m) => m.code));
    for (const r of plan.rows) {
      expect(PHARMACIES.map((p) => p.code)).toContain(r.pharmacy);
      expect(known.has(r.medicineCode)).toBe(true);
      expect(seeded.has(r.medicineCode)).toBe(false); // the demo medicines keep their own stock
      expect(Number.isInteger(r.quantity) && r.quantity >= 0).toBe(true);
      expect(r.price).toBeGreaterThan(0);
      expect(Math.abs(r.price * 100 - Math.round(r.price * 100))).toBeLessThan(1e-6);
    }
  });

  it("lists common medicines in more pharmacies than rare ones, and includes low and zero stock", () => {
    const plan = planDemoSeed(candidates);
    const avg = (tier: string) => {
      const codes = candidates.filter((c) => c.code > "M015" && tierOf(c.code) === tier && !plan.unlisted.some((u) => u.code === c.code) && !["Amlong", "Retaunch", "Cabgolin"].includes(c.brand));
      return plan.rows.filter((r) => codes.some((c) => c.code === r.medicineCode)).length / codes.length;
    };
    expect(avg("common")).toBeGreaterThan(avg("mid"));
    expect(avg("mid")).toBeGreaterThan(avg("rare"));
    expect(LIST_PROBABILITY.common).toBeGreaterThan(LIST_PROBABILITY.rare);
    expect(plan.rows.some((r) => r.quantity === 0 && r.scenario === "random")).toBe(true);
    expect(plan.rows.some((r) => r.quantity > 0 && r.quantity <= 5)).toBe(true);
    // Some catalogue medicines are listed by nobody, beyond the two reserved ones.
    const listed = new Set(plan.rows.map((r) => r.medicineCode));
    expect(candidates.filter((c) => c.code > "M015" && !listed.has(c.code)).length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to a seeded pick when a scenario medicine is not in the catalogue", () => {
    const small = candidates.filter((c) => !["Retaunch", "Cabgolin"].includes(c.brand));
    const plan = planDemoSeed(small, "x");
    expect(plan.rows.filter((r) => r.scenario === "single-pharmacy")).toHaveLength(1);
    expect(plan.rows.filter((r) => r.scenario === "zero-stock")).toHaveLength(1);
    expect(key(plan)).toBe(key(planDemoSeed(small, "x")));
  });

  it("unit() is stable and in range", () => {
    expect(unit("a", "b")).toBe(unit("a", "b"));
    expect(unit("a", "b")).not.toBe(unit("a", "c"));
    for (let i = 0; i < 200; i++) expect(unit("s", String(i))).toBeGreaterThanOrEqual(0);
  });
});

describe("planDemoSeed with the independent directory pharmacies configured", () => {
  const all = knownPharmacies();
  const five = planDemoSeed(candidates, "x");
  const twenty = planDemoSeed(candidates, "x", all); // original five + the directory pharmacies

  it("gives the original five exactly what they get without the extras", () => {
    expect(JSON.stringify(twenty.rows.filter((r) => PHARMACIES.some((p) => p.code === r.pharmacy)))).toBe(JSON.stringify(five.rows));
    expect(planDemoSeed(candidates, "x", PHARMACIES).rows).toEqual(five.rows);
  });

  it("spreads stock over every configured pharmacy, with their own prices", () => {
    const perPharmacy = new Map<string, number>();
    for (const r of twenty.rows) perPharmacy.set(r.pharmacy, (perPharmacy.get(r.pharmacy) ?? 0) + 1);
    expect([...perPharmacy.keys()].sort()).toEqual(all.map((p) => p.code).sort());
    for (const n of perPharmacy.values()) expect(n).toBeGreaterThan(20);
    const amlong = twenty.rows.filter((r) => r.scenario === "multi-price");
    expect(amlong).toHaveLength(all.length);
    expect(new Set(amlong.map((r) => r.price)).size).toBe(all.length); // different prices across pharmacies
  });

  it("keeps the intentional scenarios, and is deterministic", () => {
    expect(twenty.rows.filter((r) => r.scenario === "single-pharmacy").map((r) => r.pharmacy)).toEqual(["P002"]);
    expect(twenty.rows.filter((r) => r.scenario === "zero-stock").map((r) => [r.pharmacy, r.quantity])).toEqual([["P004", 0]]);
    for (const c of twenty.unlisted) expect(twenty.rows.some((r) => r.medicineCode === c.code)).toBe(false);
    expect(JSON.stringify(planDemoSeed(candidates, "x", all))).toBe(JSON.stringify(twenty));
  });

  it("only plans rows for pharmacies it was given", () => {
    const some = planDemoSeed(candidates, "x", all.filter((p) => ["P001", "P006"].includes(p.code)));
    expect([...new Set(some.rows.map((r) => r.pharmacy))].sort()).toEqual(["P001", "P006"]);
  });
});

describe("assertDemoSeedAllowed", () => {
  const local = Object.fromEntries(PHARMACIES.map((p) => [p.code, `postgres://pharmacy_${p.code.toLowerCase()}:pw@localhost:5433/pharmacy_${p.code.toLowerCase()}`]));
  const env = { DATABASE_URL: "postgres://medlink:pw@localhost:5433/medlink" } as NodeJS.ProcessEnv;
  const blocked = (e: NodeJS.ProcessEnv, urls = local) => {
    try {
      assertDemoSeedAllowed(e, urls);
    } catch (err) {
      expect(err).toBeInstanceOf(DemoSeedBlocked);
      return (err as DemoSeedBlocked).reasons.join(" | ");
    }
    return null;
  };

  it("allows local development and isolated test databases", () => {
    expect(blocked(env)).toBeNull();
    expect(blocked({ ...env, NODE_ENV: "development", MEDLINK_ENV: "local" })).toBeNull();
    expect(blocked({ DATABASE_URL: "postgres://m:pw@127.0.0.1:5433/medlink_test" }, Object.fromEntries(Object.entries(local).map(([c, u]) => [c, u + "_test"])))).toBeNull();
  });

  it("blocks production, however it is signalled", () => {
    expect(blocked({ ...env, NODE_ENV: "production" })).toMatch(/production/);
    expect(blocked({ ...env, MEDLINK_ENV: "production" })).toMatch(/MEDLINK_ENV/);
    expect(blocked({ ...env, APP_ENV: "staging" })).toMatch(/APP_ENV/);
  });

  it("blocks any database that is not on this machine, or looks like production", () => {
    expect(blocked({ DATABASE_URL: "postgres://m:pw@db.example.com:5432/medlink" })).toMatch(/DATABASE_URL points at db.example.com/);
    expect(blocked(env, { ...local, P003: "postgres://u:pw@10.0.0.5:5432/pharmacy_p003" })).toMatch(/PHARMACY_P003_DATABASE_URL points at 10.0.0.5/);
    expect(blocked({ DATABASE_URL: "postgres://m:pw@localhost:5433/medlink_prod" })).toMatch(/production/);
  });

  it("blocks when the environment cannot be identified", () => {
    expect(blocked({})).toMatch(/DATABASE_URL is not set/);
    expect(blocked({ DATABASE_URL: "not a url" })).toMatch(/not a valid URL/);
  });
});

describe("directory pharmacies are seeded only on explicit request", () => {
  const extra = directoryExtras()[0]!.code;
  const plan = planDemoSeed(candidates, "s1", directorySeedTargets([extra]));
  const fakeDb = (profile: { pharmacy_code: string }[] | Error, stock: { medicine_code: string; quantity: number; price: string }[]) =>
    ({
      query: async (sql: string) => {
        if (sql.includes("pharmacy_profile")) {
          if (profile instanceof Error) throw profile;
          return { rows: profile };
        }
        return { rows: stock };
      },
    }) as unknown as Db;

  it("the default plan covers only P001 to P005", () => {
    expect([...new Set(planDemoSeed(candidates).rows.map((r) => r.pharmacy))]).toEqual(["P001", "P002", "P003", "P004", "P005"]);
  });

  it("only directory codes can be named; the original five and unknown codes are rejected", () => {
    expect(directorySeedTargets([extra]).map((p) => p.code)).toEqual([extra]);
    expect(() => directorySeedTargets(["P001"])).toThrow(DemoSeedBlocked);
    expect(() => directorySeedTargets(["P999"])).toThrow(/not a directory pharmacy/);
  });

  it("adding a directory pharmacy does not change what P001 to P005 would get", () => {
    const withExtra = planDemoSeed(candidates, "s1", [...PHARMACIES, ...directorySeedTargets([extra])]);
    expect(withExtra.rows.filter((r) => r.pharmacy !== extra)).toEqual(planDemoSeed(candidates, "s1").rows);
  });

  it("accepts an empty set-up database and a repeat run, refuses anything else", async () => {
    const mine = plan.rows.filter((r) => r.pharmacy === extra);
    const first = mine[0]!;
    expect(await directoryTargetProblem(fakeDb([{ pharmacy_code: extra }], []), extra, plan)).toBeNull();
    const own = [{ medicine_code: first.medicineCode, quantity: first.quantity, price: String(first.price) }];
    expect(await directoryTargetProblem(fakeDb([{ pharmacy_code: extra }], own), extra, plan)).toBeNull();
    expect(await directoryTargetProblem(fakeDb([{ pharmacy_code: extra }], [{ ...own[0]!, quantity: first.quantity + 1 }]), extra, plan)).toMatch(/did not write/);
    expect(await directoryTargetProblem(fakeDb([{ pharmacy_code: extra }], [{ medicine_code: "M001", quantity: 1, price: "1" }]), extra, plan)).toMatch(/did not write/);
    expect(await directoryTargetProblem(fakeDb([], []), extra, plan)).toMatch(/no profile/);
    expect(await directoryTargetProblem(fakeDb(new Error("relation does not exist"), []), extra, plan)).toMatch(/no pharmacy schema/);
    expect(await directoryTargetProblem(fakeDb([{ pharmacy_code: "P001" }], []), extra, plan)).toMatch(/belongs to P001/);
  });

  it("the environment guard still refuses production hosts and database names for a directory database", () => {
    const base = { DATABASE_URL: "postgres://u:p@localhost:5432/medlink" };
    expect(() => assertDemoSeedAllowed(base, { [extra]: "postgres://u:p@localhost:5432/pharmacy_x" })).not.toThrow();
    expect(() => assertDemoSeedAllowed(base, { [extra]: "postgres://u:p@db.example.com:5432/pharmacy_x" })).toThrow(DemoSeedBlocked);
    expect(() => assertDemoSeedAllowed(base, { [extra]: "postgres://u:p@localhost:5432/pharmacy_prod" })).toThrow(DemoSeedBlocked);
    expect(() => assertDemoSeedAllowed({ ...base, NODE_ENV: "production" }, {})).toThrow(DemoSeedBlocked);
  });
});
