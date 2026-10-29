import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, setupPharmacyDatabase, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let admin: Db;
let pharmacies: Record<string, Db>;
let urls: Record<string, string>;
let app: FastifyInstance;
let a: string; // P001's session cookie
let b: string; // P002's
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" });

beforeAll(async () => {
  admin = await freshSeededDb();
  urls = await freshPharmacyDbs(admin);
  pharmacies = Object.fromEntries(Object.entries(urls).map(([code, url]) => [code, createPool(url)]));
  await admin.query("DELETE FROM pharmacy_users");
  await admin.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('a@pharmacy.test', $1, 'P001'), ('b@pharmacy.test', $2, 'P002')", [await hashPassword("pw-a"), await hashPassword("pw-b")]);
  app = await buildApp({ db: admin, pharmacies }, config, { logger: false });
  a = await login("a@pharmacy.test", "pw-a");
  b = await login("b@pharmacy.test", "pw-b");
});
afterAll(async () => {
  await app.close();
  await Promise.all(Object.values(pharmacies).map((p) => p.end()));
  await admin.end();
});
beforeEach(async () => {
  for (const code of ["P001", "P002"]) {
    await pharmacies[code]!.query("DELETE FROM inventory");
    await setupPharmacyDatabase(code, urls[code]!);
    await pharmacies[code]!.query("UPDATE inventory SET quantity = 12");
    await pharmacies[code]!.query("TRUNCATE outbox, inventory_movements, stock_alerts, restock_plans");
  }
});

async function login(email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/portal/login", payload: { email, password } });
  return String(res.headers["set-cookie"]).split(";")[0]!;
}
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined && { payload: payload as object }) });
/** A calendar day `n` days from today (UTC), as the planner counts it. */
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const body = (over: Record<string, unknown> = {}) => ({ medicineCode: "M001", quantity: 50, targetDate: inDays(5), ...over });
const make = async (cookie = a, over: Record<string, unknown> = {}) => (await call("POST", "/portal/restock-plans", cookie, body(over))).json().data as { planId: string; status: string; targetDate: string };
const patch = (id: string, payload: unknown, cookie = a) => call("PATCH", `/portal/restock-plans/${id}`, cookie, payload);
const stockState = async (code = "P001") => ({
  inventory: (await pharmacies[code]!.query("SELECT medicine_code, quantity, price, updated_at FROM inventory ORDER BY medicine_code")).rows,
  movements: (await pharmacies[code]!.query("SELECT count(*) FROM inventory_movements")).rows[0].count,
  outbox: (await pharmacies[code]!.query("SELECT count(*) FROM outbox")).rows[0].count,
});

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}

