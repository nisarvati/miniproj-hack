import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@medlink/db";
import type { Config } from "../../config.js";
import type { LiveStock } from "../live/live-stock.js";
import { listPharmacies } from "../pharmacies/repo.js";
import { pharmacyStock } from "../pharmacies/stock.js";
import type { EventHistory } from "./events.js";

export const WINDOWS = [6, 24, 72] as const;
const BUCKETS = 24;
const EVENT_CAP = 5_000;
const query = z.object({ hours: z.coerce.number().int().refine((h) => (WINDOWS as readonly number[]).includes(h), `hours must be one of ${WINDOWS.join(", ")}`).default(24) });

export interface AnalyticsDeps {
  db: Db;
  config: Config;
  live?: LiveStock;
  events?: EventHistory;
  pharmacies?: () => { code: string; name: string }[];
  now?: () => number;
  log?: { warn(obj: object, msg?: string): void };
}

type Unavailable = { available: false; reason: "NOT_CONFIGURED" | "ERROR" };

/**
 * GET /api/analytics/network: network-wide figures that are already public (search shows stock status; /api/nodes and /api/stream show sync counters).
 * Events: how many events each pharmacy's stream retains per time bucket, by the time they were published. Stock: how many listings are in stock, low
 * or out, never a quantity. It carries NO sales, risk, alert or plan data: those belong to one pharmacy's staff (GET /portal/analytics).
 * A part that cannot be read says so; it is never answered with zeros.
 */
export function analyticsRoutes(app: FastifyInstance, deps: AnalyticsDeps) {
  app.get("/api/analytics/network", async (req, reply) => {
    const { hours } = query.parse(req.query);
    reply.header("cache-control", "no-store");
    const now = (deps.now ?? Date.now)();
    const windowMs = hours * 3_600_000;
    const bucketMs = windowMs / BUCKETS;
    const to = Math.ceil(now / bucketMs) * bucketMs; // buckets line up with the clock, so they do not slide on every request
    const from = to - windowMs;
    const bucketStarts = Array.from({ length: BUCKETS }, (_, i) => new Date(from + i * bucketMs).toISOString());
    const codes = (deps.pharmacies ? deps.pharmacies() : (await listPharmacies(deps.db)).map((p) => ({ code: p.code, name: p.name }))).map((p) => p.code);

    let events: Unavailable | { available: true; truncated: boolean; byPharmacy: { pharmacyCode: string; total: number; buckets: number[] }[] };
    if (!deps.events) events = { available: false, reason: "NOT_CONFIGURED" };
    else {
      try {
        let truncated = false;
        const byPharmacy = [];
        for (const code of codes) {
          const r = await deps.events.read(code, from, now, EVENT_CAP);
          truncated ||= r.truncated;
          const buckets = new Array<number>(BUCKETS).fill(0);
          for (const t of r.times) buckets[Math.min(BUCKETS - 1, Math.max(0, Math.floor((t - from) / bucketMs)))]!++;
          byPharmacy.push({ pharmacyCode: code, total: r.times.length, buckets });
        }
        byPharmacy.sort((a, b) => a.pharmacyCode.localeCompare(b.pharmacyCode));
        events = { available: true, truncated, byPharmacy };
      } catch (err) {
        deps.log?.warn({ err }, "analytics: event history unavailable");
        events = { available: false, reason: "ERROR" };
      }
    }

    let stock: Unavailable | { available: true; live: boolean; threshold: number; byPharmacy: { pharmacyCode: string; inStock: number; lowStock: number; outOfStock: number; listings: number }[] };
    try {
      const rows = (await listPharmacies(deps.db)).filter((p) => codes.includes(p.code)).sort((a, b) => a.code.localeCompare(b.code));
      let live = true;
      const byPharmacy = [];
      for (const p of rows) {
        const s = await pharmacyStock({ db: deps.db, config: deps.config, live: deps.live, log: deps.log }, p);
        live &&= s.live;
        const n = (st: string) => s.items.filter((i) => i.stockStatus === st).length;
        byPharmacy.push({ pharmacyCode: p.code, inStock: n("IN_STOCK"), lowStock: n("LOW_STOCK"), outOfStock: n("OUT_OF_STOCK"), listings: s.items.length });
      }
      stock = { available: true, live, threshold: deps.config.LOW_STOCK_THRESHOLD, byPharmacy };
    } catch (err) {
      deps.log?.warn({ err }, "analytics: stock distribution unavailable");
      stock = { available: false, reason: "ERROR" };
    }

    return {
      data: { window: { hours, bucketMinutes: bucketMs / 60_000, from: new Date(from).toISOString(), to: new Date(to).toISOString(), bucketStarts }, events, stock },
      meta: { generatedAt: new Date(now).toISOString(), eventsMeaning: "published-to-stream, retained", eventCap: EVENT_CAP },
    };
  });
}
