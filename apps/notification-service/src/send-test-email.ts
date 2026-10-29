import { createGmailTransport } from "./mailer.js";
import { loadEmailConfig } from "./config.js";
import { runTestSend } from "./test-send.js";

/**
 * npm run notify:test-email -- --to=you@example.com [--send]
 *
 * A one-off check that Gmail's SMTP server accepts a message from MedLink's sender account. It is never run by the service,
 * a test or any other script. Without --send it only reports what it would do (no connection is opened). With --send it sends
 * exactly one clearly labelled test message to the one address given with --to. It does not touch PostgreSQL, Redis, the event
 * streams, pending notifications or subscribers. The result is SMTP acceptance, not a promise of inbox delivery.
 */
const args = process.argv.slice(2);
const usage = "Usage: npm run notify:test-email -- --to=you@example.com [--send]";
const tos = args.filter((a) => a.startsWith("--to="));
const unknown = args.filter((a) => a !== "--send" && !a.startsWith("--to="));
if (unknown.length || tos.length > 1) {
  console.error(`${tos.length > 1 ? "Give --to once: one recipient only." : `Unknown option ${unknown.join(" ")}.`}\n${usage}`);
  process.exit(2);
}

const result = await runTestSend({
  to: tos[0]?.slice("--to=".length),
  send: args.includes("--send"),
  env: process.env,
  makeTransport: () => createGmailTransport(loadEmailConfig({ ...process.env, EMAIL_DELIVERY_ENABLED: "true" })),
});
console.log(result.message);
if (result.messageId) console.log(`Message-ID: ${result.messageId}`);
process.exit(result.status === "failed" ? 1 : 0);
