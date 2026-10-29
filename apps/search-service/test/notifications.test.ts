import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let db: Db;
let app: FastifyInstance;
let crocinId: number;
const config = loadConfig({ DATABASE_URL: "unused", LOG_LEVEL: "silent" });

beforeAll(async () => {
  db = await freshSeededDb();
  app = await buildApp(db, config, { logger: false });
  crocinId = Number((await db.query("SELECT id FROM medicines WHERE code = 'M001'")).rows[0].id);
});
beforeEach(async () => {
  await db.query("TRUNCATE notifications, restock_subscriptions, users RESTART IDENTITY CASCADE");
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/restock-subscriptions", payload: payload as object });
const get = (url: string) => app.inject({ method: "GET", url });
const cancel = (id: number, email: string) => app.inject({ method: "DELETE", url: `/api/restock-subscriptions/${id}?email=${encodeURIComponent(email)}` });

describe("POST /api/restock-subscriptions", () => {
  it("creates a subscription for an email and a medicine", async () => {
    const res = await post({ email: "asha@example.com", medicineId: crocinId });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      data: { status: "ACTIVE", medicine: { id: crocinId, brandName: "Crocin", dosage: "500mg" }, notifiedAt: null },
      meta: { created: true },
    });
  });

  it("creates the user the first time an email is seen, and reuses it after that", async () => {
    await post({ email: "asha@example.com", medicineId: crocinId });
    const other = Number((await db.query("SELECT id FROM medicines WHERE code = 'M002'")).rows[0].id);
    await post({ email: "asha@example.com", medicineId: other });
    const users = (await db.query("SELECT name, email FROM users")).rows;
    expect(users).toEqual([{ name: "asha", email: "asha@example.com" }]);
  });

  it("asking twice while waiting is one subscription (200, same id)", async () => {
    const first = (await post({ email: "asha@example.com", medicineId: crocinId })).json().data;
    const again = await post({ email: "asha@example.com", medicineId: crocinId });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.id).toBe(first.id);
    expect(again.json().meta.created).toBe(false);
    expect((await db.query("SELECT count(*) AS n FROM restock_subscriptions")).rows[0].n).toBe("1");
  });

  it("is not case or whitespace sensitive about the email", async () => {
    const a = (await post({ email: "Asha@Example.com", medicineId: crocinId })).json().data;
    const b = (await post({ email: "  asha@example.com ", medicineId: crocinId })).json().data;
    expect(b.id).toBe(a.id);
  });

  it("two users can wait for the same medicine", async () => {
    await post({ email: "a@example.com", medicineId: crocinId });
    await post({ email: "b@example.com", medicineId: crocinId });
    expect((await db.query("SELECT count(*) AS n FROM restock_subscriptions WHERE status = 'ACTIVE'")).rows[0].n).toBe("2");
  });

  it("can subscribe again once the earlier subscription was fulfilled", async () => {
    const first = (await post({ email: "a@example.com", medicineId: crocinId })).json().data;
    await db.query("UPDATE restock_subscriptions SET status = 'NOTIFIED', notified_at = now() WHERE id = $1", [first.id]);
    const again = await post({ email: "a@example.com", medicineId: crocinId });
    expect(again.statusCode).toBe(201);
    expect(again.json().data.id).not.toBe(first.id);
  });

  it("404 for a medicine that does not exist", async () => {
    const res = await post({ email: "a@example.com", medicineId: 999_999 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it.each([
    ["missing email", { medicineId: 1 }],
    ["bad email", { email: "not-an-email", medicineId: 1 }],
    ["missing medicine", { email: "a@example.com" }],
    ["non-numeric medicine", { email: "a@example.com", medicineId: "abc" }],
    ["negative medicine", { email: "a@example.com", medicineId: -3 }],
    ["unknown field", { email: "a@example.com", medicineId: 1, userId: 5 }],
  ])("400 for %s", async (_name, body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/restock-subscriptions", () => {
  it("lists only that user's subscriptions, newest first", async () => {
    const m2 = Number((await db.query("SELECT id FROM medicines WHERE code = 'M002'")).rows[0].id);
    await post({ email: "a@example.com", medicineId: crocinId });
    await post({ email: "a@example.com", medicineId: m2 });
    await post({ email: "b@example.com", medicineId: crocinId });
    const res = await get("/api/restock-subscriptions?email=a@example.com");
    expect(res.json().data.map((s: { medicine: { id: number } }) => s.medicine.id)).toEqual([m2, crocinId]);
    expect(res.json().meta.count).toBe(2);
  });

  it("is empty for an unknown email and 400 without one", async () => {
    expect((await get("/api/restock-subscriptions?email=nobody@example.com")).json().data).toEqual([]);
    expect((await get("/api/restock-subscriptions")).statusCode).toBe(400);
  });
});

describe("DELETE /api/restock-subscriptions/:id", () => {
  it("cancels a waiting subscription, which then no longer blocks a new one", async () => {
    const sub = (await post({ email: "a@example.com", medicineId: crocinId })).json().data;
    const res = await cancel(sub.id, "a@example.com");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("CANCELLED");
    expect((await post({ email: "a@example.com", medicineId: crocinId })).statusCode).toBe(201);
  });

  it("404 for someone else's subscription, an unknown id, or one that is no longer waiting (same answer for all)", async () => {
    const sub = (await post({ email: "a@example.com", medicineId: crocinId })).json().data;
    expect((await cancel(sub.id, "b@example.com")).statusCode).toBe(404);
    expect((await cancel(999_999, "a@example.com")).statusCode).toBe(404);
    expect((await cancel(sub.id, "a@example.com")).statusCode).toBe(200);
    expect((await cancel(sub.id, "a@example.com")).statusCode).toBe(404);
    // the other user's attempt did not cancel it before the owner did
  });

  it("a cancelled subscription is never notified", async () => {
    const sub = (await post({ email: "a@example.com", medicineId: crocinId })).json().data;
    await cancel(sub.id, "a@example.com");
    expect((await db.query("SELECT status FROM restock_subscriptions WHERE id = $1", [sub.id])).rows[0].status).toBe("CANCELLED");
  });
});

describe("GET /api/notifications", () => {
  it("returns a user's notifications, newest first, and nobody else's", async () => {
    const a = (await post({ email: "a@example.com", medicineId: crocinId })).json().data;
    await post({ email: "b@example.com", medicineId: crocinId });
    await db.query(
      `INSERT INTO notifications (user_id, subscription_id, medicine_id, event_id, message, delivered_at)
       SELECT user_id, id, medicine_id, gen_random_uuid(), 'Crocin is back', now() FROM restock_subscriptions WHERE id = $1`,
      [a.id],
    );
    const res = await get("/api/notifications?email=a@example.com");
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0]).toMatchObject({ subscriptionId: a.id, medicineId: crocinId, channel: "MOCK", message: "Crocin is back" });
    expect(res.json().data[0].deliveredAt).not.toBeNull();
    expect((await get("/api/notifications?email=b@example.com")).json().data).toEqual([]);
  });

  it("validates the email and the limit", async () => {
    expect((await get("/api/notifications")).statusCode).toBe(400);
    expect((await get("/api/notifications?email=a@example.com&limit=0")).statusCode).toBe(400);
    expect((await get("/api/notifications?email=a@example.com&limit=101")).statusCode).toBe(400);
  });
});

describe("CORS", () => {
  it("allows DELETE from the web origin (cancelling a subscription)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/restock-subscriptions/1",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "DELETE" },
    });
    expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
  });
});
