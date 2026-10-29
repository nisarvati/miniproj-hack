/**
 * The restock email: a branded MedLink message with an HTML body (table layout, inline styles, fluid width, so it reads on a
 * phone and in the common mail clients) and a plain-text alternative. Pure: it builds strings from what it is given.
 *
 * Honesty rules, in the text and the HTML alike:
 *  - the pharmacy's name and address are shown as MedLink presents them elsewhere, and its location is called verified only
 *    when it is; a demo listing says so, and says its stock is simulated and not confirmed by that pharmacy;
 *  - the message never promises the medicine is there: stock changes, the alert reflects one restock report;
 *  - MedLink does not sell or dispense medicines.
 * Every value interpolated into HTML is escaped.
 */
export interface EmailPharmacy {
  name: string;
  address: string;
  demo: boolean;
  locationVerified: boolean;
  inventorySimulated: boolean;
}

export interface RestockEmailInput {
  notificationId: number;
  /** The sentence MedLink stored for the notification, e.g. "Crocin 500mg is back in stock at ... (15 available)." */
  message: string;
  medicine: { brandName: string; dosage: string } | null;
  pharmacy: EmailPharmacy | null;
  appUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const DEMO_LISTING_LABEL = "Demo directory listing — not a confirmed MedLink partner.";
export const STOCK_DISCLAIMER =
  "Stock changes quickly. This alert reflects what was reported at the time of the restock, not a guarantee that the medicine is still available. Please call the pharmacy to confirm before you travel. MedLink does not sell or dispense medicines.";

const FOREST = "#285c45";
const DEEP = "#1e4636";
const PAPER = "#f0ede0";
const PALE = "#e5ede2";
const INK = "#1a1c17";
const SOFT = "#55584b";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Strips line breaks so a value can never add a header or a line to the subject. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export const medicineLabel = (m: RestockEmailInput["medicine"]) => (m ? oneLine(`${m.brandName} ${m.dosage}`) : "Your medicine");

/** The link to the existing application: its search page for this medicine. */
export function searchLink(appUrl: string, m: RestockEmailInput["medicine"]): string {
  const base = appUrl.replace(/\/+$/, "");
  return m ? `${base}/search?q=${encodeURIComponent(medicineLabel(m))}` : `${base}/search`;
}

function pharmacyNotes(p: EmailPharmacy): string[] {
  const notes: string[] = [];
  if (p.demo) notes.push(DEMO_LISTING_LABEL);
  if (p.inventorySimulated) notes.push(`Inventory shown is simulated and not confirmed by ${oneLine(p.name)}.`);
  notes.push(p.locationVerified ? "Location verified." : "Location not verified: check the address before you travel.");
  return notes;
}

export function renderRestockEmail(input: RestockEmailInput): RenderedEmail {
  const med = medicineLabel(input.medicine);
  const link = searchLink(input.appUrl, input.medicine);
  const subject = oneLine(`${med} is back in stock on MedLink`);
  const p = input.pharmacy;
  const notes = p ? pharmacyNotes(p) : [];

  const text = [
    "MedLink",
    "",
    `${med} is back in stock`,
    "",
    input.message,
    "",
    ...(p ? ["Pharmacy", oneLine(p.name), oneLine(p.address), ...notes.map((n) => `- ${n}`), ""] : []),
    "See it on MedLink:",
    link,
    "",
    STOCK_DISCLAIMER,
    "",
    "You are receiving this because you asked MedLink to tell you when this medicine is back in stock.",
    `Reference: notification ${input.notificationId}`,
  ].join("\n");

  const e = escapeHtml;
  const pharmacyBlock = p
    ? `<tr><td style="padding:0 28px 8px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALE};border:1px solid ${INK};">
          <tr><td style="padding:16px 18px;font-family:Helvetica,Arial,sans-serif;color:${INK};">
            <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${SOFT};">Pharmacy</div>
            <div style="font-size:18px;font-weight:700;margin:4px 0 2px 0;">${e(oneLine(p.name))}</div>
            <div style="font-size:14px;line-height:1.5;color:${INK};">${e(oneLine(p.address))}</div>
            ${notes.map((n) => `<div style="font-size:12px;line-height:1.5;color:${SOFT};margin-top:6px;">${e(n)}</div>`).join("")}
          </td></tr>
        </table>
      </td></tr>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${e(input.message)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${INK};">
    <tr><td style="padding:22px 28px 14px 28px;border-bottom:1px solid ${INK};font-family:Helvetica,Arial,sans-serif;">
      <span style="font-size:24px;font-weight:700;letter-spacing:-1px;color:${INK};">MedLink</span>
      <span style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${FOREST};padding-left:10px;">Restock alert</span>
    </td></tr>
    <tr><td style="padding:26px 28px 6px 28px;font-family:Helvetica,Arial,sans-serif;color:${INK};">
      <div style="font-size:28px;line-height:1.1;font-weight:700;letter-spacing:-1px;"><span style="color:${FOREST};">${e(med)}</span> is back in stock.</div>
      <p style="font-size:16px;line-height:1.55;margin:14px 0 18px 0;">${e(input.message)}</p>
    </td></tr>
    ${pharmacyBlock}
    <tr><td style="padding:18px 28px 8px 28px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${FOREST};">
        <a href="${e(link)}" style="display:inline-block;padding:13px 22px;font-family:'Courier New',monospace;font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;">See it on MedLink &rarr;</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="padding:14px 28px 6px 28px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;color:${SOFT};">${e(STOCK_DISCLAIMER)}</td></tr>
    <tr><td style="padding:16px 28px 24px 28px;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${SOFT};border-top:1px solid ${PALE};">
      You are receiving this because you asked MedLink to tell you when this medicine is back in stock.<br>
      <span style="color:${DEEP};">Reference: notification ${input.notificationId}</span>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}
