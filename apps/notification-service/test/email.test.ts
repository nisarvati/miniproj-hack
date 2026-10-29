import { describe, expect, it, vi } from "vitest";
import type { Db } from "@medlink/db";
import { addressOf, loadEmailConfig } from "../src/config.js";
import { DEMO_LISTING_LABEL, renderRestockEmail, searchLink, STOCK_DISCLAIMER } from "../src/email-template.js";
import { silentLogger } from "../src/logger.js";
import { EmailDeferredError, EmailNotConfiguredError, EmailNotifier, MockNotifier, NotifierFactory, type MailTransport, type OutgoingNotification } from "../src/notifier.js";
import { deliverPending } from "../src/store.js";

const SECRET = "app-password-should-never-appear";
const pharmacy = { name: "Example Chemist", address: "Shop 1, Test Road, Mumbai 400001", demo: true, locationVerified: false, inventorySimulated: true };
const note = (over: Partial<OutgoingNotification> = {}): OutgoingNotification => ({
  id: 7,
  channel: "MOCK",
  to: "patient@example.com",
  message: "Crocin 500mg is back in stock at Example Chemist (15 available).",
  restock: { medicine: { brandName: "Crocin", dosage: "500mg" }, pharmacy },
  ...over,
});

class FakeSmtp implements MailTransport {
  sent: Parameters<MailTransport["sendMail"]>[0][] = [];
  failNext = 0;
  reject = false;
  async sendMail(m: Parameters<MailTransport["sendMail"]>[0]) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("SMTP connection refused");
    }
    this.sent.push(m);
    return this.reject ? { accepted: [], rejected: [m.to] } : { accepted: [m.to], rejected: [], messageId: m.messageId };
  }
}
const make = (smtp: MailTransport | null, now = () => 1_000_000) =>
  new EmailNotifier(silentLogger, { transport: smtp, from: "MedLink <medlink@example.com>", appUrl: "https://medlink.example", now });

describe("loadEmailConfig", () => {
  it("is disabled by default and reports no problems", () => {
    expect(loadEmailConfig({})).toMatchObject({ enabled: false, problems: [], hasPassword: false, appUrl: "http://localhost:3000" });
    for (const v of ["false", "0", "no", "", "enabled?", "tru"]) expect(loadEmailConfig({ EMAIL_DELIVERY_ENABLED: v }).enabled).toBe(false);
    for (const v of ["true", "TRUE", "1", "yes", "on"]) expect(loadEmailConfig({ EMAIL_DELIVERY_ENABLED: v }).enabled).toBe(true);
  });

  it("when enabled, names what is missing and never returns the password", () => {
    const c = loadEmailConfig({ EMAIL_DELIVERY_ENABLED: "true" });
    expect(c.problems).toEqual(["SMTP_USER is not set", "SMTP_PASS is not set"]);
    const ok = loadEmailConfig({ EMAIL_DELIVERY_ENABLED: "true", SMTP_USER: "medlink@example.com", SMTP_PASS: SECRET });
    expect(ok).toMatchObject({ enabled: true, problems: [], hasPassword: true, from: "MedLink <medlink@example.com>" });
    expect(JSON.stringify(ok)).not.toContain(SECRET);
  });

  it("validates addresses and the site URL", () => {
    expect(loadEmailConfig({ EMAIL_DELIVERY_ENABLED: "true", SMTP_USER: "nope", SMTP_PASS: "x" }).problems).toContain("SMTP_USER is not an email address");
    expect(loadEmailConfig({ EMAIL_DELIVERY_ENABLED: "true", SMTP_USER: "a@b.co", SMTP_PASS: "x", EMAIL_FROM: "nope" }).problems).toContain("EMAIL_FROM is not an email address");
    expect(loadEmailConfig({ NEXT_PUBLIC_SITE_URL: "https://medlink.example/" }).appUrl).toBe("https://medlink.example");
    expect(loadEmailConfig({ NEXT_PUBLIC_SITE_URL: "javascript:alert(1)" }).appUrl).toBe("http://localhost:3000");
    expect(addressOf("MedLink <a@b.co>")).toBe("a@b.co");
    expect(addressOf("a@b.co")).toBe("a@b.co");
    expect(addressOf("not an address")).toBeNull();
  });
});

