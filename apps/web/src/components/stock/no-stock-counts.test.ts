import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutStockCount } from "../../lib/format";

describe("the web never shows how many units a pharmacy has", () => {
  const SRC = new URL("..", import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : f.endsWith(".tsx") && !f.includes(".test.") ? [p] : [];
    });

  it("the stock badge takes no quantity at all, so no caller can show one", () => {
    expect(readFileSync(new URL("./StockBadge.tsx", import.meta.url), "utf8")).not.toMatch(/quantity/);
  });

  it("no public component reads a stock quantity (the pharmacy staff portal, which manages units, is the exception)", () => {
    const offenders = files(SRC).filter((f) => !f.includes("/portal/") && !f.includes("/landing/")).filter((f) => /\bquantity\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("a stored restock message is shown without its unit count", () => {
    expect(withoutStockCount("Crocin 500mg is back in stock at Pharmacy 1 (12 available).")).toBe("Crocin 500mg is back in stock at Pharmacy 1.");
    expect(withoutStockCount("Dolo 650 is back in stock (3 available).")).toBe("Dolo 650 is back in stock.");
    expect(withoutStockCount("Already without a count.")).toBe("Already without a count.");
  });
});
