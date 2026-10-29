import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import {
  MAX_EXPORT_ROWS, PharmacySimulator, PlanError, plansToCsv, RestockPlanner, TRANSITIONS, validateNotes, validateQuantity, validateTargetDate,
  type PlanStatus,
} from "../src/index.js";

let admin: Db;
let pools: Record<string, Db>;
let urls: Record<string, string>;
const P1 = "P001";
const P2 = "P002";
const NOW = new Date("2026-11-01T10:00:00Z");
const planner = () => new RestockPlanner(pools, () => NOW);
let plans: RestockPlanner;

beforeAll(async () => {
  admin = await freshSeededDb();
  urls = await freshPharmacyDbs(admin);
  pools = { P001: createPool(urls.P001!), P002: createPool(urls.P002!) };
  plans = planner();
});
afterAll(async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  await admin.end();
});
beforeEach(async () => {
  for (const code of [P1, P2]) {
    await pools[code]!.query("DELETE FROM inventory");
    await setupPharmacyDatabase(code, urls[code]!);
    await pools[code]!.query("UPDATE inventory SET quantity = 12");
    await pools[code]!.query("TRUNCATE outbox, inventory_movements, stock_alerts, restock_plans");
  }
});

const input = (over: Record<string, unknown> = {}) => ({ medicineCode: "M001", quantity: 50, targetDate: "2026-11-05", ...over }) as Parameters<RestockPlanner["create"]>[1];
const refusal = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as PlanError;
const rowOf = async (planId: string, code = P1) => (await pools[code]!.query("SELECT *, to_char(target_date,'YYYY-MM-DD') AS d FROM restock_plans WHERE plan_id = $1", [planId])).rows[0];
const forceStatus = (planId: string, status: PlanStatus) =>
  pools[P1]!.query("UPDATE restock_plans SET status = $2, completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE NULL END WHERE plan_id = $1", [planId, status]);

/** Everything a plan must never change: stock, movements, outbox, alerts. */
async function stockState(code = P1) {
  const db = pools[code]!;
  return {
    inventory: (await db.query("SELECT medicine_code, quantity, price, updated_at FROM inventory ORDER BY medicine_code")).rows,
    movements: (await db.query("SELECT count(*) FROM inventory_movements")).rows[0].count,
    outbox: (await db.query("SELECT count(*) FROM outbox")).rows[0].count,
    alerts: (await db.query("SELECT count(*) FROM stock_alerts")).rows[0].count,
  };
}

