import nodemailer from "nodemailer";
import type { EmailConfig } from "./config.js";
import type { MailTransport } from "./notifier.js";

/**
 * The one place Nodemailer is created: Gmail's SMTP over implicit TLS (smtp.gmail.com:465) with the account and its App
 * Password. Called only when delivery is enabled and configured. It does not connect until the first message is sent, and the
 * password is read from the environment by the caller, never stored in a config object, a log or an error message.
 */
export function createGmailTransport(config: EmailConfig, env: NodeJS.ProcessEnv = process.env): MailTransport {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: config.user ?? "", pass: env.SMTP_PASS ?? "" },
    // Never hang: a mail server that does not answer is an error, not a wait.
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  }) as unknown as MailTransport;
}