describe("the restock email", () => {
  const mail = renderRestockEmail({ notificationId: 7, message: note().message, medicine: { brandName: "Crocin", dosage: "500mg" }, pharmacy, appUrl: "https://medlink.example/" });

  it("has a subject, an HTML body and a plain-text fallback with the medicine, the pharmacy and a link into the app", () => {
    expect(mail.subject).toBe("Crocin 500mg is back in stock on MedLink");
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain("Crocin 500mg");
      expect(body).toContain("Example Chemist");
      expect(body).toContain("Shop 1, Test Road, Mumbai 400001");
      expect(body).toContain("https://medlink.example/search?q=Crocin%20500mg");
    }
    expect(searchLink("https://medlink.example", null)).toBe("https://medlink.example/search");
  });

  it("is responsive and branded: viewport, fluid 560px table, MedLink identity colours", () => {
    expect(mail.html).toContain('name="viewport"');
    expect(mail.html).toContain("max-width:560px");
    expect(mail.html).toContain("#285c45");
    expect(mail.html).toContain("MedLink");
  });

  it("states the stock disclaimer, the demo label and that the inventory is simulated, and does not call an unverified location verified", () => {
    for (const body of [mail.html.replace(/&amp;|&#39;/g, "'"), mail.text]) {
      expect(body).toContain("Stock changes quickly");
      expect(body).toContain("MedLink does not sell or dispense medicines");
      expect(body).toContain(DEMO_LISTING_LABEL.replace("—", "—"));
      expect(body).toContain("Inventory shown is simulated and not confirmed by Example Chemist.");
      expect(body).toContain("Location not verified");
      expect(body).not.toMatch(/Location verified\./);
    }
    expect(STOCK_DISCLAIMER).toMatch(/not a guarantee/);
    const verified = renderRestockEmail({ notificationId: 1, message: "m", medicine: null, pharmacy: { ...pharmacy, demo: false, inventorySimulated: false, locationVerified: true }, appUrl: "https://x.example" });
    expect(verified.text).toContain("Location verified.");
    expect(verified.text).not.toContain("simulated");
  });

  it("escapes everything it interpolates and cannot be made to add a subject line", () => {
    const evil = renderRestockEmail({
      notificationId: 1,
      message: "<script>alert(1)</script>",
      medicine: { brandName: "A\r\nBcc: x@y.z", dosage: "<b>" },
      pharmacy: { ...pharmacy, name: '"><img src=x>', address: "<i>" },
      appUrl: "https://x.example",
    });
    expect(evil.html).not.toContain("<script>");
    expect(evil.html).not.toContain("<img src=x>");
    expect(evil.html).not.toMatch(/<b>[^<]*<\/b> is back/);
    expect(evil.subject).not.toMatch(/[\r\n]/);
  });
});

describe("EmailNotifier with a mocked SMTP transport (no real mail)", () => {
  it("sends one email to the subscriber with HTML, text, a stable Message-ID and the notification id header", async () => {
    const smtp = new FakeSmtp();
    await make(smtp).send(note());
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({
      from: "MedLink <medlink@example.com>",
      to: "patient@example.com",
      subject: "Crocin 500mg is back in stock on MedLink",
      messageId: "<medlink-notification-7@example.com>",
      headers: { "X-MedLink-Notification-Id": "7" },
    });
    expect(smtp.sent[0]!.html).toContain("<html");
    expect(smtp.sent[0]!.text).toContain("Example Chemist");
  });

  it("fails safely without credentials: throws, makes no call, and never reports a send", async () => {
    const log = vi.fn();
    const n = new EmailNotifier({ ...silentLogger, info: log, warn: log, error: log }, { transport: null, from: null, appUrl: "http://x", problems: ["SMTP_PASS is not set"] });
    await expect(n.send(note())).rejects.toBeInstanceOf(EmailNotConfiguredError);
    await expect(n.send(note())).rejects.toThrow(/SMTP_PASS is not set.*Nothing was sent/);
    expect(log).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/accepted|sent to/i));
  });

  it("does not send to an invalid address, or one that could inject a header", async () => {
    const smtp = new FakeSmtp();
    for (const to of ["nobody", "a@b", "x@y.z\nBcc: evil@example.com", "A <a@b.co>"]) await expect(make(smtp).send(note({ to }))).rejects.toThrow(/Invalid email address/);
    expect(smtp.sent).toHaveLength(0);
  });

  it("an SMTP failure throws (so the notification stays pending), backs off, then retries and sends once", async () => {
    const smtp = new FakeSmtp();
    smtp.failNext = 1;
    let t = 1_000_000;
    const n = make(smtp, () => t);
    await expect(n.send(note())).rejects.toThrow(/SMTP connection refused/);
    await expect(n.send(note())).rejects.toBeInstanceOf(EmailDeferredError); // the 5 s sweep does not hammer the server
    expect(smtp.sent).toHaveLength(0);
    t += 31_000;
    await n.send(note());
    expect(smtp.sent).toHaveLength(1);
  });

  it("a rejected recipient is a failure, not a delivery", async () => {
    const smtp = new FakeSmtp();
    smtp.reject = true;
    await expect(make(smtp).send(note())).rejects.toThrow(/did not accept/);
  });

  it("never sends the same notification twice, even when it is offered again (retry, replay, a failed database update)", async () => {
    const smtp = new FakeSmtp();
    const n = make(smtp);
    await n.send(note());
    await n.send(note());
    await n.send(note());
    expect(smtp.sent).toHaveLength(1);
    await n.send(note({ id: 8 }));
    expect(smtp.sent).toHaveLength(2);
  });

  it("the factory builds it, and the composite routes the email channel to it", async () => {
    const smtp = new FakeSmtp();
    const opts = { transport: smtp, from: "medlink@example.com", appUrl: "https://x.example" };
    expect(NotifierFactory.createNotifier("email", silentLogger, opts)).toBeInstanceOf(EmailNotifier);
    await NotifierFactory.createNotifier("composite", silentLogger, opts).send(note({ channel: "email" }));
    expect(smtp.sent).toHaveLength(1);
  });
});

