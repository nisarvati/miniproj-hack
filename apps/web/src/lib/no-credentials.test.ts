import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("..", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });

describe("the web app never handles mail credentials", () => {
  it("mentions no SMTP setting, mail library or app password anywhere in its source", () => {
    const offenders = files(SRC).filter((f) => /SMTP_|nodemailer|EMAIL_FROM|EMAIL_DELIVERY|app password/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("only ever sends the address and the medicine when asking for a restock alert", () => {
    const api = readFileSync(join(SRC, "lib/api.ts"), "utf8");
    expect(api).toContain("JSON.stringify({ email, medicineId })");
  });
});
