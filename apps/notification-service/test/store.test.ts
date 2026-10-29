import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@medlink/db";
import { freshSeededDb } from "@medlink/db/testing";
import { silentLogger } from "../src/logger.js";
import type { Notifier, OutgoingNotification } from "../src/notifier.js";
import type { Restock } from "../src/restock.js";
import { deliverPending, fulfilSubscriptions } from "../src/store.js";

let db: Db;
let crocin: number; // M001
let other: number; // M002

beforeAll(async () => {
  db = await freshSeededDb();
  const ids = (await db.query<{ code: string; id: string }>("SELECT code, id FROM medicines WHERE code IN ('M001','M002')")).rows;
  crocin = Number(ids.find((r) => r.code === "M001")!.id);
  other = Number(ids.find((r) => r.code === "M002")!.id);
});
beforeEach(async () => {
  await db.query("TRUNCATE notifications, restock_subscriptions, users RESTART IDENTITY CASCADE");
});
afterAll(async () => {
  await db.end();
});

async function user(email: string): Promise<number> {
  return Number((await db.query("INSERT INTO users (name, email) VALUES ($1, $1) RETURNING id", [email])).rows[0].id);
}
async function subscribeTo(userId: number, medicineId: number, status = "ACTIVE"): Promise<number> {
  const notified = status === "NOTIFIED" ? ", now()" : ", NULL";
  return Number(
    (await db.query(`INSERT INTO restock_subscriptions (user_id, medicine_id, status, notified_at) VALUES ($1, $2, $3 ${notified}) RETURNING id`, [userId, medicineId, status])).rows[0].id,
  );
}
const restock = (over: Partial<Restock> = {}): Restock => ({
  eventId: crypto.randomUUID(),
  pharmacyCode: "P001",
  medicineCode: "M001",
  quantity: 12,
  price: 25,
  occurredAt: new Date(Date.now() + 1000), // after the subscriptions made in the test
  ...over,
});
const count = async (sql: string) => Number((await db.query(sql)).rows[0].n);

describe("fulfilSubscriptions", () => {
  it("notifies each user waiting for that medicine, and only them", async () => {
    const a = await user("a@example.com");
    const b = await user("b@example.com");
    const c = await user("c@example.com");
    const d = await user("d@example.com");
    await subscribeTo(a, crocin);
    await subscribeTo(b, crocin);
    await subscribeTo(c, other); // different medicine
    await subscribeTo(d, crocin, "NOTIFIED"); // already told
    await db.query("INSERT INTO restock_subscriptions (user_id, medicine_id, status) VALUES ($1, $2, 'CANCELLED')", [d, crocin]);

    const done = await fulfilSubscriptions(db, restock());
    expect(done.map((f) => f.userId).sort()).toEqual([a, b].sort());
    expect(await count("SELECT count(*) AS n FROM notifications")).toBe(2);
    expect((await db.query("SELECT user_id FROM notifications ORDER BY user_id")).rows.map((r) => Number(r.user_id))).toEqual([a, b].sort());
  });

  it("marks the subscription notified and stores a readable message naming the medicine and the pharmacy", async () => {
    const u = await user("a@example.com");
    const sub = await subscribeTo(u, crocin);
    const event = restock({ quantity: 7 });
    await fulfilSubscriptions(db, event);

    const s = (await db.query("SELECT status, notified_at FROM restock_subscriptions WHERE id = $1", [sub])).rows[0];
    expect(s.status).toBe("NOTIFIED");
    expect(s.notified_at).toBeInstanceOf(Date);
    const n = (await db.query("SELECT * FROM notifications")).rows[0];
    expect(n).toMatchObject({ channel: "MOCK", event_id: event.eventId, delivered_at: null });
    expect(n.message).toMatch(/^Crocin 500mg is back in stock at .+ \(7 available\)\.$/);
    expect(Number(n.medicine_id)).toBe(crocin);
    expect(n.pharmacy_id).not.toBeNull();
  });

  it("fulfils nothing when no one is waiting", async () => {
    expect(await fulfilSubscriptions(db, restock())).toEqual([]);
  });

  it("is idempotent: the same event delivered again notifies nobody a second time", async () => {
    await subscribeTo(await user("a@example.com"), crocin);
    const event = restock();
    expect(await fulfilSubscriptions(db, event)).toHaveLength(1);
    expect(await fulfilSubscriptions(db, event)).toHaveLength(0);
    expect(await count("SELECT count(*) AS n FROM notifications")).toBe(1);
  });

  it("is exactly-once even when several instances handle the same event at the same moment", async () => {
    for (let i = 0; i < 4; i++) await subscribeTo(await user(`u${i}@example.com`), crocin);
    const event = restock();
    const results = await Promise.all(Array.from({ length: 6 }, () => fulfilSubscriptions(db, event)));
    expect(results.flat()).toHaveLength(4);
    expect(await count("SELECT count(*) AS n FROM notifications")).toBe(4);
    expect(await count("SELECT count(DISTINCT subscription_id) AS n FROM notifications")).toBe(4);
  });

  it("a user who subscribed AFTER the restock is not told about it (an old event replayed later)", async () => {
    const early = await user("early@example.com");
    await subscribeTo(early, crocin);
    const happened = new Date(Date.now() + 500);
    await new Promise((r) => setTimeout(r, 700));
    const late = await user("late@example.com");
    await subscribeTo(late, crocin);

    const done = await fulfilSubscriptions(db, restock({ occurredAt: happened }));
    expect(done.map((f) => f.userId)).toEqual([early]);
    // the late subscriber is still waiting for the NEXT restock
    expect((await db.query("SELECT status FROM restock_subscriptions WHERE user_id = $1", [late])).rows[0].status).toBe("ACTIVE");
  });

  it("still notifies when the pharmacy is not in this database, just without its name", async () => {
    await subscribeTo(await user("a@example.com"), crocin);
    const done = await fulfilSubscriptions(db, restock({ pharmacyCode: "P777" }));
    expect(done).toHaveLength(1);
    const n = (await db.query("SELECT message, pharmacy_id FROM notifications")).rows[0];
    expect(n.pharmacy_id).toBeNull();
    expect(n.message).toBe("Crocin 500mg is back in stock (12 available).");
  });

  it("ignores a medicine this database does not know", async () => {
    await subscribeTo(await user("a@example.com"), crocin);
    expect(await fulfilSubscriptions(db, restock({ medicineCode: "M999" }))).toEqual([]);
    expect(await count("SELECT count(*) AS n FROM restock_subscriptions WHERE status = 'ACTIVE'")).toBe(1);
  });

  it("subscribing again after being notified starts a new subscription", async () => {
    const u = await user("a@example.com");
    await subscribeTo(u, crocin);
    await fulfilSubscriptions(db, restock());
    await subscribeTo(u, crocin); // allowed: the first one is no longer ACTIVE
    expect(await count("SELECT count(*) AS n FROM restock_subscriptions WHERE status = 'ACTIVE'")).toBe(1);
    await expect(subscribeTo(u, crocin)).rejects.toMatchObject({ code: "23505" }); // but two waiting ones are not
  });
});

