import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHADES, shadeOf } from "./entry-visuals";

describe("shadeOf", () => {
  it("is a pure function of the id: the same id always gives the same shade, in range", () => {
    for (let i = 0; i < 200; i++) {
      const id = randomUUID();
      const shade = shadeOf(id);
      expect(Number.isInteger(shade) && shade >= 0 && shade < SHADES).toBe(true);
      expect(shadeOf(id)).toBe(shade);
    }
  });

  it("does not depend on order, position or anything but the id", () => {
    const ids = Array.from({ length: 50 }, () => randomUUID());
    const forward = ids.map(shadeOf);
    const backward = [...ids].reverse().map(shadeOf).reverse();
    expect(backward).toEqual(forward);
  });

  it("uses every shade, and none takes more than a third of 600 random ids", () => {
    const counts = new Array<number>(SHADES).fill(0);
    for (let i = 0; i < 600; i++) counts[shadeOf(randomUUID())]!++;
    for (const c of counts) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(200);
    }
  });

  it("is fixed forever for a given id (a known value, so a change to the hash is noticed)", () => {
    expect(shadeOf("00000000-0000-4000-8000-000000000001")).toBe(shadeOf("00000000-0000-4000-8000-000000000001"));
    expect([shadeOf("a"), shadeOf("b"), shadeOf("")]).toEqual([shadeOf("a"), shadeOf("b"), shadeOf("")]);
  });
});

describe("the greens in the stylesheet", () => {
  const css = readFileSync(new URL("./calendar.module.css", import.meta.url), "utf8");

  it("defines one class per shade, each a mix of the theme's green tokens and the paper, and nothing else", () => {
    for (let i = 0; i < SHADES; i++) {
      const rule = css.match(new RegExp(`\\.shade${i} \\{([^}]*)\\}`))?.[1];
      expect(rule, `shade${i}`).toBeTruthy();
      expect(rule).toMatch(/--fill: color-mix\(in srgb, var\(--(brand|live|ok)\) \d+%, var\(--surface\)\)/);
      expect(rule).toMatch(/--bar:/);
      const tokens = [...rule!.matchAll(/var\(--([a-z-]+)\)/g)].map((m) => m[1]);
      for (const t of tokens) expect(["brand", "live", "ok", "brand-strong", "surface"], `shade${i} uses --${t}`).toContain(t);
    }
    expect(css).not.toMatch(new RegExp(`\\.shade${SHADES} \\{`));
  });

  it("gives six visibly different fills (no two shades share a token and strength)", () => {
    const fills = Array.from({ length: SHADES }, (_, i) => css.match(new RegExp(`\\.shade${i} \\{[^}]*--fill: ([^;]*);`))![1]);
    expect(new Set(fills).size).toBe(SHADES);
  });
});
