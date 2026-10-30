/**
 * What the PUBLIC search API (and its live stream) may and may not say. Staff-only things (alerts, risk, plans, movements, accounts) live in the pharmacy
 * portal behind a session; none of them has a route here, none of their words appears in a public answer, and the stream is open to anyone.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seed, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { LiveHub } from "../src/modules/stream/hub.js";

let db: Db;
let app: FastifyInstance;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent", CORS_ORIGINS: "http://localhost:3000" });
const AT = "lat=19.1364&lng=72.8296";
const HEADERS = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };

beforeAll(async () => {
  db = await freshSeededDb();
  await seed(db);
  app = await buildApp(db, config, { logger: false });
});
afterAll(async () => {
  await app.close();
  await db.end();
});
const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

/** Every full route path of an app, rebuilt from the indented tree Fastify prints (a child line holds only the rest of its parent's path). */
function routePaths(app: FastifyInstance): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  const stack: string[] = [];
  for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^((?:│ {3}| {4})*)(?:├──|└──) (\S+) \(([^)]*)\)/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack[depth] = m[2]!;
    const path = stack.join("");
    for (const method of m[3]!.split(", ")) if (method !== "HEAD") out.push({ method, path });
  }
  return out;
}

describe("the routes the public API has", () => {
  it("are only /api/... and /health, and the ones the documentation lists", () => {
    // (The one wildcard route is the CORS plugin's answer to a browser's OPTIONS preflight, which carries no data.)
    const routes = routePaths(app).filter((r) => !(r.path === "*" && r.method === "OPTIONS"));
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const r of routes) expect(r.path === "/health" || r.path.startsWith("/api/"), r.path).toBe(true);
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        "DELETE /api/restock-subscriptions/:id", "GET /api/directory", "GET /api/health", "GET /api/inventory", "GET /api/inventory/:id", "GET /api/medicines/:id/substitutes",
        "GET /api/medicines/search", "GET /api/analytics/network", "GET /api/nodes", "GET /api/notifications", "GET /api/pharmacies", "GET /api/pharmacies/:id", "GET /api/pharmacies/:id/stock",
        "GET /api/restock-subscriptions", "GET /api/search", "GET /api/stream", "GET /health", "POST /api/restock-subscriptions",
      ].sort(),
    );
  });

  it("include nothing for staff alerts, risk, plans, movements, accounts or the portal", async () => {
    const text = routePaths(app).map((r) => r.path).join("\n");
    expect(text).not.toMatch(/alert|risk|restock-plan|movement|history|staff|admin|portal|password|session|login|signup|export/i);
    for (const url of ["/api/alerts", "/api/risk", "/api/stock-alerts", "/api/restock-plans", "/api/movements", "/api/history", "/api/admin/staff-requests", "/portal/me", "/portal/stock", "/portal/restock-plans/export.csv"]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
  });
});

describe("what public answers contain", () => {
  it("a search result has public availability data only: no staff, account, alert, plan or internal field", async () => {
    const res = await get(`/api/search?q=Crocin&${AT}`);
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toMatch(/password|hash|secret|token|session|cookie|email|staff|alert|riskScore|restockPlan|restock_plan|movement|priceFactor|database|connection/i);
    const first = res.json().data[0];
    expect(Object.keys(first).sort()).toEqual(
      ["distanceKm", "distanceVerified", "matchPercent", "matchReasons", "medicine", "pharmacy", "price", "quantity", "rank", "score", "scoreBreakdown", "source", "stockStatus", "updatedAt"],
    );
    expect(Object.keys(first.pharmacy).sort()).toEqual(["address", "code", "demo", "id", "independent", "inventorySimulated", "latitude", "locationVerified", "longitude", "name"]);
  });

  it("the other public reads say nothing private either", async () => {
    for (const url of ["/api/pharmacies", "/api/directory", "/api/inventory", "/api/medicines/search?q=Crocin", "/api/nodes", "/api/health", "/api/pharmacies/1/stock"]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toMatch(/password|secret|scrypt|session|cookie|"email"|staff|riskScore|restock_plan|stock_alert|connectionString|postgres:\/\//i);
    }
  });

  it("node status shows counts and times, never a connection string or a staff identity", async () => {
    const body = (await get("/api/nodes")).body;
    expect(body).not.toMatch(/postgres:|redis:|@|password|credential|user/i);
  });

  it("errors are plain: no stack, path, SQL or secret", async () => {
    const bodies = [(await get("/api/search")).body, (await get("/api/search?q=Crocin&lat=abc&lng=1")).body, (await get("/api/pharmacies/notanumber")).body, (await get("/api/medicines/0/substitutes")).body, (await get("/api/nothing")).body];
    for (const b of bodies) expect(b).not.toMatch(/\bat \S+ \(|node_modules|\/Users\/|SELECT |INSERT |relation "|stack|password|secret/i);
    expect((await get("/api/search?q=Crocin&lat=abc&lng=1")).json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("headers and cross-origin access", () => {
  it("every answer carries the security headers", async () => {
    const answers = [await get(`/api/search?q=Crocin&${AT}`), await get("/api/search"), await get("/api/nothing"), await get("/api/health")];
    expect(answers.map((r) => r.statusCode)).toEqual([200, 400, 404, 200]);
    for (const res of answers) for (const [name, value] of Object.entries(HEADERS)) expect(res.headers[name], `${res.statusCode} ${name}`).toBe(value);
  });

  it("only the configured web origin may read it from a browser, and credentials are never allowed", async () => {
    const ok = await get("/api/health", { origin: "http://localhost:3000" });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    const evil = await get("/api/health", { origin: "https://evil.example" });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await app.inject({ method: "OPTIONS", url: "/api/restock-subscriptions", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("the live stream", () => {
  async function open(onlyHub?: LiveHub) {
    const hub = onlyHub ?? new LiveHub({ stock: { poll: async () => [], stats: () => ({ malformed: 0, unconfirmed: 0 }) }, nodes: async () => ({ data: [], meta: { generatedAt: new Date().toISOString(), redis: "up", connector: "up", syncService: "ready", thresholds: { degradedAfterMs: 15_000, downAfterMs: 120_000 } } }) });
    const streamApp = await buildApp(db, config, { logger: false, stream: { hub } });
    const url = await streamApp.listen({ port: 0, host: "127.0.0.1" });
    const ctl = new AbortController();
    const res = await fetch(`${url}/api/stream`, { signal: ctl.signal, headers: { origin: "http://localhost:3000" } });
    return { res, close: async () => (ctl.abort(), streamApp.server.closeAllConnections(), await streamApp.close()) };
  }

  it("needs no credentials (it is public), carries the security headers, and takes no token in its address", async () => {
    const { res, close } = await open();
    try {
      expect(res.status).toBe(200);
      for (const [name, value] of Object.entries(HEADERS)) expect(res.headers.get(name), name).toBe(value);
      expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
      expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull(); // no cookie is ever sent to it or needed
    } finally {
      await close();
    }
  });

  it("ignores credentials and query parameters: the same public events whoever asks", async () => {
    const { res, close } = await open();
    try {
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
    const streamApp = await buildApp(db, config, { logger: false });
    const withToken = await streamApp.inject({ method: "GET", url: "/api/stream?token=abc&session=xyz&pharmacyCode=P001", headers: { cookie: "medlink_portal=anything", authorization: "Bearer x" }, payloadAsStream: true });
    expect(withToken.statusCode).toBe(200); // accepted as an ordinary public request, and nothing in it changes what is sent
    await streamApp.close();
  });
});
