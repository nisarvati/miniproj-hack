import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "app-theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every top-level rule: its selectors and its declarations. (The file has no at-rules.) */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.trim()),
  body: m[2]!,
}));

describe("app theme stylesheet", () => {
  it("only styles inside .app-theme, so the homepage and the landing previews cannot be affected", () => {
    expect(rules.length).toBeGreaterThan(5);
    for (const { selectors } of rules) {
      for (const sel of selectors) {
        const scoped = /^\.app-theme(?![\w-])/.test(sel) || /^html:has\(\.app-theme\)$/.test(sel);
        expect(scoped || sel === ":root", `selector "${sel}"`).toBe(true);
      }
    }
  });

  it("adds only its own variables to :root, and does not redefine the shared tokens globally", () => {
    const root = rules.filter((r) => r.selectors.includes(":root"));
    expect(root).toHaveLength(1);
    const names = [...root[0]!.body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name, name).toMatch(/^--(app-|paper-)/);
  });

  it("re-points the status tokens, so every state keeps a colour", () => {
    for (const scope of [".app-theme"]) {
      const body = rules.find((r) => r.selectors.includes(scope))!.body;
      for (const token of ["--ok", "--warn", "--bad", "--brand", "--surface", "--ink", "--muted", "--line", "--focus"]) {
        expect(body, `${scope} ${token}`).toMatch(new RegExp(`${token}\\s*:`));
      }
    }
  });
});
