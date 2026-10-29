import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "../src/csv.js";

/** A small RFC 4180 reader, to check what is written can be read back. */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  return rows;
}

describe("csvCell", () => {
  it("writes plain text and numbers as they are", () => {
    expect(csvCell("Crocin 500mg")).toBe("Crocin 500mg");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(0)).toBe("0");
    expect(csvCell("2026-11-05")).toBe("2026-11-05"); // a date is not a formula even though it contains hyphens
  });

  it("writes nothing for a missing value", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell("")).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("quotes a cell with a comma, a quote or a line break, and doubles the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("line one\r\nline two")).toBe('"line one\r\nline two"');
    expect(csvCell('mixed, "all"\nof it')).toBe('"mixed, ""all""\nof it"');
  });

  it.each(["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", "=HYPERLINK(\"http://x\",\"y\")", "-2+3", "+cmd|' /C calc'!A0"])("defuses %j so a spreadsheet shows it as text", (value) => {
    const out = csvCell(value);
    const unquoted = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
    expect(unquoted.startsWith("'")).toBe(true); // the guarding quote comes first
    expect(unquoted.slice(1)).toBe(value); // and the rest is the value, unchanged
  });

  it("defuses a formula that also needs quoting", () => {
    expect(csvCell("=1,2")).toBe(`"'=1,2"`);
    expect(csvCell('=A1&"x"')).toBe(`"'=A1&""x"""`);
  });

  it("leaves text alone when the dangerous character is not first", () => {
    for (const v of ["a=1", "price - 5", "x@y.com", " =1", "1+1", "note: -3"]) expect(csvCell(v)).toBe(v);
  });

  it("treats a negative or unusual number as text, so it is protected too", () => {
    expect(csvCell(-5)).toBe("'-5");
    expect(csvCell(1e21)).toBe("1e+21");
    expect(csvCell(2.5)).toBe("2.5");
  });

  it("drops NUL bytes and keeps unicode", () => {
    expect(csvCell("a\0b")).toBe("ab");
    expect(csvCell("₹25 – नमस्ते")).toBe("₹25 – नमस्ते");
  });
});

describe("toCsv", () => {
  it("ends every row with CRLF and writes the header first", () => {
    expect(toCsv(["a", "b"], [["1", "2"], ["3", "4"]])).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("is still a valid file, with its header, when there are no rows", () => {
    expect(toCsv(["plan_id", "status"], [])).toBe("plan_id,status\r\n");
    expect(parse(toCsv(["plan_id", "status"], []))).toEqual([["plan_id", "status"]]);
  });

  it("can be read back: every cell survives, apart from the guarding quote on a formula", () => {
    const rows = [
      ["P1", "Crocin, 500mg", 20, 'He said "stop"\nthen left', "=cmd()"],
      ["P2", "", null, "-", "plain"],
    ];
    const back = parse(toCsv(["id", "name", "qty", "notes", "extra"], rows));
    expect(back).toHaveLength(3);
    expect(back[1]).toEqual(["P1", "Crocin, 500mg", "20", 'He said "stop"\nthen left', "'=cmd()"]);
    expect(back[2]).toEqual(["P2", "", "", "'-", "plain"]);
    for (const r of back) expect(r).toHaveLength(5);
  });

  it("is deterministic", () => {
    const rows = [["a,b", 1, "=x"]];
    expect(toCsv(["x", "y", "z"], rows)).toBe(toCsv(["x", "y", "z"], rows));
  });
});