describe("validation helpers", () => {
  it("accepts a real date from yesterday (UTC) to two years ahead, and refuses everything else", () => {
    expect(validateTargetDate("2026-10-31", NOW)).toBe("2026-10-31");
    expect(validateTargetDate("2026-11-01", NOW)).toBe("2026-11-01");
    expect(validateTargetDate("2028-10-31", NOW)).toBe("2028-10-31");
    for (const bad of ["2026-10-30", "2028-11-02", "2026-13-01", "2026-02-30", "2026-00-10", "11/05/2026", "2026-1-5", "2026-11-05T00:00:00Z", "", " 2026-11-05", null, undefined, 20261105, {}]) {
      expect(() => validateTargetDate(bad, NOW), String(bad)).toThrow(PlanError);
    }
    expect(() => validateTargetDate("2027-02-29", NOW)).toThrow(/real calendar date/); // 2027 is not a leap year
    expect(validateTargetDate("2028-02-29", NOW)).toBe("2028-02-29"); // 2028 is
  });

  it("accepts whole quantities from 1 to 1,000,000 only", () => {
    expect(validateQuantity(1)).toBe(1);
    expect(validateQuantity(1_000_000)).toBe(1_000_000);
    for (const bad of [0, -1, 1.5, 1_000_001, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) expect(() => validateQuantity(bad), String(bad)).toThrow(PlanError);
  });

  it("trims notes, turns empty into none, and refuses (not cuts) a long or non-text note", () => {
    expect(validateNotes("  call the wholesaler  ")).toBe("call the wholesaler");
    expect(validateNotes("   ")).toBeNull();
    expect(validateNotes(null)).toBeNull();
    expect(validateNotes(undefined)).toBeNull();
    expect(validateNotes("x".repeat(500))).toHaveLength(500);
    expect(() => validateNotes("x".repeat(501))).toThrow(PlanError);
    expect(() => validateNotes(42)).toThrow(PlanError);
  });
});

describe("creating a plan", () => {
  it("makes a PLANNED plan for the pharmacy, with the stock for context", async () => {
    const p = await plans.create(P1, input({ notes: "  from the usual wholesaler " }), 7);
    expect(p).toMatchObject({ pharmacyCode: P1, medicineCode: "M001", plannedQuantity: 50, status: "PLANNED", targetDate: "2026-11-05", notes: "from the usual wholesaler", createdByUserId: 7, completedAt: null, currentQuantity: 12 });
    expect(p.planId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.createdAt.getTime()).toBe(p.updatedAt.getTime());
    expect(await plans.get(P1, p.planId)).toEqual(p);
  });

  it.each([
    ["zero quantity", { quantity: 0 }],
    ["negative quantity", { quantity: -5 }],
    ["fractional quantity", { quantity: 2.5 }],
    ["string quantity", { quantity: "10" }],
    ["huge quantity", { quantity: 2_000_000 }],
    ["a bad date", { targetDate: "2026-02-30" }],
    ["a past date", { targetDate: "2026-10-01" }],
    ["no date", { targetDate: undefined }],
    ["long notes", { notes: "x".repeat(501) }],
    ["a malformed medicine code", { medicineCode: "crocin" }],
    ["no medicine code", { medicineCode: undefined }],
  ])("refuses %s and stores nothing", async (_name, over) => {
    expect((await refusal(plans.create(P1, input(over)))).code).toBe("INVALID");
    expect((await pools[P1]!.query("SELECT count(*) FROM restock_plans")).rows[0].count).toBe("0");
  });

  it("refuses a medicine the pharmacy does not list, even if another pharmacy does", async () => {
    await new PharmacySimulator(pools).removeMedicine(P1, "M002");
    expect((await refusal(plans.create(P1, input({ medicineCode: "M002" })))).code).toBe("NOT_STOCKED");
    expect((await refusal(plans.create(P1, input({ medicineCode: "M999" })))).code).toBe("NOT_STOCKED");
    expect((await plans.create(P2, input({ medicineCode: "M002" }))).pharmacyCode).toBe(P2); // P002 does list it
  });

  it("allows one open plan per medicine: a second is refused with the open one named", async () => {
    const first = await plans.create(P1, input());
    const err = await refusal(plans.create(P1, input({ quantity: 10 })));
    expect(err.code).toBe("PLAN_ALREADY_OPEN");
    expect(err.details).toEqual({ planId: first.planId, status: "PLANNED" });
    await plans.update(P1, first.planId, { status: "IN_PROGRESS" });
    expect((await refusal(plans.create(P1, input()))).details).toMatchObject({ planId: first.planId, status: "IN_PROGRESS" });
    expect((await plans.create(P1, input({ medicineCode: "M002" }))).medicineCode).toBe("M002"); // another medicine is fine
  });

  it("allows a new plan once the earlier one is completed or cancelled", async () => {
    const a = await plans.create(P1, input());
    await plans.update(P1, a.planId, { status: "COMPLETED" });
    const b = await plans.create(P1, input());
    await plans.update(P1, b.planId, { status: "CANCELLED" });
    const c = await plans.create(P1, input());
    expect([a.planId, b.planId, c.planId]).toHaveLength(3);
    expect((await plans.list(P1, { status: "ALL", limit: 10, offset: 0 })).total).toBe(3);
  });

  it("creates exactly one plan when many identical requests arrive at once", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => plans.create(P1, input())));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect((r.reason as PlanError).code).toBe("PLAN_ALREADY_OPEN");
    expect((await pools[P1]!.query("SELECT count(*) FROM restock_plans")).rows[0].count).toBe("1");
  });
});

