/**
 * GET /api/analytics/network: public, aggregated, and honest about what it cannot read. It carries events retained per time bucket and stock STATUS
 * counts; it never carries quantities, sales, risk, alerts or plans.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seed, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { EventHistory } from "../src/modules/analytics/events.js";

let db: Db;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });
const NOW = Date.parse("2026-10-30T10:20:00.000Z");
const HOUR = 3_600_000;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  db = await freshSeededDb();
});
beforeEach(async () => {
  await seed(db);
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.end();
});

/** A fake stream: the publish times each pharmacy's retained entries have. */
const history = (byPharmacy: Record<string, number[]>, over: { truncated?: boolean; fail?: boolean } = {}): EventHistory & { calls: { code: string; fromMs: number; toMs: number; cap: number }[] } => {
  const calls: { code: string; fromMs: number; toMs: number; cap: number }[] = [];
  return {
    calls,
    async read(code, fromMs, toMs, cap) {
      calls.push({ code, fromMs, toMs, cap });
      if (over.fail) throw new Error("redis down");
      return { times: (byPharmacy[code] ?? []).filter((t) => t >= fromMs && t <= toMs), truncated: over.truncated ?? false };
    },
  };
};
async function get(url: string, events?: EventHistory) {
  const app = await buildApp(db, config, { logger: false, events, nodes: { now: () => NOW } as never });
  apps.push(app);
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

describe("window and buckets", () => {
  it("buckets by publish time into 24 clock-aligned buckets, per pharmacy, and sums nothing it did not read", async () => {
    const ev = history({ P001: [NOW - 30 * 60_000, NOW - 40 * 60_000, NOW - 5 * HOUR], P002: [NOW - 90 * 60_000], P005: [NOW - 25 * HOUR] });
    const { status, body } = await get("/api/analytics/network?hours=24", ev);
    expect(status).toBe(200);
    const { window, events } = body.data;
    expect(window.hours).toBe(24);
    expect(window.bucketMinutes).toBe(60);
    expect(window.bucketStarts).toHaveLength(24);
    expect(Date.parse(window.to) - Date.parse(window.from)).toBe(24 * HOUR);
    expect(new Date(window.to).getUTCMinutes() % 60).toBe(0); // aligned to the clock, so bars do not slide on every request
    const by = Object.fromEntries(events.byPharmacy.map((p: { pharmacyCode: string; total: number; buckets: number[] }) => [p.pharmacyCode, p]));
    expect(by.P001.total).toBe(3);
    expect(by.P001.buckets).toHaveLength(24);
    expect(by.P001.buckets.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(by.P002.total).toBe(1);
    expect(by.P005.total).toBe(0); // 25 h ago is outside the window
    expect(by.P004.buckets.every((n: number) => n === 0)).toBe(true); // read, and genuinely empty
    expect(events.available).toBe(true);
    expect(events.truncated).toBe(false);
  });

  it("supports 6, 24 and 72 hours with 24 buckets each, and refuses anything else", async () => {
    for (const [hours, minutes] of [[6, 15], [24, 60], [72, 180]] as const) {
      const { body } = await get(`/api/analytics/network?hours=${hours}`, history({}));
      expect(body.data.window).toMatchObject({ hours, bucketMinutes: minutes });
    }
    for (const bad of ["5", "0", "-1", "abc", "1000"]) expect((await get(`/api/analytics/network?hours=${bad}`, history({}))).status).toBe(400);
    expect((await get("/api/analytics/network", history({}))).body.data.window.hours).toBe(24); // the default
  });

  it("reads each stream with a cap and says when entries beyond it were left out", async () => {
    const ev = history({ P001: [NOW - HOUR] }, { truncated: true });
    const { body } = await get("/api/analytics/network?hours=24", ev);
    expect(ev.calls.length).toBe(5);
    expect(ev.calls.every((c) => c.cap === 5000 && c.toMs === NOW)).toBe(true);
    expect(body.data.events.truncated).toBe(true);
  });
});

describe("what it cannot read", () => {
  it("says NOT_CONFIGURED when there is no event history, and still answers stock", async () => {
    const { status, body } = await get("/api/analytics/network", undefined);
    expect(status).toBe(200);
    expect(body.data.events).toEqual({ available: false, reason: "NOT_CONFIGURED" });
    expect(body.data.stock.available).toBe(true);
  });

  it("says ERROR, not zeros, when Redis fails while reading events, and still answers stock", async () => {
    const { status, body } = await get("/api/analytics/network", history({}, { fail: true }));
    expect(status).toBe(200);
    expect(body.data.events).toEqual({ available: false, reason: "ERROR" });
    expect(JSON.stringify(body.data.events)).not.toMatch(/byPharmacy|buckets|total/);
    expect(body.data.stock.available).toBe(true);
  });
});

describe("stock status counts", () => {
  it("counts listings per pharmacy by the same thresholds as search, from the database when there is no live stock", async () => {
    await db.query("UPDATE inventory SET quantity = 0 WHERE pharmacy_id = (SELECT id FROM pharmacies WHERE code = 'P001') AND medicine_id = (SELECT id FROM medicines ORDER BY id LIMIT 1)");
    const { body } = await get("/api/analytics/network", history({}));
    const stock = body.data.stock;
    expect(stock.available).toBe(true);
    expect(stock.live).toBe(false);
    expect(stock.threshold).toBe(config.LOW_STOCK_THRESHOLD);
    for (const p of stock.byPharmacy) {
      const rows = (await db.query("SELECT i.quantity FROM inventory i JOIN pharmacies ph ON ph.id = i.pharmacy_id WHERE ph.code = $1", [p.pharmacyCode])).rows as { quantity: number }[];
      expect(p.listings).toBe(rows.length);
      expect(p.outOfStock).toBe(rows.filter((r) => r.quantity <= 0).length);
      expect(p.lowStock).toBe(rows.filter((r) => r.quantity > 0 && r.quantity <= config.LOW_STOCK_THRESHOLD).length);
      expect(p.inStock + p.lowStock + p.outOfStock).toBe(p.listings);
    }
    expect(stock.byPharmacy.map((p: { pharmacyCode: string }) => p.pharmacyCode)).toEqual(["P001", "P002", "P003", "P004", "P005"]);
    expect(stock.byPharmacy.find((p: { pharmacyCode: string }) => p.pharmacyCode === "P001").outOfStock).toBeGreaterThanOrEqual(1);
  });
});

describe("what it never says", () => {
  it("carries no quantities, sales, risk, alerts, plans, accounts or event contents", async () => {
    const { body, headers } = await get("/api/analytics/network", history({ P001: [NOW - HOUR] }));
    const text = JSON.stringify(body);
    for (const word of ["quantity", "price", "sale", "restock", "risk", "alert", "plan", "email", "password", "medicineCode", "eventId", "payload"]) expect(text.toLowerCase(), word).not.toContain(word.toLowerCase());
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });
});