/** A pg-shaped fake: enough to show deliverPending's transaction shape without a database. */
function fakeDb(rows: Record<string, unknown>[]) {
  const log: string[] = [];
  const delivered = new Set<string>();
  const client = {
    async query(sql: string, params?: unknown[]) {
      const head = sql.trim().split(/\s+/)[0]!.toUpperCase();
      if (head === "BEGIN" || head === "COMMIT" || head === "ROLLBACK") {
        log.push(head);
        return { rows: [] };
      }
      if (head === "SELECT") {
        const after = Number(params?.[0]);
        const r = rows.find((x) => Number(x.id) > after && !delivered.has(String(x.id)));
        log.push(`SELECT after ${after}`);
        return { rows: r ? [r] : [] };
      }
      delivered.add(String(params?.[0]));
      log.push(`UPDATE ${params?.[0]}`);
      return { rows: [] };
    },
    release() {},
  };
  return { db: { connect: async () => client } as unknown as Db, log, delivered };
}
const row = (id: number, email: string, over: Record<string, unknown> = {}) => ({
  id: String(id), channel: "MOCK", message: "m", email, brand_name: "Crocin", dosage: "500mg",
  pharmacy_code: "P001", pharmacy_name: "Pharmacy A - Andheri West", pharmacy_address: "x", latitude: 19.1, longitude: 72.8, ...over,
});

describe("deliverPending (transaction shape, no database)", () => {
  it("commits after EACH notification, so a crash can repeat at most the one in flight", async () => {
    const { db, log } = fakeDb([row(1, "a@example.com"), row(2, "b@example.com")]);
    const sent: number[] = [];
    const n = await deliverPending(db, { send: async (x) => void sent.push(x.id) }, silentLogger);
    expect(n).toBe(2);
    expect(sent).toEqual([1, 2]);
    expect(log.filter((l) => l === "COMMIT").length).toBeGreaterThanOrEqual(2);
    expect(log.indexOf("UPDATE 1")).toBeLessThan(log.indexOf("SELECT after 1")); // 1 is marked and committed before 2 is taken
  });

  it("leaves a failed one pending, does not retry it within the pass, and still sends the rest", async () => {
    const { db, delivered } = fakeDb([row(1, "bad@example.com"), row(2, "good@example.com")]);
    const tries: string[] = [];
    const n = await deliverPending(db, { send: async (x) => { tries.push(x.to); if (x.to.startsWith("bad")) throw new Error("down"); } }, silentLogger);
    expect(n).toBe(1);
    expect(tries).toEqual(["bad@example.com", "good@example.com"]);
    expect([...delivered]).toEqual(["2"]);
  });

  it("hands the channel the medicine and the pharmacy as MedLink presents them (name, demo and verification flags)", async () => {
    const { db } = fakeDb([row(1, "a@example.com")]);
    let seen: OutgoingNotification | undefined;
    await deliverPending(db, { send: async (x) => void (seen = x) }, silentLogger);
    expect(seen!.restock!.medicine).toEqual({ brandName: "Crocin", dosage: "500mg" });
    expect(seen!.restock!.pharmacy).toMatchObject({ name: "Paras Medical and General Store", demo: true, inventorySimulated: true, locationVerified: false });
  });

  it("with email unconfigured nothing is marked delivered", async () => {
    const { db, delivered } = fakeDb([row(1, "a@example.com")]);
    const n = await deliverPending(db, new EmailNotifier(silentLogger), silentLogger);
    expect(n).toBe(0);
    expect(delivered.size).toBe(0);
  });

  it("the simulated notifier still works when email is off", async () => {
    const { db, delivered } = fakeDb([row(1, "a@example.com")]);
    expect(await deliverPending(db, new MockNotifier(silentLogger), silentLogger)).toBe(1);
    expect(delivered.size).toBe(1);
  });
});
