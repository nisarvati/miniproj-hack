import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Layout is CSS, which jsdom does not run, so these pin the rules the layout depends on. They are the contract that was checked in a real
 * browser (see docs/medicine-calendar.md); if one of them has to change, look at the page in a browser at phone, tablet and desktop sizes again.
 */
const css = readFileSync(new URL("./calendar.module.css", import.meta.url), "utf8");
const block = (query: string) => {
  const start = css.indexOf(`@media ${query}`);
  expect(start, query).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unterminated ${query}`);
};

describe("the calendar workspace stylesheet", () => {
  it("fills the window under the shared header on tablets and desktops tall enough for it, and scrolls naturally otherwise", () => {
    const theme = readFileSync(new URL("../../app/app-theme.css", import.meta.url), "utf8");
    // the page (header + calendar) is exactly the window...
    const fixed = theme.slice(theme.indexOf("@media (min-width: 48rem) and (min-height: 34rem) {\n  .app-theme.app-shell-fill"));
    expect(fixed.slice(0, 220)).toMatch(/height: 100dvh/);
    expect(fixed.slice(0, 220)).toMatch(/overflow: hidden/);
    expect(theme).toMatch(/\.app-theme\.app-shell-fill \{[^}]*display: flex;[^}]*min-height: 100dvh;[^}]*flex-direction: column;/s);
    // ...and a phone keeps room for the tab bar and scrolls
    expect(theme).toMatch(/max-width: 47\.99rem\) \{\s*\.app-theme\.app-shell-fill \{ padding-bottom: calc\(4rem/);
    // the calendar takes what the header leaves, and has no fixed height of its own
    expect(css.match(/\.frame \{([^}]*)\}/)![1]).toMatch(/flex: 1;/);
    expect(css.match(/\.frame \{([^}]*)\}/)![1]).toMatch(/min-height: 0;/);
    expect(block("(min-width: 48rem) and (min-height: 34rem)")).toMatch(/\.frame \{ overflow: hidden; \}/);
    expect(css).not.toMatch(/(?<![-\w])height: 100d?vh/);
  });

  it("has no sidebar, panel or menu: the page is a header, a toolbar and the month", () => {
    expect(css).not.toMatch(/\.(sidebar|panel|topbar|open)\b/);
    expect(css).not.toMatch(/grid-template-columns: 4\.5rem|14\.5rem/);
    expect(css).not.toMatch(/\.header\b/); // the header is the shared one, not the calendar's own
    expect(css).toMatch(/\.toolbar \{/);
  });

  it("lets the month grid shrink and share the height: six equal rows, min-height 0 along the way", () => {
    expect(css).toMatch(/repeat\(6, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.workspace \{[^}]*min-height: 0/);
    expect(css).toMatch(/\.grid \{[^}]*min-height: 0/);
    expect(css).toMatch(/\.cell \{[^}]*min-width: 0/);
    expect(css).toMatch(/repeat\(7, minmax\(0, 1fr\)\)/); // seven day columns that cannot be pushed wider by a long medicine name
  });

  it("swaps entry chips for a count when the calendar column is narrow", () => {
    expect(css).toMatch(/@container \(max-width: 38rem\)[^}]*\{[^}]*\.chips \{ display: none/s);
    expect(css).toMatch(/container-type: inline-size/);
  });

  it("stops its transitions for people who ask for reduced motion, and uses only the theme's tokens for colour", () => {
    expect(block("(prefers-reduced-motion: reduce)")).toMatch(/transition: none/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });
});

describe("no pure white in the calendar", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  const sources = ["./CalendarPage.tsx", "./DayPanel.tsx", "./EntryForm.tsx", "./Modal.tsx", "./MonthGrid.tsx", "./entry-visuals.tsx", "./calendar.module.css"];
  const WHITE = /bg-white|bg-\[#f{3,6}\]|background(-color)?:\s*(#f{3,6}|white|rgb\(255)|\bbg-\[white\]|--(surface|canvas|fill):\s*(#f{3,6}|white)\b/i;

  it("none of the calendar's own files sets a white background", () => {
    for (const f of sources) expect(read(f), f).not.toMatch(WHITE);
  });

  it("the app theme the calendar lives in defines paper, not white, for every surface it uses", () => {
    const theme = read("../../app/app-theme.css");
    const block = (selector: string) => theme.slice(theme.indexOf(selector), theme.indexOf("}", theme.indexOf(selector)));
    for (const selector of [".app-theme {"]) {
      const rules = block(selector);
      for (const token of ["canvas", "surface", "surface-2", "control-hover", "brand-soft"]) {
        const value = rules.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1]?.trim();
        expect(value, `${selector} --${token}`).toBeTruthy();
        expect(value, `${selector} --${token}`).not.toMatch(/^(#f{3}|#f{6}|white)$/i);
      }
    }
  });

  it("dropdown lists are themed too, not left to the browser's white", () => {
    expect(read("../../app/app-theme.css")).toMatch(/\.app-theme option[^}]*background-color: var\(--surface\)/s);
  });
});