describe("sign-in is required", () => {
  it("for every restock-plan route, including the export", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [method, url] of [["GET", "/portal/restock-plans"], ["POST", "/portal/restock-plans"], ["GET", `/portal/restock-plans/${id}`], ["PATCH", `/portal/restock-plans/${id}`], ["GET", "/portal/restock-plans/export.csv"]] as const) {
      expect((await app.inject({ method, url, payload: method === "GET" ? undefined : body() })).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("POST /portal/restock-plans", () => {
  it("creates a PLANNED plan for the signed-in pharmacy", async () => {
    const res = await call("POST", "/portal/restock-plans", a, body({ notes: "  usual wholesaler " }));
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", plannedQuantity: 50, status: "PLANNED", targetDate: inDays(5), notes: "usual wholesaler", completedAt: null, byYou: true, currentQuantity: 12 });
    expect(res.json().data.planId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(res.json().data.createdAt).getTime()).not.toBeNaN();
    expect(JSON.stringify(res.json())).not.toMatch(/a@pharmacy\.test|password|scrypt/);
  });

  it.each([
    ["zero quantity", { quantity: 0 }],
    ["negative quantity", { quantity: -3 }],
    ["fractional quantity", { quantity: 2.5 }],
    ["string quantity", { quantity: "10" }],
    ["huge quantity", { quantity: 5_000_000 }],
    ["no quantity", { quantity: undefined }],
    ["a malformed date", { targetDate: "05/11/2026" }],
    ["an impossible date", { targetDate: "2026-02-30" }],
    ["a past date", { targetDate: "2020-01-01" }],
    ["a date too far ahead", { targetDate: "2040-01-01" }],
    ["no date", { targetDate: undefined }],
    ["long notes", { notes: "x".repeat(501) }],
    ["a bad medicine code", { medicineCode: "crocin" }],
    ["no medicine", { medicineCode: undefined }],
    ["a pharmacy in the body", { pharmacyCode: "P002" }],
    ["a status in the body", { status: "COMPLETED" }],
    ["a creator in the body", { createdByUserId: 99 }],
    ["an id in the body", { planId: "00000000-0000-4000-8000-000000000000" }],
  ])("rejects %s with 400 and stores nothing", async (_name, over) => {
    const res = await call("POST", "/portal/restock-plans", a, body(over));
    expect(res.statusCode).toBe(400);
    expect((await pharmacies.P001!.query("SELECT count(*) FROM restock_plans")).rows[0].count).toBe("0");
  });

  it("ignores a pharmacy named in the query: the plan belongs to the signed-in pharmacy", async () => {
    const res = await call("POST", "/portal/restock-plans?pharmacyCode=P002", a, body());
    expect(res.statusCode).toBe(201);
    expect(res.json().data.pharmacyCode).toBe("P001");
    expect((await pharmacies.P002!.query("SELECT count(*) FROM restock_plans")).rows[0].count).toBe("0");
  });

  it("answers 404 NOT_STOCKED for a medicine the pharmacy does not list, even if another pharmacy does", async () => {
    await call("DELETE", "/portal/stock/M002", a);
    const res = await call("POST", "/portal/restock-plans", a, body({ medicineCode: "M002" }));
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_STOCKED");
    expect((await call("POST", "/portal/restock-plans", b, body({ medicineCode: "M002" }))).statusCode).toBe(201); // P002 does list it
  });

  it("answers 409 PLAN_ALREADY_OPEN naming the open plan, so a double click or a second try cannot duplicate it", async () => {
    const first = await make();
    const res = await call("POST", "/portal/restock-plans", a, body({ quantity: 5 }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "PLAN_ALREADY_OPEN", details: { planId: first.planId, status: "PLANNED" } });
    const many = await Promise.all(Array.from({ length: 6 }, () => call("POST", "/portal/restock-plans", a, body({ medicineCode: "M002" }))));
    expect(many.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(many.filter((r) => r.statusCode === 409)).toHaveLength(5);
  });
});

describe("GET /portal/restock-plans", () => {
  it("lists the pharmacy's plans, soonest target first, with paging details", async () => {
    await make(a, { medicineCode: "M001", targetDate: inDays(9) });
    await make(a, { medicineCode: "M002", targetDate: inDays(2) });
    await make(a, { medicineCode: "M003", targetDate: inDays(30) });
    const res = await call("GET", "/portal/restock-plans", a);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((p: { medicineCode: string }) => p.medicineCode)).toEqual(["M002", "M001", "M003"]);
    expect(res.json().meta).toEqual({ total: 3, limit: 20, offset: 0, hasMore: false, status: "ALL" });
    expect(res.json().data[0]).toMatchObject({ medicineName: expect.any(String), plannedQuantity: 50, status: "PLANNED" });
  });

  it("filters by status and by OPEN, and pages with bounded limits", async () => {
    const p1 = await make(a, { medicineCode: "M001", targetDate: inDays(1) });
    const p2 = await make(a, { medicineCode: "M002", targetDate: inDays(2) });
    const p3 = await make(a, { medicineCode: "M003", targetDate: inDays(3) });
    await patch(p1.planId, { status: "COMPLETED" });
    await patch(p2.planId, { status: "IN_PROGRESS" });
    await patch(p3.planId, { status: "CANCELLED" });
    const codes = async (qs: string) => (await call("GET", `/portal/restock-plans?${qs}`, a)).json().data.map((p: { medicineCode: string }) => p.medicineCode);
    expect(await codes("status=OPEN")).toEqual(["M002"]);
    expect(await codes("status=COMPLETED")).toEqual(["M001"]);
    expect(await codes("status=CANCELLED")).toEqual(["M003"]);
    expect(await codes("status=IN_PROGRESS")).toEqual(["M002"]);
    expect(await codes("status=PLANNED")).toEqual([]);
    expect(await codes("status=ALL")).toEqual(["M001", "M002", "M003"]);
    const page1 = (await call("GET", "/portal/restock-plans?limit=2&offset=0", a)).json();
    const page2 = (await call("GET", "/portal/restock-plans?limit=2&offset=2", a)).json();
    expect([...page1.data, ...page2.data].map((p: { medicineCode: string }) => p.medicineCode)).toEqual(["M001", "M002", "M003"]);
    expect([page1.meta.hasMore, page2.meta.hasMore]).toEqual([true, false]);
  });

  it.each(["limit=0", "limit=101", "limit=-1", "limit=abc", "offset=-1", "offset=9999999", "status=DONE", "status=open", "status="])("rejects %s with 400", async (qs) => {
    const res = await call("GET", `/portal/restock-plans?${qs}`, a);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("shows only the signed-in pharmacy's plans, whatever the query says", async () => {
    await make(a, { medicineCode: "M001" });
    await make(b, { medicineCode: "M002" });
    expect((await call("GET", "/portal/restock-plans?pharmacyCode=P002", a)).json().data.map((p: { pharmacyCode: string }) => p.pharmacyCode)).toEqual(["P001"]);
    expect((await call("GET", "/portal/restock-plans", b)).json().data.map((p: { pharmacyCode: string; medicineCode: string }) => [p.pharmacyCode, p.medicineCode])).toEqual([["P002", "M002"]]);
  });
});

describe("GET and PATCH /portal/restock-plans/:id", () => {
  it("reads one plan, and says 404 for an unknown one and 400 for a malformed id", async () => {
    const p = await make();
    expect((await call("GET", `/portal/restock-plans/${p.planId}`, a)).json().data.planId).toBe(p.planId);
    const missing = await call("GET", "/portal/restock-plans/00000000-0000-4000-8000-000000000000", a);
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, "PLAN_NOT_FOUND"]);
    expect((await call("GET", "/portal/restock-plans/not-an-id", a)).statusCode).toBe(400);
  });

  it("walks a plan through the lifecycle, stamping the completion time and clearing it on reopening", async () => {
    const p = await make();
    expect((await patch(p.planId, { status: "IN_PROGRESS" })).json().data.status).toBe("IN_PROGRESS");
    const done = (await patch(p.planId, { status: "COMPLETED" })).json().data;
    expect(done.status).toBe("COMPLETED");
    expect(new Date(done.completedAt).getTime()).not.toBeNaN();
    const reopened = (await patch(p.planId, { status: "IN_PROGRESS" })).json().data;
    expect([reopened.status, reopened.completedAt]).toEqual(["IN_PROGRESS", null]);
    const cancelled = (await patch(p.planId, { status: "CANCELLED" })).json().data;
    expect([cancelled.status, cancelled.completedAt]).toEqual(["CANCELLED", null]);
    expect(new Date(cancelled.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(cancelled.createdAt).getTime()); // every change moves the update time forward, never before creation
  });

  it("refuses moves the lifecycle does not allow, with a clear 409", async () => {
    const p = await make();
    await patch(p.planId, { status: "COMPLETED" });
    for (const status of ["PLANNED", "CANCELLED", "COMPLETED"]) {
      const res = await patch(p.planId, { status });
      expect([res.statusCode, res.json().error.code], status).toEqual([409, "INVALID_TRANSITION"]);
    }
    await patch(p.planId, { status: "IN_PROGRESS" });
    await patch(p.planId, { status: "CANCELLED" });
    const final = await patch(p.planId, { status: "PLANNED" });
    expect([final.statusCode, final.json().error.code]).toEqual([409, "INVALID_TRANSITION"]);
    expect(final.json().error.message).toMatch(/final/);
  });

  it("reschedules, and edits the quantity and notes, while the plan is open; refuses once it is closed", async () => {
    const p = await make();
    const moved = (await patch(p.planId, { targetDate: inDays(12) })).json().data;
    expect([moved.targetDate, moved.status, moved.plannedQuantity]).toEqual([inDays(12), "PLANNED", 50]);
    expect((await patch(p.planId, { quantity: 75, notes: "bigger" })).json().data).toMatchObject({ plannedQuantity: 75, notes: "bigger" });
    expect((await patch(p.planId, { notes: null })).json().data.notes).toBeNull();
    await patch(p.planId, { status: "COMPLETED" });
    const closed = await patch(p.planId, { targetDate: inDays(20) });
    expect([closed.statusCode, closed.json().error.code]).toEqual([409, "PLAN_CLOSED"]);
    expect((await call("GET", `/portal/restock-plans/${p.planId}`, a)).json().data.targetDate).toBe(inDays(12)); // not changed
  });

  it.each([
    ["an empty change", {}],
    ["a bad status", { status: "DONE" }],
    ["a bad quantity", { quantity: 0 }],
    ["a string quantity", { quantity: "9" }],
    ["a bad date", { targetDate: "tomorrow" }],
    ["a past date", { targetDate: "2020-05-05" }],
    ["long notes", { notes: "n".repeat(900) }],
    ["a new medicine", { medicineCode: "M002" }],
    ["a new pharmacy", { pharmacyCode: "P002" }],
    ["a new id", { planId: "00000000-0000-4000-8000-000000000000" }],
    ["a new creator", { createdByUserId: 5 }],
    ["a new creation time", { createdAt: "2020-01-01T00:00:00Z" }],
    ["a completion time", { completedAt: "2026-01-01T00:00:00Z" }],
  ])("rejects %s with 400 and changes nothing", async (_name, payload) => {
    const p = await make();
    const before = (await pharmacies.P001!.query("SELECT * FROM restock_plans WHERE plan_id = $1", [p.planId])).rows[0];
    expect((await patch(p.planId, payload)).statusCode).toBe(400);
    expect((await pharmacies.P001!.query("SELECT * FROM restock_plans WHERE plan_id = $1", [p.planId])).rows[0]).toEqual(before);
  });

  it("cannot be reached from another pharmacy: read and change are 404 and the plan is untouched", async () => {
    const p = await make(a);
    expect((await call("GET", `/portal/restock-plans/${p.planId}`, b)).statusCode).toBe(404);
    expect((await patch(p.planId, { status: "CANCELLED" }, b)).statusCode).toBe(404);
    expect((await patch(p.planId, { targetDate: inDays(8) }, b)).statusCode).toBe(404);
    expect((await call("GET", `/portal/restock-plans/${p.planId}`, a)).json().data).toMatchObject({ status: "PLANNED", targetDate: inDays(5) });
  });
});

describe("a plan never changes stock", () => {
  it("creating, editing, rescheduling, starting, completing, reopening and cancelling leave stock, history and the outbox alone", async () => {
    const before = await stockState();
    const p = await make(a, { quantity: 200 });
    await patch(p.planId, { quantity: 300, notes: "x" });
    await patch(p.planId, { targetDate: inDays(20) });
    await patch(p.planId, { status: "IN_PROGRESS" });
    await patch(p.planId, { status: "COMPLETED" });
    await patch(p.planId, { status: "IN_PROGRESS" });
    await patch(p.planId, { status: "CANCELLED" });
    await call("GET", "/portal/restock-plans", a);
    await call("GET", "/portal/restock-plans/export.csv", a);
    expect(await stockState()).toEqual(before);
  });

  it("only the recorded restock changes stock, writing the movement and the outbox event; the plan keeps its own status", async () => {
    const p = await make(a, { quantity: 30 });
    await patch(p.planId, { status: "COMPLETED" });
    expect(await stockState()).toMatchObject({ movements: "0", outbox: "0" });
    const res = await call("POST", "/portal/restocks", a, { medicineCode: "M001", quantity: 30 });
    expect(res.statusCode).toBe(201);
    const after = await stockState();
    expect(after).toMatchObject({ movements: "1", outbox: "1" });
    expect(after.inventory.find((r) => r.medicine_code === "M001")!.quantity).toBe(42);
    expect((await call("GET", `/portal/restock-plans/${p.planId}`, a)).json().data).toMatchObject({ status: "COMPLETED", currentQuantity: 42 });
    // The only event is the restock's: nothing came from the plan.
    expect((await pharmacies.P001!.query("SELECT event_type FROM outbox")).rows).toEqual([{ event_type: "RESTOCK" }]);
  });
});

describe("restock plans and low-stock alerts", () => {
  const sell = (medicineCode: string, quantity: number, cookie = a) => call("POST", "/portal/sales", cookie, { medicineCode, quantity });
  const alertFor = async (code: string, cookie = a) => (await call("GET", "/portal/alerts", cookie)).json().data.find((x: { medicineCode: string }) => x.medicineCode === code);

  it("an alert shows its open plan, and reading alerts never creates one", async () => {
    await sell("M001", 9); // 3 left: an alert
    expect((await alertFor("M001")).restockPlan).toBeNull();
    for (let i = 0; i < 3; i++) await call("GET", "/portal/alerts", a);
    await call("GET", "/portal/risk", a);
    expect((await pharmacies.P001!.query("SELECT count(*) FROM restock_plans")).rows[0].count).toBe("0");

    const plan = await make(a, { medicineCode: "M001", quantity: 40 });
    expect((await alertFor("M001")).restockPlan).toEqual({ planId: plan.planId, status: "PLANNED", targetDate: plan.targetDate });
    await patch(plan.planId, { status: "IN_PROGRESS" });
    expect((await alertFor("M001")).restockPlan.status).toBe("IN_PROGRESS");
    await patch(plan.planId, { status: "COMPLETED" });
    expect((await alertFor("M001")).restockPlan).toBeNull(); // completed is no longer "open": the alert, still active, can get a new plan
  });

  it("one pharmacy's plan is never shown on another pharmacy's alert", async () => {
    await sell("M001", 9);
    await sell("M001", 9, b);
    await make(a, { medicineCode: "M001" });
    expect((await alertFor("M001", a)).restockPlan).not.toBeNull();
    expect((await alertFor("M001", b)).restockPlan).toBeNull();
  });

  it("alerts keep working, without plans, where the plans table does not exist yet", async () => {
    await sell("M001", 9);
    await pharmacies.P001!.query("ALTER TABLE restock_plans RENAME TO restock_plans_away");
    try {
      expect((await alertFor("M001")).restockPlan).toBeNull();
      const res = await call("GET", "/portal/restock-plans", a);
      expect([res.statusCode, res.json().error.code]).toEqual([503, "PHARMACY_SCHEMA_OUTDATED"]);
    } finally {
      await pharmacies.P001!.query("ALTER TABLE restock_plans_away RENAME TO restock_plans");
    }
  });
});

describe("GET /portal/restock-plans/export.csv", () => {
  const HEADER = ["plan_id", "medicine_code", "medicine_name", "planned_quantity", "status", "target_date", "created_at", "updated_at", "completed_at", "notes"];

  it("downloads a real CSV with safe headers and a filename built from the pharmacy and status", async () => {
    await make(a, { notes: "ring first" });
    const res = await call("GET", "/portal/restock-plans/export.csv", a);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="restock-plans-P001-all-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-export-truncated"]).toBe("false");
    expect(res.headers["cache-control"]).toBe("no-store");
    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual(HEADER);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.slice(1, 6)).toEqual(["M001", "Crocin 500mg", "50", "PLANNED", inDays(5)]);
    expect(rows[1]![0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[1]![8]).toBe(""); // not completed
    expect(rows[1]![9]).toBe("ring first");
    expect(res.body.endsWith("\r\n")).toBe(true);
  });

  it("escapes commas, quotes and line breaks so the file reads back exactly", async () => {
    const note = 'Call "Mr. Rao", then\nconfirm the price, ok?';
    await make(a, { notes: note });
    const rows = parseCsv((await call("GET", "/portal/restock-plans/export.csv", a)).body);
    expect(rows[1]).toHaveLength(10);
    expect(rows[1]![9]).toBe(note);
  });

  it.each(["=1+1", "+1+1", "-2+3", "@SUM(A1)", "=HYPERLINK(\"http://x\",\"y\")", "-"])("defuses a note that starts like a formula: %s", async (note) => {
    await make(a, { notes: note });
    const rows = parseCsv((await call("GET", "/portal/restock-plans/export.csv", a)).body);
    expect(rows[1]![9]).toBe(`'${note}`);
    expect(rows[1]![9]!.startsWith("'")).toBe(true);
  });

  it("is a valid file with just the header when there is nothing to export", async () => {
    const res = await call("GET", "/portal/restock-plans/export.csv", a);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`${HEADER.join(",")}\r\n`);
  });

  it("respects the status filter, and puts it in the filename", async () => {
    const p1 = await make(a, { medicineCode: "M001" });
    await make(a, { medicineCode: "M002" });
    await patch(p1.planId, { status: "COMPLETED" });
    const codes = async (qs: string) => parseCsv((await call("GET", `/portal/restock-plans/export.csv?${qs}`, a)).body).slice(1).map((r) => r[1]);
    expect(await codes("status=COMPLETED")).toEqual(["M001"]);
    expect(await codes("status=OPEN")).toEqual(["M002"]);
    expect(await codes("status=CANCELLED")).toEqual([]);
    expect((await call("GET", "/portal/restock-plans/export.csv?status=IN_PROGRESS", a)).headers["content-disposition"]).toMatch(/restock-plans-P001-in-progress-/);
    expect(await codes("")).toEqual(["M001", "M002"]);
  });

  it("holds only the signed-in pharmacy's plans", async () => {
    await make(a, { medicineCode: "M001", notes: "mine" });
    await make(b, { medicineCode: "M002", notes: "theirs" });
    const mine = await call("GET", "/portal/restock-plans/export.csv?pharmacyCode=P002", a);
    expect(mine.body).toContain("mine");
    expect(mine.body).not.toContain("theirs");
    const theirs = await call("GET", "/portal/restock-plans/export.csv", b);
    expect(theirs.body).toContain("theirs");
    expect(theirs.body).not.toContain("mine");
    expect(theirs.headers["content-disposition"]).toMatch(/restock-plans-P002-/);
  });

  it("holds nothing but plan data: no staff identity, credentials or other pharmacy's details", async () => {
    await make(a, { notes: "x" });
    const body = (await call("GET", "/portal/restock-plans/export.csv", a)).body;
    expect(body).not.toMatch(/@pharmacy\.test|password|scrypt|created_by|user_id|P002/i);
  });

  it("rejects a bad status with a JSON error, not a CSV", async () => {
    const res = await call("GET", "/portal/restock-plans/export.csv?status=DONE", a);
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});
