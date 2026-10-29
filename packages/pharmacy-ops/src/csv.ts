/**
 * A small CSV writer (RFC 4180) with protection against spreadsheet formula injection.
 *
 * A cell that a spreadsheet would run as a formula can steal or alter data when the file is opened. Excel, Sheets and LibreOffice treat a cell as a formula when
 * its text starts with `=`, `+`, `-` or `@` (and some versions also a tab or carriage return). Staff-typed text (notes) and catalogue names go into these files,
 * so every text cell that starts with one of those characters is prefixed with a single quote, which the spreadsheet shows as plain text. The value is
 * otherwise unchanged, and the prefix is the one the OWASP guidance recommends. Numbers we generate are non-negative whole numbers and are written as they are;
 * any other number is treated as text, so a negative one is protected too.
 *
 * Fields with a comma, a double quote or a line break are quoted, with quotes doubled. Rows end with CRLF, as the RFC says, and a header row is always written,
 * so an empty export is still a valid file.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export type CsvValue = string | number | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    text = String(value);
    // A plain non-negative number is written as it is; anything else (negative, exponent) is text, so it gets the same protection.
    if (/^\d+(\.\d+)?$/.test(text)) return text;
  } else {
    text = value;
  }
  text = text.replace(/\0/g, ""); // a NUL byte has no business in a spreadsheet
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const line = (cells: readonly CsvValue[]) => cells.map(csvCell).join(",");
  return [line(header), ...rows.map(line)].map((l) => `${l}\r\n`).join("");
}
