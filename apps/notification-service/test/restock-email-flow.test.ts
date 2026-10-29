import { describe, expect, it } from "vitest";
import type { Db } from "@medlink/db";
import type { InventoryEvent } from "@medlink/event-schema";
import { RestockNotificationHandler } from "../src/handler.js";
import { silentLogger } from "../src/logger.js";
import { EmailNotifier, type MailTransport } from "../src/notifier.js";

/**
 * A restock event, through the real handler, the real fulfilment and delivery code and the real EmailNotifier, with a scripted
 * stand-in for PostgreSQL and a fake SMTP transport. No database, no Redis, no mail. It checks the wiring that a website-driven
 * restock relies on; the SQL itself is covered by store.test.ts against a real database.
 */
function scriptedDb() {
  const state = {
    waiting: [{ id: "5", user_id: "3" }] as { id: string; user_id: string }[],
    notifications: [] as { id: string; email: string; delivered: boolean; message: string }[],
    fulfilCalls: 0,
  };
  const target = { medicine_id: "1", brand_name: "Crocin", dosage: "500mg", pharmacy_id: "4", pharmacy_name: "Pharmacy D - Bandra West", pharmacy_address: "Linking Road, Bandra West, Mumbai", latitude: 19.0596, longitude: 72.83 };
  const db = {
    async query(sql: string, params: unknown[]) {
      if (sql.includes("FROM medicines m")) return { rows: [target] };
      if (sql.includes("WITH due AS")) {
        state.fulfilCalls++;
        const due = state.waiting.splice(0); // ACTIVE -> NOTIFIED: a second call finds nothing
        const made = due.map((d, i) => ({ id: String(100 + state.notifications.length + i), subscription_id: d.id, user_id: d.user_id }));
        for (const m of made) state.notifications.push({ id: m.id, email: "patient@example.com", delivered: false, message: String(params[4]) });
        return { rows: made };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 40)}`);
    },
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) {
          const head = sql.trim().split(/\s+/)[0]!.toUpperCase();
          if (head === "SELECT") {
            const n = state.notifications.find((x) => !x.delivered && Number(x.id) > Number(params?.[0]));
            return { rows: n ? [{ id: n.id, channel: "MOCK", message: n.message, email: n.email, brand_name: "Crocin", dosage: "500mg", pharmacy_code: "P004", pharmacy_name: target.pharmacy_name, pharmacy_address: target.pharmacy_address, latitude: 19.0596, longitude: 72.83 }] : [] };
          }
          if (head === "UPDATE") {
            state.notifications.find((x) => x.id === String(params?.[0]))!.delivered = true;
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  } as unknown as Db;
  return { db, state };
}

class FakeSmtp implements MailTransport {
  sent: Parameters<MailTransport["sendMail"]>[0][] = [];
  failures = 0;
  async sendMail(m: Parameters<MailTransport["sendMail"]>[0]) {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("SMTP unavailable");
    }
    this.sent.push(m);
    return { accepted: [m.to], rejected: [] };
  }
}

const event = (over: Partial<InventoryEvent> = {}) =>
  ({ schemaVersion: 1, eventId: "11111111-1111-4111-8111-111111111111", eventType: "RESTOCK", pharmacyId: "P004", medicineId: "M001", timestamp: "2026-10-23T10:00:00.000Z", quantityDelta: 5, quantityAfter: 5, ...over }) as InventoryEvent;
const setup = (smtp: MailTransport, now = () => 1_000_000) => {
  const { db, state } = scriptedDb();
  const notifier = new EmailNotifier(silentLogger, { transport: smtp, from: "MedLink <medlink@example.com>", appUrl: "http://localhost:3000", now });
  return { handler: new RestockNotificationHandler(db, notifier, silentLogger), state };
};

describe("a qualifying restock reaches the subscriber's inbox (mock SMTP)", () => {
  it("sends one email naming the medicine and the pharmacy, and records delivery only after SMTP accepted it", async () => {
    const smtp = new FakeSmtp();
    const { handler, state } = setup(smtp);
    await handler.handle(event());
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({ to: "patient@example.com", subject: "Crocin 500mg is back in stock on MedLink" });
    expect(smtp.sent[0]!.text).toContain("Bandra Medical Stores"); // as MedLink presents the pharmacy elsewhere
    expect(smtp.sent[0]!.text).toContain("Inventory shown is simulated");
    expect(state.notifications.map((n) => n.delivered)).toEqual([true]);
  });

  it("sends nothing for a sale, a price change, an addition or a removal", async () => {
    for (const e of [
      event({ eventType: "SALE", quantityDelta: -1, quantityAfter: 4 } as Partial<InventoryEvent>),
      event({ eventType: "PRICE_UPDATED", price: 30 } as Partial<InventoryEvent>),
      event({ eventType: "MEDICINE_ADDED", quantityDelta: 5, quantityAfter: 5, price: 30 } as Partial<InventoryEvent>),
      event({ eventType: "MEDICINE_REMOVED", quantityDelta: -5, quantityAfter: 0 } as Partial<InventoryEvent>),
    ]) {
      const smtp = new FakeSmtp();
      const { handler, state } = setup(smtp);
      await handler.handle(e);
      expect(smtp.sent).toHaveLength(0);
      expect(state.fulfilCalls).toBe(0);
    }
  });

  it("a retried or replayed event does not send a second email", async () => {
    const smtp = new FakeSmtp();
    const { handler, state } = setup(smtp);
    await handler.handle(event());
    await handler.handle(event());
    await handler.handle(event());
    expect(smtp.sent).toHaveLength(1);
    expect(state.notifications).toHaveLength(1);
  });

  it("with nobody waiting, nothing is sent", async () => {
    const smtp = new FakeSmtp();
    const { handler, state } = setup(smtp);
    state.waiting.length = 0;
    await handler.handle(event());
    expect(smtp.sent).toHaveLength(0);
  });

  it("an SMTP failure does not fail the event or mark the notification delivered; a later pass sends it once", async () => {
    const smtp = new FakeSmtp();
    smtp.failures = 1;
    let t = 1_000_000;
    const { db, state } = scriptedDb();
    const notifier = new EmailNotifier(silentLogger, { transport: smtp, from: "medlink@example.com", appUrl: "http://x", now: () => t });
    const handler = new RestockNotificationHandler(db, notifier, silentLogger);
    await expect(handler.handle(event())).resolves.toBeUndefined(); // the event is not retried: nothing is left to fulfil
    expect(state.notifications.map((n) => n.delivered)).toEqual([false]);
    expect(smtp.sent).toHaveLength(0);

    const { deliverPending } = await import("../src/store.js");
    expect(await deliverPending(db, notifier, silentLogger)).toBe(0); // inside the back-off: not hammered
    t += 31_000;
    expect(await deliverPending(db, notifier, silentLogger)).toBe(1);
    expect(smtp.sent).toHaveLength(1);
    expect(await deliverPending(db, notifier, silentLogger)).toBe(0);
    expect(smtp.sent).toHaveLength(1);
    expect(state.notifications.map((n) => n.delivered)).toEqual([true]);
  });

  it("with email unconfigured, the alert stays pending and no email is claimed", async () => {
    const { db, state } = scriptedDb();
    const handler = new RestockNotificationHandler(db, new EmailNotifier(silentLogger), silentLogger);
    await handler.handle(event());
    expect(state.notifications.map((n) => n.delivered)).toEqual([false]);
  });
});
