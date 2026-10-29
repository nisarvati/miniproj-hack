import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { MailTransport } from "../src/notifier.js";
import { checkRecipient, redact, renderTestEmail, runTestSend, TEST_SUBJECT } from "../src/test-send.js";

const SECRET = "very-secret-app-password";
const env = { SMTP_USER: "sender@example.com", SMTP_PASS: SECRET };
const fakeTransport = (behaviour: "accept" | "reject" | "throw" = "accept") => {
  const sendMail = vi.fn(async (m: Parameters<MailTransport["sendMail"]>[0]) => {
    if (behaviour === "throw") throw new Error(`535 bad credentials for ${SECRET}`);
    return behaviour === "reject" ? { accepted: [], rejected: [m.to] } : { accepted: [m.to], rejected: [], messageId: "<abc@example.com>" };
  });
  const close = vi.fn();
  return { sendMail, close };
};
const run = (over: Partial<Parameters<typeof runTestSend>[0]> = {}, t = fakeTransport()) => ({ t, p: runTestSend({ to: "me@example.com", send: true, env, makeTransport: () => t, ...over }) });

describe("recipient", () => {
  it("must be supplied, and be exactly one plain address", () => {
    expect(checkRecipient(undefined).ok).toBe(false);
    expect(checkRecipient("  ").ok).toBe(false);
    expect(checkRecipient("me@example.com")).toEqual({ ok: true, address: "me@example.com" });
    for (const bad of ["a@b.co,c@d.co", "a@b.co c@d.co", "Me <a@b.co>", "a@b", "nobody", "a@b.co\nBcc: x@y.z", '"a"@b.co', "a@b.co;c@d.co"]) expect(checkRecipient(bad).ok, bad).toBe(false);
  });
});

describe("runTestSend with a mocked SMTP transport (no real mail)", () => {
  it("sends exactly ONE clearly labelled message to the one recipient, from the configured sender, and closes the connection", async () => {
    const { t, p } = run();
    const r = await p;
    expect(r.status).toBe("accepted");
    expect(t.sendMail).toHaveBeenCalledTimes(1);
    const m = t.sendMail.mock.calls[0]![0];
    expect(m).toMatchObject({ to: "me@example.com", from: "MedLink <sender@example.com>", subject: TEST_SUBJECT, headers: { "X-MedLink-Test": "smtp-verification" } });
    expect(m.subject).toMatch(/TEST/);
    expect(m.text).toMatch(/not a restock alert/i);
    expect(m.html).toMatch(/not a restock alert/i);
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it("reports acceptance, not inbox delivery", async () => {
    const r = await run().p;
    expect(r.message).toMatch(/accepted ONE message/);
    expect(r.message).toMatch(/not that it reached an inbox/);
    expect(r.message).not.toMatch(/delivered to|in your inbox\./i);
    expect(r.messageId).toBe("<abc@example.com>");
  });

  it("is a dry run without send: no transport is created and nothing is sent", async () => {
    const makeTransport = vi.fn(() => fakeTransport());
    const r = await runTestSend({ to: "me@example.com", send: false, env, makeTransport });
    expect(r.status).toBe("dry-run");
    expect(r.message).toMatch(/Nothing was sent; no connection was made/);
    expect(makeTransport).not.toHaveBeenCalled();
  });

  it("refuses a missing or invalid recipient before it does anything else", async () => {
    for (const to of [undefined, "", "a@b.co,c@d.co", "Me <a@b.co>"]) {
      const makeTransport = vi.fn(() => fakeTransport());
      const r = await runTestSend({ to, send: true, env, makeTransport });
      expect(r.status).toBe("failed");
      expect(makeTransport).not.toHaveBeenCalled();
    }
  });

  it("refuses without credentials, names what is missing, and never opens a connection", async () => {
    const makeTransport = vi.fn(() => fakeTransport());
    const r = await runTestSend({ to: "me@example.com", send: true, env: {}, makeTransport });
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/SMTP_USER is not set; SMTP_PASS is not set/);
    expect(makeTransport).not.toHaveBeenCalled();
  });

  it("ignores EMAIL_DELIVERY_ENABLED: the service switch is not needed for an explicit one-off", async () => {
    const r = await run({ env: { ...env, EMAIL_DELIVERY_ENABLED: "false" } }).p;
    expect(r.status).toBe("accepted");
  });

  it("a rejected recipient is a failure", async () => {
    expect((await run({}, fakeTransport("reject")).p).status).toBe("failed");
  });

  it("an SMTP error is a failure, is not retried, and never shows the password", async () => {
    const { t, p } = run({}, fakeTransport("throw"));
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.message).not.toContain(SECRET);
    expect(r.message).toContain("[redacted]");
    expect(t.sendMail).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it("never puts a secret in any message it returns", async () => {
    for (const behaviour of ["accept", "reject", "throw"] as const) expect(JSON.stringify(await run({}, fakeTransport(behaviour)).p)).not.toContain(SECRET);
    expect(JSON.stringify(await run({ send: false }).p)).not.toContain(SECRET);
    expect(redact(`x ${SECRET} y`, SECRET)).toBe("x [redacted] y");
  });

  it("the test email is plainly a test: no medicine, pharmacy or stock, and its values are escaped", () => {
    const m = renderTestEmail("A <b>@example.com", new Date("2026-10-23T10:00:00Z"));
    expect(m.html).not.toContain("<b>@");
    expect(m.text).toMatch(/NOT a restock alert/);
    expect(m.text).not.toMatch(/in stock|Crocin|pharmacy:/i);
  });
});

describe("the script stays apart from the service", () => {
  const files = ["send-test-email.ts", "test-send.ts"].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"));

  it("imports nothing that reaches PostgreSQL, Redis, the event streams, subscribers or the dispatcher", () => {
    for (const src of files) {
      // type-only imports are erased at build time, so only value imports can reach another module at run time
      const imports = [...src.matchAll(/^import (?!type\b).* from "(.+)";/gm)].map((m) => m[1]!);
      for (const i of imports) expect(i, i).not.toMatch(/@medlink\/(db|redis|inventory-sync|event-schema)|store\.js|service\.js|handler\.js|notifier\.js/);
      expect(src).not.toMatch(/deliverPending|fulfilSubscriptions|createPool|createRedis|NotificationService/);
    }
  });

  it("is not wired into the service's start, and a normal npm test never runs it", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).not.toMatch(/send-test-email/);
    expect(readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")).not.toMatch(/send-test-email|test-send/);
    expect(pkg.scripts["send-test-email"]).toMatch(/send-test-email\.ts/);
  });
});
