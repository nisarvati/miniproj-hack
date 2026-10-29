import { addressOf, loadEmailConfig } from "./config.js";
import { escapeHtml } from "./email-template.js";
import type { MailTransport } from "./notifier.js";

/**
 * The logic of the one-off SMTP check, apart from the command line so it can be tested with a fake transport.
 *
 * It sends ONE message to ONE explicitly supplied address through the transport it is given. It imports nothing that reaches
 * PostgreSQL, Redis, the event streams or the notification dispatcher, reads no subscriber, and has no loop or retry.
 * Its result is SMTP ACCEPTANCE: the mail server took the message. It cannot know that the message reached an inbox.
 */
export const TEST_SUBJECT = "[MedLink TEST] SMTP check, not a real restock alert";

export type RecipientCheck = { ok: true; address: string } | { ok: false; reason: string };

/** One plain address, as typed. Lists, display names, quotes and line breaks are refused, so exactly one mailbox can receive it. */
export function checkRecipient(raw: string | undefined): RecipientCheck {
  const to = (raw ?? "").trim();
  if (!to) return { ok: false, reason: "No recipient. Supply one explicitly: --to=you@example.com" };
  if (/[\s,;<>"'()[\]\\]/.test(to)) return { ok: false, reason: "The recipient must be a single plain email address (no spaces, commas, quotes or display names)." };
  if (addressOf(to) !== to) return { ok: false, reason: "The recipient is not a valid email address." };
  return { ok: true, address: to };
}

export function renderTestEmail(sender: string, sentAt: Date): { subject: string; text: string; html: string } {
  const when = sentAt.toISOString();
  const text = [
    "MedLink: SMTP test",
    "",
    "This is a test message from MedLink's email notifier, sent once by a developer to check that the mail server accepts it.",
    "It is NOT a restock alert. No medicine, pharmacy or stock is being reported, and no subscriber was contacted.",
    "",
    `Sent: ${when}`,
    `From: ${sender}`,
    "",
    "If you did not expect this message, you can ignore it.",
  ].join("\n");
  const e = escapeHtml;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(TEST_SUBJECT)}</title></head>
<body style="margin:0;padding:0;background:#f0ede0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #1a1c17;font-family:Helvetica,Arial,sans-serif;color:#1a1c17;">
<tr><td style="padding:20px 28px;border-bottom:1px solid #1a1c17;"><span style="font-size:24px;font-weight:700;letter-spacing:-1px;">MedLink</span> <span style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#285c45;padding-left:8px;">SMTP test</span></td></tr>
<tr><td style="padding:24px 28px;font-size:16px;line-height:1.55;">
<p style="margin:0 0 12px 0;">This is a <strong>test message</strong> from MedLink's email notifier, sent once by a developer to check that the mail server accepts it.</p>
<p style="margin:0 0 12px 0;">It is <strong>not a restock alert</strong>. No medicine, pharmacy or stock is being reported, and no subscriber was contacted.</p>
<p style="margin:0;font-size:13px;color:#55584b;">Sent: ${e(when)}<br>From: ${e(sender)}</p></td></tr>
<tr><td style="padding:14px 28px 22px;font-size:12px;color:#55584b;border-top:1px solid #e5ede2;">If you did not expect this message, you can ignore it.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: TEST_SUBJECT, text, html };
}

export interface TestSendResult {
  /** "dry-run": nothing was sent. "accepted": the SMTP server accepted the message. "failed": it did not, or it could not be tried. */
  status: "dry-run" | "accepted" | "failed";
  /** What to tell the developer. Never contains a secret. */
  message: string;
  messageId?: string;
}

/** Removes any occurrence of a secret from text that is about to be shown. */
export const redact = (text: string, ...secrets: (string | undefined)[]) => secrets.reduce<string>((t, s) => (s && s.length >= 4 ? t.split(s).join("[redacted]") : t), text);

/**
 * Sends the one test message, or (without `send`) only says what it would do. `makeTransport` is called only for a real send,
 * after the recipient and the settings have been checked, so a dry run never opens a connection.
 */
export async function runTestSend(options: {
  to: string | undefined;
  send: boolean;
  env: NodeJS.ProcessEnv;
  makeTransport: () => MailTransport & { close?: () => void };
  now?: () => Date;
}): Promise<TestSendResult> {
  const recipient = checkRecipient(options.to);
  if (!recipient.ok) return { status: "failed", message: recipient.reason };

  // EMAIL_DELIVERY_ENABLED belongs to the running service and is ignored here: this is an explicit one-off.
  const config = loadEmailConfig({ ...options.env, EMAIL_DELIVERY_ENABLED: "true" });
  if (config.problems.length || !config.from) return { status: "failed", message: `Cannot send: ${config.problems.join("; ") || "no sender address"}. Nothing was sent.` };

  const mail = renderTestEmail(config.from, (options.now ?? (() => new Date()))());
  if (!options.send) {
    return { status: "dry-run", message: `Dry run: would send ONE message from ${config.from} to ${recipient.address} with subject "${mail.subject}". Nothing was sent; no connection was made. Add --send to send it.` };
  }

  const transport = options.makeTransport();
  try {
    const result = await transport.sendMail({ from: config.from, to: recipient.address, subject: mail.subject, text: mail.text, html: mail.html, headers: { "X-MedLink-Test": "smtp-verification" } });
    if ((result.rejected?.length ?? 0) > 0 || (result.accepted && result.accepted.length === 0)) {
      return { status: "failed", message: "The mail server did not accept the recipient. Nothing was delivered." };
    }
    return {
      status: "accepted",
      messageId: result.messageId,
      message: `The SMTP server accepted ONE message for ${recipient.address}. That means the server took it, not that it reached an inbox: check the inbox and the spam folder.`,
    };
  } catch (err) {
    return { status: "failed", message: `The SMTP send failed: ${redact((err as Error).message, options.env.SMTP_PASS, options.env.SMTP_USER)}. Nothing was delivered.` };
  } finally {
    transport.close?.();
  }
}
