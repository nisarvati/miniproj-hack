import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { dosagePattern, escapeLike, parseMedicineQuery } from "../src/modules/medicines/query.js";

describe("parseMedicineQuery", () => {
  it("splits name and dosage", () => {
    expect(parseMedicineQuery("Crocin 500mg")).toEqual({ terms: ["crocin"], dosages: ["500mg"] });
  });
  it("normalises case, whitespace and '500 mg'", () => {
    expect(parseMedicineQuery("  CROCIN   500 mg ")).toEqual({ terms: ["crocin"], dosages: ["500mg"] });
  });
  it("accepts name only, dosage only, and bare numbers", () => {
    expect(parseMedicineQuery("paracetamol")).toEqual({ terms: ["paracetamol"], dosages: [] });
    expect(parseMedicineQuery("650mg")).toEqual({ terms: [], dosages: ["650mg"] });
    expect(parseMedicineQuery("dolo 650")).toEqual({ terms: ["dolo"], dosages: ["650"] });
  });
  it("keeps compound dosages together", () => {
    expect(parseMedicineQuery("combiflam 400mg/325mg").dosages).toEqual(["400mg/325mg"]);
  });
  it("rejects empty and over-long queries", () => {
    expect(() => parseMedicineQuery("   ")).toThrow(AppError);
    expect(() => parseMedicineQuery("a b c d e f")).toThrow(AppError);
  });
});

describe("escapeLike", () => {
  it("neutralises wildcards", () => {
    expect(escapeLike("50%_\\")).toBe("50\\%\\_\\\\");
  });
});

describe("dosagePattern", () => {
  const matches = (dosage: string, stored: string) => new RegExp(dosagePattern(dosage)).test(stored);
  it("matches whole dosage values only", () => {
    expect(matches("500mg", "500mg")).toBe(true);
    expect(matches("50mg", "250mg")).toBe(false);
    expect(matches("50mg", "500mg")).toBe(false);
    expect(matches("500mg", "500mg/125mg")).toBe(true);
    expect(matches("125mg", "500mg/125mg")).toBe(true);
  });
  it("lets a bare number match any unit", () => {
    expect(matches("650", "650mg")).toBe(true);
    expect(matches("65", "650mg")).toBe(false);
  });
});
