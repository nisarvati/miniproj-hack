import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { directoryCandidates, type Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let db: Db;
let app: FastifyInstance;
type Entry = { code: string; name: string; address: string; listingStatus: string; directions: string; inventory: string; locationVerified: boolean; label: string; demo: boolean };

beforeAll(async () => {
  db = await freshSeededDb();
  app = await buildApp(db, loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" }), { logger: false });
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("GET /api/directory", () => {
  it("lists accepted-but-not-onboarded entries and research leads, labelled, with no inventory and no coordinates", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/directory" })).json() as { data: Entry[]; meta: { count: number } };
    expect(body.meta.count).toBe(body.data.length);
    expect(body.data.length).toBe(1 + directoryCandidates().length); // P006 plus the leads
    for (const e of body.data) {
      expect(e).toMatchObject({ demo: true, label: "Demo directory listing — not a confirmed MedLink partner.", inventory: "none", locationVerified: false });
      expect(e).not.toHaveProperty("latitude");
      expect(e).not.toHaveProperty("longitude");
      expect(e).not.toHaveProperty("distanceKm");
    }
    const by = (n: string) => body.data.find((e) => e.name.startsWith(n))!;
    expect(by("Mahavir").listingStatus).toBe("accepted");
    expect(by("Golden")).toMatchObject({ listingStatus: "provisional", directions: "address" });
    expect(by("Arihant")).toMatchObject({ listingStatus: "needs-review", directions: "approximate" });
    expect(by("Sahakar").directions).toBe("unavailable");
    expect(by("Zeelab")).toMatchObject({ listingStatus: "excluded", directions: "unavailable" });
  });

  it("does not add a pharmacy to /api/pharmacies or to search", async () => {
    const pharmacies = (await app.inject({ method: "GET", url: "/api/pharmacies" })).json().data as { code: string }[];
    expect(pharmacies.map((p) => p.code).sort()).toEqual(["P001", "P002", "P003", "P004", "P005"]);
    const search = (await app.inject({ method: "GET", url: "/api/search?q=Crocin&lat=19.1364&lng=72.8296" })).json().data as { pharmacy: { code: string } }[];
    expect(search.every((r) => ["P001", "P002", "P003", "P004", "P005"].includes(r.pharmacy.code))).toBe(true);
  });
});