describe("the lifecycle", () => {
  const ALL: PlanStatus[] = ["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

  it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))("%s -> %s", async (from, to) => {
    const p = await plans.create(P1, input());
    await forceStatus(p.planId, from);
    const allowed = from !== to && TRANSITIONS[from].includes(to);
    if (allowed) {
      const after = await plans.update(P1, p.planId, { status: to });
      expect(after.status).toBe(to);
      expect(after.completedAt !== null).toBe(to === "COMPLETED"); // set on completing, cleared on leaving it
    } else {
      expect((await refusal(plans.update(P1, p.planId, { status: to }))).code).toBe("INVALID_TRANSITION");
      expect((await rowOf(p.planId)).status).toBe(from); // nothing changed
    }
  });

  it("matches the documented table", () => {
    expect(TRANSITIONS).toEqual({ PLANNED: ["IN_PROGRESS", "COMPLETED", "CANCELLED"], IN_PROGRESS: ["PLANNED", "COMPLETED", "CANCELLED"], COMPLETED: ["IN_PROGRESS"], CANCELLED: [] });
  });

  it("stamps the completion time on completing, clears it on reopening, and moves updatedAt each time", async () => {
    const p = await plans.create(P1, input());
    const done = await plans.update(P1, p.planId, { status: "COMPLETED" });
    expect(done.completedAt).not.toBeNull();
    expect(done.updatedAt.getTime()).toBeGreaterThanOrEqual(p.updatedAt.getTime());
    const reopened = await plans.update(P1, p.planId, { status: "IN_PROGRESS" });
    expect(reopened).toMatchObject({ status: "IN_PROGRESS", completedAt: null });
    expect((await rowOf(p.planId)).completed_at).toBeNull();
    const cancelled = await plans.update(P1, p.planId, { status: "CANCELLED" });
    expect(cancelled).toMatchObject({ status: "CANCELLED", completedAt: null });
    expect(cancelled.updatedAt.getTime()).toBeGreaterThanOrEqual(reopened.updatedAt.getTime());
  });

  it("refuses to reopen a plan while another is open for the same medicine, and leaves it completed", async () => {
    const a = await plans.create(P1, input());
    await plans.update(P1, a.planId, { status: "COMPLETED" });
    const b = await plans.create(P1, input());
    const err = await refusal(plans.update(P1, a.planId, { status: "IN_PROGRESS" }));
    expect(err.code).toBe("PLAN_ALREADY_OPEN");
    expect(err.details?.planId).toBe(b.planId);
    expect((await rowOf(a.planId)).status).toBe("COMPLETED");
  });

  it("applies two conflicting changes made at once one after the other: one wins, the other is checked against it", async () => {
    const p = await plans.create(P1, input());
    const results = await Promise.allSettled([plans.update(P1, p.planId, { status: "COMPLETED" }), plans.update(P1, p.planId, { status: "CANCELLED" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1); // CANCELLED/COMPLETED cannot follow one another
    const row = await rowOf(p.planId);
    expect(["COMPLETED", "CANCELLED"]).toContain(row.status);
    expect(row.completed_at !== null).toBe(row.status === "COMPLETED");
  });

  it("answers an unknown plan with NOT_FOUND", async () => {
    expect((await refusal(plans.update(P1, "00000000-0000-4000-8000-000000000000", { status: "COMPLETED" }))).code).toBe("NOT_FOUND");
    expect(await plans.get(P1, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("editing and rescheduling", () => {
  it("reschedules by changing only the target date and the update time", async () => {
    const p = await plans.create(P1, input({ notes: "keep" }));
    const after = await plans.update(P1, p.planId, { targetDate: "2026-11-20" });
    expect(after).toMatchObject({ targetDate: "2026-11-20", status: "PLANNED", plannedQuantity: 50, notes: "keep", createdAt: p.createdAt, completedAt: null });
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(p.updatedAt.getTime());
  });

  it("changes the quantity and the notes of an open plan, and can clear the notes", async () => {
    const p = await plans.create(P1, input({ notes: "first" }));
    expect(await plans.update(P1, p.planId, { quantity: 80, notes: "second" })).toMatchObject({ plannedQuantity: 80, notes: "second" });
    expect((await plans.update(P1, p.planId, { notes: null })).notes).toBeNull();
    await plans.update(P1, p.planId, { status: "IN_PROGRESS" });
    expect((await plans.update(P1, p.planId, { targetDate: "2026-12-01" })).targetDate).toBe("2026-12-01"); // in progress is still open
  });

  it("refuses to edit a completed or cancelled plan, or to edit while completing or cancelling", async () => {
    const p = await plans.create(P1, input());
    expect((await refusal(plans.update(P1, p.planId, { status: "COMPLETED", quantity: 99 }))).code).toBe("PLAN_CLOSED");
    expect((await rowOf(p.planId)).status).toBe("PLANNED"); // the whole change was refused
    await plans.update(P1, p.planId, { status: "COMPLETED" });
    expect((await refusal(plans.update(P1, p.planId, { targetDate: "2026-12-01" }))).code).toBe("PLAN_CLOSED");
    expect((await refusal(plans.update(P1, p.planId, { notes: "x" }))).code).toBe("PLAN_CLOSED");
    // Reopening and editing in one change is fine: the plan is open when the edit applies.
    expect(await plans.update(P1, p.planId, { status: "IN_PROGRESS", quantity: 60 })).toMatchObject({ status: "IN_PROGRESS", plannedQuantity: 60, completedAt: null });
    await plans.update(P1, p.planId, { status: "CANCELLED" });
    expect((await refusal(plans.update(P1, p.planId, { quantity: 5 }))).code).toBe("PLAN_CLOSED");
    expect((await refusal(plans.update(P1, p.planId, { status: "PLANNED" }))).code).toBe("INVALID_TRANSITION");
  });

  it.each([
    ["an empty change", {}],
    ["a bad status", { status: "DONE" }],
    ["a bad quantity", { quantity: 0 }],
    ["a bad date", { targetDate: "soon" }],
    ["a past date", { targetDate: "2026-01-01" }],
    ["long notes", { notes: "x".repeat(600) }],
  ])("refuses %s and changes nothing", async (_name, patch) => {
    const p = await plans.create(P1, input());
    const before = await rowOf(p.planId);
    expect((await refusal(plans.update(P1, p.planId, patch as never))).code).toBe("INVALID");
    expect(await rowOf(p.planId)).toEqual(before);
  });

  it("does not keep a history of reschedules: only the current date and the update time", async () => {
    const p = await plans.create(P1, input());
    await plans.update(P1, p.planId, { targetDate: "2026-11-10" });
    await plans.update(P1, p.planId, { targetDate: "2026-11-15" });
    const cols = (await pools[P1]!.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'restock_plans'")).rows.map((r) => r.column_name);
    expect(cols.some((c) => /prev|history|resched|audit/i.test(c))).toBe(false);
  });
});

describe("listing", () => {
  it("lists soonest target first with a fixed tie order, filters by status, and pages", async () => {
    const codes = ["M001", "M002", "M003", "M004"];
    const made = [];
    for (const [i, c] of codes.entries()) made.push(await plans.create(P1, input({ medicineCode: c, targetDate: ["2026-11-09", "2026-11-03", "2026-11-03", "2026-11-20"][i] })));
    await plans.update(P1, made[3]!.planId, { status: "COMPLETED" });
    await plans.update(P1, made[0]!.planId, { status: "IN_PROGRESS" });
    const all = await plans.list(P1, { status: "ALL", limit: 10, offset: 0 });
    expect(all.total).toBe(4);
    expect(all.items.map((p) => p.medicineCode)).toEqual(["M002", "M003", "M001", "M004"]); // by date, then oldest first
    expect((await plans.list(P1, { status: "OPEN", limit: 10, offset: 0 })).items.map((p) => p.medicineCode)).toEqual(["M002", "M003", "M001"]);
    expect((await plans.list(P1, { status: "COMPLETED", limit: 10, offset: 0 })).items.map((p) => p.medicineCode)).toEqual(["M004"]);
    expect((await plans.list(P1, { status: "IN_PROGRESS", limit: 10, offset: 0 })).total).toBe(1);
    expect((await plans.list(P1, { status: "CANCELLED", limit: 10, offset: 0 })).total).toBe(0);
    const p1 = await plans.list(P1, { status: "ALL", limit: 3, offset: 0 });
    const p2 = await plans.list(P1, { status: "ALL", limit: 3, offset: 3 });
    expect([...p1.items, ...p2.items].map((p) => p.medicineCode)).toEqual(["M002", "M003", "M001", "M004"]);
    expect(p2.total).toBe(4);
  });
});

describe("pharmacies stay apart", () => {
  it("one pharmacy cannot list, read or change another's plan", async () => {
    const mine = await plans.create(P1, input());
    const theirs = await plans.create(P2, input());
    expect((await plans.list(P1, { status: "ALL", limit: 10, offset: 0 })).items.map((p) => p.planId)).toEqual([mine.planId]);
    expect((await plans.list(P2, { status: "ALL", limit: 10, offset: 0 })).items.map((p) => p.planId)).toEqual([theirs.planId]);
    expect(await plans.get(P2, mine.planId)).toBeNull();
    expect((await refusal(plans.update(P2, mine.planId, { status: "CANCELLED" }))).code).toBe("NOT_FOUND");
    expect((await rowOf(mine.planId)).status).toBe("PLANNED");
    expect((await plans.forExport(P2, "ALL")).plans.map((p) => p.planId)).toEqual([theirs.planId]);
    // Each pharmacy may have its own open plan for the same medicine.
    expect([mine.medicineCode, theirs.medicineCode]).toEqual(["M001", "M001"]);
  });

  it("answers an unknown pharmacy clearly", async () => {
    expect((await refusal(plans.list("P999", { status: "ALL", limit: 1, offset: 0 }))).message).toMatch(/Unknown pharmacy/);
  });
});

describe("a plan never changes stock", () => {
  it("creating, editing, rescheduling, starting, completing, reopening and cancelling leave stock, history, outbox and alerts exactly as they were", async () => {
    await pools[P1]!.query("UPDATE inventory SET quantity = 3 WHERE medicine_code = 'M001'"); // low stock, as a plan usually starts from
    const before = await stockState();
    const p = await plans.create(P1, input({ quantity: 100 }));
    await plans.update(P1, p.planId, { quantity: 120, notes: "bigger order" });
    await plans.update(P1, p.planId, { targetDate: "2026-12-01" });
    await plans.update(P1, p.planId, { status: "IN_PROGRESS" });
    await plans.update(P1, p.planId, { status: "COMPLETED" });
    await plans.update(P1, p.planId, { status: "IN_PROGRESS" });
    await plans.update(P1, p.planId, { status: "CANCELLED" });
    const q = await plans.create(P1, input({ medicineCode: "M002" }));
    await plans.update(P1, q.planId, { status: "COMPLETED" });
    await plans.list(P1, { status: "ALL", limit: 10, offset: 0 });
    await plans.forExport(P1, "ALL");
    expect(await stockState()).toEqual(before);
    expect(before.inventory.find((r) => r.medicine_code === "M001")!.quantity).toBe(3);
  });

  it("only the recorded restock changes stock, and it writes the movement and the outbox event", async () => {
    const sim = new PharmacySimulator(pools);
    const p = await plans.create(P1, input({ quantity: 40 }));
    await plans.update(P1, p.planId, { status: "COMPLETED" });
    expect((await stockState()).inventory.find((r) => r.medicine_code === "M001")!.quantity).toBe(12); // "completed" brought nothing in
    const r = await sim.recordRestock(P1, "M001", 40, { actorUserId: 1 });
    const after = await stockState();
    expect(after.inventory.find((x) => x.medicine_code === "M001")!.quantity).toBe(52);
    expect(after).toMatchObject({ movements: "1", outbox: "1" });
    expect(r.movement).toMatchObject({ operation: "RESTOCK", quantityBefore: 12, quantityAfter: 52 });
    expect((await plans.get(P1, p.planId))).toMatchObject({ status: "COMPLETED", currentQuantity: 52 }); // the plan shows the stock but did not cause it
  });

  it("the planner source never writes the tables that hold stock or events", async () => {
    const { readFileSync } = await import("node:fs");
    // Code only: the comments in this file explain the separation, so they name the very things the code must not touch.
    const src = readFileSync(new URL("../src/restock-plans.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+(inventory|outbox|inventory_movements|stock_alerts)\b/i);
    expect(src).not.toMatch(/redis/i);
  });
});

describe("open plans for the alerts", () => {
  it("finds the open plan of each medicine, and none once it is completed or cancelled", async () => {
    const a = await plans.create(P1, input({ medicineCode: "M001" }));
    const b = await plans.create(P1, input({ medicineCode: "M002" }));
    await plans.update(P1, b.planId, { status: "COMPLETED" });
    const open = await plans.openPlans(P1, ["M001", "M002", "M003"]);
    expect([...open.keys()]).toEqual(["M001"]);
    expect(open.get("M001")).toEqual({ planId: a.planId, status: "PLANNED", targetDate: "2026-11-05" });
    expect((await plans.openPlans(P2, ["M001"])).size).toBe(0);
    expect((await plans.openPlans(P1, [])).size).toBe(0);
  });

  it("is simply empty where the database has no restock_plans table yet", async () => {
    await pools[P1]!.query("ALTER TABLE restock_plans RENAME TO restock_plans_away");
    try {
      expect((await plans.openPlans(P1, ["M001"])).size).toBe(0);
    } finally {
      await pools[P1]!.query("ALTER TABLE restock_plans_away RENAME TO restock_plans");
    }
  });
});

describe("export rows", () => {
  it("builds CSV with the header, the plan's own values, and an empty file for no plans", async () => {
    const empty = plansToCsv([], new Map());
    expect(empty).toBe("plan_id,medicine_code,medicine_name,planned_quantity,status,target_date,created_at,updated_at,completed_at,notes\r\n");
    const p = await plans.create(P1, input({ notes: "=cmd|' /C calc'!A0, urgent" }));
    await plans.update(P1, p.planId, { status: "COMPLETED" });
    const csv = plansToCsv([(await plans.get(P1, p.planId))!], new Map([["M001", "Crocin 500mg"]]));
    const [, row] = csv.trimEnd().split("\r\n");
    expect(row).toContain(`${p.planId},M001,Crocin 500mg,50,COMPLETED,2026-11-05,`);
    expect(row).toMatch(/"'=cmd\|' \/C calc'!A0, urgent"$/); // the note is defused and quoted
    expect(row!.split(",").length).toBeGreaterThanOrEqual(10);
  });

  it("is capped, and says so", async () => {
    await pools[P1]!.query(
      `INSERT INTO restock_plans (medicine_code, planned_quantity, status, target_date, completed_at)
       SELECT 'M001', 1, 'COMPLETED', DATE '2026-12-01', now() FROM generate_series(1, $1)`,
      [MAX_EXPORT_ROWS + 5],
    );
    const out = await plans.forExport(P1, "ALL");
    expect(out.plans).toHaveLength(MAX_EXPORT_ROWS);
    expect(out.truncated).toBe(true);
    expect((await plans.forExport(P1, "CANCELLED")).truncated).toBe(false);
  });
});

describe("the schema itself", () => {
  it("refuses states the code would never write", async () => {
    const insert = (cols: string, vals: string) => pools[P1]!.query(`INSERT INTO restock_plans (medicine_code, planned_quantity, target_date ${cols}) VALUES ('M001', 5, '2026-11-05' ${vals})`);
    await expect(insert(", status", ", 'DONE'")).rejects.toThrow(/status/);
    await expect(insert(", completed_at", ", now()")).rejects.toThrow(/completed_at/); // a completion time on a PLANNED plan
    await expect(insert(", status", ", 'COMPLETED'")).rejects.toThrow(/completed_at/); // COMPLETED with none
    await expect(pools[P1]!.query("INSERT INTO restock_plans (medicine_code, planned_quantity, target_date) VALUES ('M001', 0, '2026-11-05')")).rejects.toThrow(/planned_quantity/);
    await expect(pools[P1]!.query("INSERT INTO restock_plans (medicine_code, planned_quantity, target_date) VALUES ('crocin', 5, '2026-11-05')")).rejects.toThrow(/medicine_code/);
    await expect(pools[P1]!.query("INSERT INTO restock_plans (medicine_code, planned_quantity, target_date, notes) VALUES ('M001', 5, '2026-11-05', '')")).rejects.toThrow(/notes/);
  });
});