describe("deliverPending", () => {
  class Recorder implements Notifier {
    sent: OutgoingNotification[] = [];
    failFor = new Set<string>();
    async send(n: OutgoingNotification) {
      if (this.failFor.has(n.to)) throw new Error("channel down");
      this.sent.push(n);
    }
  }
  const setup = async (emails: string[]) => {
    for (const e of emails) await subscribeTo(await user(e), crocin);
    await fulfilSubscriptions(db, restock());
  };

  it("sends every stored notification once and marks it delivered", async () => {
    await setup(["a@example.com", "b@example.com"]);
    const rec = new Recorder();
    expect(await deliverPending(db, rec, silentLogger)).toBe(2);
    expect(rec.sent.map((n) => n.to).sort()).toEqual(["a@example.com", "b@example.com"]);
    expect(rec.sent[0]).toMatchObject({ channel: "MOCK" });
    expect(await count("SELECT count(*) AS n FROM notifications WHERE delivered_at IS NULL")).toBe(0);
    expect(await deliverPending(db, rec, silentLogger)).toBe(0);
    expect(rec.sent).toHaveLength(2);
  });

  it("leaves a notification that failed to send pending, without blocking the others, and sends it later", async () => {
    await setup(["bad@example.com", "good@example.com"]);
    const rec = new Recorder();
    rec.failFor.add("bad@example.com");
    expect(await deliverPending(db, rec, silentLogger)).toBe(1);
    expect(rec.sent.map((n) => n.to)).toEqual(["good@example.com"]);
    expect(await count("SELECT count(*) AS n FROM notifications WHERE delivered_at IS NULL")).toBe(1);

    rec.failFor.clear();
    expect(await deliverPending(db, rec, silentLogger)).toBe(1);
    expect(rec.sent.map((n) => n.to)).toEqual(["good@example.com", "bad@example.com"]);
  });

  it("two instances sweeping at once never send the same notification twice", async () => {
    await setup(Array.from({ length: 8 }, (_, i) => `u${i}@example.com`));
    const rec = new Recorder();
    const slow: Notifier = { send: async (n) => { await new Promise((r) => setTimeout(r, 15)); await rec.send(n); } };
    const counts = await Promise.all([deliverPending(db, slow, silentLogger), deliverPending(db, slow, silentLogger)]);
    expect(counts[0]! + counts[1]!).toBe(8);
    expect(new Set(rec.sent.map((n) => n.id)).size).toBe(8);
    expect(rec.sent).toHaveLength(8);
  });
});
