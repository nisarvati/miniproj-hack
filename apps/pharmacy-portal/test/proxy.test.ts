/**
 * The portal behind the web app's same-origin proxy and Render's own: which address the login throttle counts. Unconfigured, a forwarded address is ignored (it
 * could be forged); with TRUST_PROXY=N the nearest N proxies are believed and the visitor behind them is the one counted.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "@medlink/db";
import { freshPharmacyDbs, freshSeededDb } from "@medlink/db/testing";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "unused", LOG_LEVEL: "silent", PORTAL_SESSION_SECRET: "test-secret-test-secret" };

describe("TRUST_PROXY setting", () => {
  it("is off unless a hop count is given", () => {
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "0" }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ ...base, TRUST_PROXY: "10" }).trustProxy).toBe(10);
  });
  it("refuses anything that is not a small number of hops, so 'true' cannot mean 'believe everyone'", () => {
    for (const bad of ["true", "all", "-1", "1.5", "100", "2,3", "loopback", ""]) {
      expect(() => loadConfig({ ...base, TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
  });
});

describe("the login throttle behind proxies", () => {
  let admin: Db;
  let pharmacies: Record<string, Db>;
  let plain: FastifyInstance;
  let behind: FastifyInstance;

  beforeAll(async () => {
    admin = await freshSeededDb();
    const urls = await freshPharmacyDbs(admin);
    pharmacies = Object.fromEntries(Object.entries(urls).map(([code, url]) => [code, createPool(url)]));
    await admin.query("DELETE FROM pharmacy_users");
    await admin.query("INSERT INTO pharmacy_users (email, password_hash, pharmacy_code) VALUES ('a@pharmacy.test', $1, 'P001'), ('b@pharmacy.test', $1, 'P001')", [await hashPassword("right-password")]);
    plain = await buildApp({ db: admin, pharmacies }, loadConfig(base), { logger: false });
    behind = await buildApp({ db: admin, pharmacies }, loadConfig({ ...base, TRUST_PROXY: "2" }), { logger: false });
  });
  afterAll(async () => {
    await plain.close();
    await behind.close();
    await Promise.all(Object.values(pharmacies).map((p) => p.end()));
    await admin.end();
  });

  const wrong = (app: FastifyInstance, email: string, forwardedFor?: string) =>
    app.inject({ method: "POST", url: "/portal/login", payload: { email, password: "wrong" }, headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {} });
  const statuses = async (app: FastifyInstance, email: string, forwardedFor: (i: number) => string | undefined, n = 10) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push((await wrong(app, email, forwardedFor(i))).statusCode);
    return out;
  };

  it("by default a forwarded address is ignored: changing it every time does not dodge the per-account limit", async () => {
    const s = await statuses(plain, "a@pharmacy.test", (i) => `203.0.113.${i + 1}, 198.51.100.9`);
    expect(s.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(s.slice(8)).toEqual([429, 429]);
  });

  it("behind two trusted proxies, the visitor is the address before them: one visitor is throttled, and a different one is not", async () => {
    const same = await statuses(behind, "b@pharmacy.test", () => "203.0.113.7, 198.51.100.9");
    expect(same.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(same.slice(8)).toEqual([429, 429]);
    // another visitor behind the same proxies is a different address, so the first visitor's failures do not lock them out
    expect((await wrong(behind, "b@pharmacy.test", "203.0.113.8, 198.51.100.9")).statusCode).toBe(401);
  });

  it("does not believe more hops than it was told to: an extra forged address on the left is not the visitor", async () => {
    // TRUST_PROXY=2 trusts the two nearest proxies. A client that prepends its own forged entry is still seen as the real client address, not the forgery.
    const first = await statuses(behind, "a@pharmacy.test", (i) => `10.0.0.${i + 1}, 203.0.113.50, 198.51.100.9`, 9);
    expect(first.slice(8)).toEqual([429]); // the forged left-hand entries changed nothing: the counted address stayed 203.0.113.50
  });
});
