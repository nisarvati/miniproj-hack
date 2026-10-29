import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * MedLink has one appearance: the light, warm-paper theme. Nothing may switch it, remember a switch, or follow the operating
 * system's dark setting. These scan the source so a dark mode cannot creep back in unnoticed.
 */
const SRC = new URL("..", import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|css)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
const sources = files(SRC);
const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => relative(SRC, p);

describe("there is one theme", () => {
  it("the theme provider, the saved-preference logic and the toggle are gone", () => {
    expect(existsSync(join(SRC, "lib/theme.ts"))).toBe(false);
    expect(existsSync(join(SRC, "components/providers/theme.tsx"))).toBe(false);
    expect(existsSync(join(SRC, "app/dark-theme.test.ts"))).toBe(false);
  });

  it("no source mentions a dark class, a dark variant, the OS dark preference, a saved theme, or a toggle", () => {
    const pattern = /\.dark\b|:global\(\.dark\)|\bdark:|prefers-color-scheme:\s*dark|classList\.(add|toggle)\([^)]*["']dark["']|medlink:theme|ThemeProvider|ThemeToggle|useTheme|SunIcon|MoonIcon|@custom-variant dark/;
    const offenders = sources.filter((f) => pattern.test(read(f)));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("no stylesheet asks the browser for dark rendering (the one dark-designed landing preview, /landing/v4, is its own page)", () => {
    const offenders = sources.filter((f) => /color-scheme:\s*dark/.test(read(f)) && !f.includes("components/landing/v4/"));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("the document says it is light: one theme colour, color-scheme light, no theme script", () => {
    const layout = read(join(SRC, "app/layout.tsx"));
    expect(layout).toMatch(/colorScheme: "light"/);
    expect(layout).toMatch(/themeColor: "#F3F2EE"/);
    expect(layout).not.toMatch(/dangerouslySetInnerHTML|<script|suppressHydrationWarning|prefers-color-scheme/);
    expect(read(join(SRC, "app/globals.css"))).toMatch(/:root \{[^}]*color-scheme: light;/s);
    expect(read(join(SRC, "app/app-theme.css"))).toMatch(/\.app-theme \{[^}]*color-scheme: light;/s);
  });

  it("the app theme is a single block of tokens, with no second set to override it", () => {
    const theme = read(join(SRC, "app/app-theme.css"));
    expect(theme.match(/^\.app-theme \{/gm)).toHaveLength(1);
    expect(theme).not.toMatch(/--app-paper-dark|--app-ink-dark/);
  });
});
