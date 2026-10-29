import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The card system is defined once, in app-theme.css (tokens and `.mx-card` rules) and globals.css (keyframes). These pin down what it
 * promises: restrained glass, blur only on overlays, short motion with one easing, reduced motion honoured, neutral shadows, and no
 * hand-rolled copies of the card look elsewhere.
 */
const SRC = new URL("..", import.meta.url).pathname;
const theme = readFileSync(join(SRC, "app/app-theme.css"), "utf8");
const globals = readFileSync(join(SRC, "app/globals.css"), "utf8");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
const tsx = files(join(SRC, "components")).filter((f) => f.endsWith(".tsx") && !f.includes("components/landing/"));

const layer = theme.slice(theme.indexOf("@layer components {"));
const rule = (selector: string) => layer.match(new RegExp(`${selector.replace(/[.[\]()]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
const token = (name: string) => theme.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();

describe("the card tokens", () => {
  it("define surface, border, blur, shadow, radius and motion once", () => {
    for (const name of ["card-bg", "card-bg-dense", "card-bg-overlay", "card-border", "card-border-hover", "card-border-selected", "card-edge", "card-radius", "card-blur", "card-shadow", "card-shadow-hover", "card-lift", "card-dur", "card-ease"]) {
      expect(token(name), `--${name}`).toBeTruthy();
    }
  });

  it("are restrained: modest blur, a short duration, a small lift, one easing", () => {
    expect(Number.parseInt(token("card-blur")!)).toBeLessThanOrEqual(12);
    const ms = Number.parseInt(token("card-dur")!);
    expect(ms).toBeGreaterThanOrEqual(150);
    expect(ms).toBeLessThanOrEqual(220);
    expect(Math.abs(Number.parseInt(token("card-lift")!))).toBeLessThanOrEqual(3);
    expect(token("card-ease")).toMatch(/^cubic-bezier\(/);
  });

  it("shadows are neutral ink at low opacity: no colour, no glow", () => {
    for (const name of ["card-shadow", "card-shadow-hover"]) {
      const colours = [...token(name)!.matchAll(/rgb\(([^)]*)\)/g)].map((m) => m[1]);
      expect(colours.length).toBeGreaterThan(0);
      for (const c of colours) expect(c, `${name}: ${c}`).toMatch(/^26 28 23 \/ 0\.(0\d|1)\d*$/);
    }
  });
});

describe("rounded edges", () => {
  it("cards have a generous radius, nested panels a smaller one, both from tokens", () => {
    expect(Number.parseInt(token("card-radius")!)).toBeGreaterThanOrEqual(12);
    expect(Number.parseInt(token("card-radius-sm")!)).toBeGreaterThanOrEqual(8);
    expect(Number.parseInt(token("card-radius-sm")!)).toBeLessThan(Number.parseInt(token("card-radius")!));
    expect(layer).toMatch(/\.app-theme \.mx-card \{[^}]*border-radius: var\(--card-radius\)/);
  });

  it("nothing flattens a card back to square corners: no ruled-list overrides, and the dialog, map and calendar use the tokens", () => {
    const read = (p: string) => readFileSync(join(SRC, p), "utf8");
    expect(globals).not.toMatch(/\.directory-row|\.pharmacy-directory/);
    expect(read("components/pharmacies/PharmaciesPage.tsx")).toMatch(/<Card interactive/);
    expect(read("components/calendar/Modal.tsx")).toMatch(/rounded-t-\[var\(--card-radius\)\][^"]*sm:rounded-\[var\(--card-radius\)\]/);
    expect(read("components/search/ResultsMap.tsx")).toMatch(/rounded-\[var\(--card-radius\)\]/);
    const cal = read("components/calendar/calendar.module.css");
    expect(cal).toMatch(/\.grid \{[^}]*border-radius: var\(--card-radius\)/s);
    expect(cal).toMatch(/\.row \{[^}]*border-radius: var\(--card-radius-sm\)/s);
  });
});

describe("the card rules", () => {
  it("live in the components layer, so a utility on one card still wins", () => {
    expect(theme).toMatch(/@layer components \{\s*\.app-theme \.mx-card \{/);
  });

  it("only overlays blur what is behind them, only where the browser can, and the fallback is near-opaque", () => {
    expect(rule(".app-theme .mx-card")).not.toMatch(/backdrop-filter/);
    expect(rule(".app-theme .mx-card--solid")).not.toMatch(/backdrop-filter/);
    expect(rule(".app-theme .mx-card--interactive:hover")).not.toMatch(/backdrop-filter/);
    const supported = theme.match(/@supports \(\(backdrop-filter: blur\(1px\)\)[^{]*\{\s*\.app-theme \.mx-card--overlay \{([^}]*)\}/)?.[1] ?? "";
    expect(supported).toMatch(/backdrop-filter: blur\(var\(--card-blur\)\)/);
    expect(supported).toMatch(/-webkit-backdrop-filter/);
    // without that support (or without color-mix) the overlay and the base card are opaque-ish solid surfaces
    expect(rule(".app-theme .mx-card")).toMatch(/background-color: var\(--surface\)/);
    expect(theme).toMatch(/@supports \(color: color-mix\(in srgb, red, blue\)\) \{[^}]*--card-bg\)[^]*?--card-bg-dense\)/);
  });

  it("the page behind a dialog is frosted: a light veil with a modest blur where supported, a darker plain veil where not", () => {
    expect(token("scrim-blur")).toMatch(/^\d+px$/);
    expect(Number.parseInt(token("scrim-blur")!)).toBeLessThanOrEqual(4); // light: the page behind stays recognisable
    expect(Number.parseInt(token("scrim-blur")!)).toBeLessThan(Number.parseInt(token("card-blur")!)); // the panel is the frosted layer
    expect(layer).toMatch(/\.app-theme \.mx-scrim \{ background-color: rgb\(26 28 23 \/ 0\.45\); \}/); // fallback
    const supported = layer.match(/@supports \(\(backdrop-filter: blur\(1px\)\)[^{]*\{\s*\.app-theme \.mx-scrim \{([^}]*)\}/)?.[1] ?? "";
    expect(supported).toMatch(/backdrop-filter: blur\(var\(--scrim-blur\)\)/);
    expect(supported).toMatch(/-webkit-backdrop-filter/);
    expect(supported).toMatch(/rgb\(26 28 23 \/ 0\.[0-2]\d*\)/); // lighter than the fallback, because the blur does the separating
    expect(readFileSync(join(SRC, "components/calendar/Modal.tsx"), "utf8")).toMatch(/className="mx-scrim fixed inset-0/);
  });

  it("hover feedback is a transform and a rule/shadow change, only where hover exists", () => {
    expect(layer).toMatch(/@media \(hover: hover\) \{\s*\.app-theme \.mx-card--interactive:hover \{[^}]*transform: translateY\(var\(--card-lift\)\)/);
    expect(rule(".app-theme .mx-card")).toMatch(/transition:[^;]*var\(--card-dur\) var\(--card-ease\)/);
    expect(rule(".app-theme .mx-card")).not.toMatch(/transition:\s*all/);
  });

  it("the selected state is a solid rule, not a glow", () => {
    const selected = layer.match(/\.mx-card--selected,[^{]*\{([^}]*)\}/)?.[1] ?? "";
    expect(selected).toMatch(/border-color: var\(--card-border-selected\)/);
    expect(selected).toMatch(/0 0 0 1px var\(--card-border-selected\)/);
    expect(selected).not.toMatch(/0 0 [2-9]px|0 0 \d{2}px/);
  });

  it("honours reduced motion: no transitions, no lift, no entrance animation", () => {
    const block = layer.slice(layer.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.mx-card \{ transition: none; \}/);
    expect(block).toMatch(/\.mx-card--interactive:hover \{ transform: none; \}/);
    expect(block).toMatch(/\.mx-enter \{ animation: none; \}/);
  });

  it("entrance animations never leave the element transformed (backwards fill), so hover still works afterwards", () => {
    expect(layer).toMatch(/\.mx-enter \{ animation: mx-fade-in var\(--card-dur\) var\(--card-ease\) backwards; \}/);
    expect(layer).not.toMatch(/animation:[^;]*(both|forwards)/);
  });

  it("the keyframes exist, are small and only fade and nudge", () => {
    for (const name of ["mx-fade-in", "mx-scrim-in", "mx-scrim-out", "mx-panel-in", "mx-panel-out"]) expect(globals, name).toMatch(new RegExp(`@keyframes ${name}`));
    expect(globals).not.toMatch(/@keyframes mx-[\s\S]*?(rotate|skew|perspective|bounce)/);
    expect(globals.match(/@keyframes mx-[\s\S]*?\n\}\n/g)!.join("")).not.toMatch(/translate[XY]?\((-?\d{2,}|[3-9]\d)px/);
  });
});

describe("one card look", () => {
  it("no component draws its own copy of the card surface (a bordered, rounded, paper-coloured box) when the shared card exists", () => {
    const copy = /rounded-(xl|2xl)[^"`]*\bborder\b[^"`]*\bbg-surface\b[^"`]*\bshadow-(card|pop)\b|\bborder border-line bg-surface\b[^"`]*\bshadow-(card|pop)\b|bg-surface[^"`]*\bshadow-(card|pop)\b[^"`]*\brounded-(xl|2xl)/;
    const offenders = tsx.filter((f) => copy.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("the main cards use the system: results, dialogs, popovers, portal and account panels", () => {
    const read = (p: string) => readFileSync(join(SRC, p), "utf8");
    expect(read("components/search/ResultCard.tsx")).toMatch(/<Card interactive[^>]*mx-enter/);
    expect(read("components/calendar/Modal.tsx")).toMatch(/mx-card mx-card--overlay/);
    expect(read("components/shell/LocationMenu.tsx")).toMatch(/mx-card mx-card--overlay/);
    expect(read("components/search/SearchForm.tsx")).toMatch(/mx-card mx-card--overlay/);
    expect(read("components/auth/AccountPage.tsx")).toMatch(/<Card variant="solid"/);
    expect(read("components/portal/PortalPage.tsx")).toMatch(/<Card variant="solid"/);
    expect(read("components/search/SubstitutesPanel.tsx")).toMatch(/mx-card mx-card--interactive/);
    expect(read("components/calendar/calendar.module.css")).toMatch(/\.chip \{[^}]*box-shadow: inset 0 1px 0 var\(--card-edge\)/s);
  });
});
