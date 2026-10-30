// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodeStatusEntry } from "../../lib/api";
import { GroupedBars, LineChart } from "./charts";
import { NodeGlance } from "./NodeGlance";
import { Panel, Section } from "./Panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const here = fileURLToPath(import.meta.url);
const theme = readFileSync(resolve(here, "../../../app/app-theme.css"), "utf8");
const rect = (width: number, height: number) => ({ width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} }) as DOMRect;

/** Gives every element a size, and lets a test resize it and tell the observers. */
function fakeLayout(initial: { w: number; h: number }) {
  const size = { ...initial };
  const observers: (() => void)[] = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(size.w, size.h));
  vi.stubGlobal("ResizeObserver", class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} });
  return { resize: (w: number, h: number) => { size.w = w; size.h = h; act(() => observers.forEach((o) => o())); } };
}

describe("one-screen sections (the rules)", () => {
  const rules = theme.slice(theme.indexOf(".dash-main {"));
  it("gives the stage the height left under the dashboard header, and scrolls only the stage, with sections snapping into place", () => {
    expect(rules).toMatch(/@media \(min-width: 48rem\) and \(min-height: 34rem\) \{[^]*?\.dash-stage \{ overflow-y: auto; scroll-snap-type: y proximity; overscroll-behavior: contain;/);
    expect(rules).toMatch(/\.dash-app \{ flex: 1 1 auto; min-height: 0; \}/);
  });
  it("makes each section one screen high, never lower than its content needs", () => {
    expect(rules).toMatch(/\.dash-section \{ height: 100%; min-height: min-content; scroll-snap-align: start;/);
  });
  it("cannot be scrolled by following a link: the shell is clipped, not a scroll container", () => {
    expect(rules).toMatch(/\.dash-main \{ overflow: hidden; overflow: clip; \}/);
  });
  it("keeps the shell's size from the window below the header, never a guessed 100vh", () => {
    const dash = rules.slice(0, rules.indexOf("A short or narrow window"));
    expect(dash).not.toMatch(/100vh|calc\(100/);
  });
  it("tightens for a short or a narrow window without hiding anything: intros stay for screen readers, descriptions are cut to a line", () => {
    const compact = rules.slice(rules.indexOf("@media (min-width: 48rem) and (max-height: 820px)"));
    expect(compact).toMatch(/max-height: 820px\), \(min-width: 48rem\) and \(max-width: 63\.99rem\)/);
    expect(compact).toMatch(/\.dash-intro \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect/);
    expect(compact).toMatch(/\.dash-desc \{[^}]*-webkit-line-clamp: 1/);
    expect(compact).not.toMatch(/display: none/);
  });
  it("leaves the card entrance animation as it was: 8 px, 520 ms, and none for reduced motion", () => {
    expect(theme).toMatch(/\.dash-drop\[data-drop="pending"\] \{ opacity: 0; transform: translateY\(-8px\); \}/);
    expect(theme).toMatch(/animation: mx-drop 520ms/);
    expect(theme).toMatch(/\.dash-drop\[data-drop="in"\] \{ animation: none; \}/);
  });
});

describe("charts use the room they are given", () => {
  const props = { label: "Per day", unit: "units", labels: ["a", "b", "c"], series: [{ name: "Sold", color: "red", values: [1, 2, 3] }] };
  it("draws at the size of its container, and again when the container changes size", () => {
    const layout = fakeLayout({ w: 700, h: 300 });
    const { container } = render(<GroupedBars {...props} fill />);
    const svg = container.querySelector("svg")!;
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["700", "300"]);
    expect(svg.getAttribute("viewBox")).toBe("0 0 700 300");
    layout.resize(420, 180);
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["420", "180"]);
    expect(svg.getAttribute("viewBox")).toBe("0 0 420 180");
  });
  it("takes the container's width but its own fixed height when not asked to fill, so a phone's chart is a readable size", () => {
    fakeLayout({ w: 320, h: 999 });
    const { container } = render(<GroupedBars {...props} height={190} />);
    const svg = container.querySelector("svg")!;
    expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["320", "190"]);
  });
  it("lays the bars out across whatever width it has, and keeps them inside it", () => {
    fakeLayout({ w: 300, h: 200 });
    const { container } = render(<GroupedBars {...props} fill />);
    for (const r of container.querySelectorAll("svg g[tabindex] rect[rx]")) {
      const x = Number(r.getAttribute("x")), w = Number(r.getAttribute("width"));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(300);
    }
  });
  it("sets its own size on the drawing area, not the card's, so the chart never pushes its card taller", () => {
    fakeLayout({ w: 500, h: 200 });
    const { container } = render(<GroupedBars {...props} fill />);
    expect(container.querySelector("svg")!.getAttribute("class")).toMatch(/absolute/);
    expect(container.querySelector("[data-chart]")!.className).toMatch(/flex-1/);
  });
  it("keeps its hidden data table inside a clipped wrapper, so its rows add no scrollable height", () => {
    const { container } = render(<LineChart label="L" unit="u" labels={["a", "b"]} series={[{ name: "S", color: "red", values: [1, 2] }]} />);
    const table = container.querySelector("table")!;
    expect(table.className).toBe("");
    expect(table.parentElement!.className).toMatch(/sr-only/);
  });
});

describe("tooltips stay inside their chart", () => {
  it("shows to the right of the point when there is room, and to the left when not, never outside the chart", () => {
    fakeLayout({ w: 400, h: 200 });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(120);
    const { container } = render(<GroupedBars label="x" unit="u" labels={["a", "b", "c", "d"]} series={[{ name: "S", color: "red", values: [1, 2, 3, 4] }]} fill />);
    const groups = container.querySelectorAll("svg g[tabindex]");
    const tipLeft = () => Number.parseFloat((screen.getByRole("status").closest("div[style]") as HTMLElement).style.left);
    fireEvent.focus(groups[0]!);
    expect(tipLeft()).toBeGreaterThanOrEqual(0);
    expect(tipLeft() + 120).toBeLessThanOrEqual(400);
    fireEvent.focus(groups[3]!);
    expect(tipLeft()).toBeGreaterThanOrEqual(0);
    expect(tipLeft() + 120).toBeLessThanOrEqual(400);
  });
});

describe("Section and Panel", () => {
  it("gives a section a heading and a body that takes the rest of the height, and keeps its intro for screen readers when space is short", () => {
    render(<Section id="x" title="Title" intro="What it is."><p>body</p></Section>);
    const section = screen.getByRole("region", { name: "Title" });
    expect(section.className).toMatch(/dash-section/);
    expect(within(section).getByText("What it is.").className).toMatch(/dash-intro/);
    expect(within(section).getByText("body").parentElement!.className).toMatch(/flex-1/);
  });
  it("lets its action wrap on a small screen instead of widening the page", () => {
    render(<Section id="x" title="T" intro="i" action={<span>picker</span>}><p>b</p></Section>);
    const wrap = screen.getByText("picker").parentElement!;
    expect(wrap.className).toMatch(/min-w-0/);
    expect(wrap.className).toMatch(/max-w-full/);
    expect(wrap.className).not.toMatch(/(^| )shrink-0/);
    expect(wrap.className).toMatch(/lg:shrink-0/);
  });
  it("keeps a panel's full description as its tooltip when the line is cut", () => {
    render(<Panel title="P" description="A long description that may be cut to one line.">x</Panel>);
    const d = screen.getByText("A long description that may be cut to one line.");
    expect(d.className).toMatch(/dash-desc/);
    expect(d.getAttribute("title")).toBe("A long description that may be cut to one line.");
  });
});

describe("NodeGlance", () => {
  const node = (over: Partial<NodeStatusEntry>): NodeStatusEntry => ({ pharmacyCode: "P001", name: "Alpha Chemist", status: "healthy", statusReason: "", lastSyncedAt: "2026-10-29T11:59:00.000Z", syncLagMs: 60_000, unpublishedOutbox: 0, staleCount: 0, duplicateCount: 0, processedCount: 5, ...over });
  const NOW = new Date("2026-10-29T12:00:00.000Z");
  it("lists every node with its health as a word, its last event and what is waiting, naming the pharmacy by code with the name as its tooltip", () => {
    render(<NodeGlance now={NOW} nodes={[node({}), node({ pharmacyCode: "P002", name: "Beta Chemist", status: "degraded", unpublishedOutbox: 4, syncLagMs: 90_000 })]} />);
    const table = screen.getByRole("table", { name: "Health of each pharmacy node" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("rowheader").getAttribute("title")).toBe("Alpha Chemist");
    expect(within(rows[0]!).getByText("Healthy")).toBeTruthy();
    expect(within(rows[1]!).getByText("Degraded")).toBeTruthy();
    expect(within(rows[1]!).getByText("4")).toBeTruthy();
    expect(within(rows[1]!).getByText("2 min")).toBeTruthy();
  });
  it("says unknown and not available, and never shows zero for what was not read", () => {
    render(<NodeGlance now={NOW} nodes={[node({ status: "unknown", lastSyncedAt: null, syncLagMs: null, unpublishedOutbox: null })]} />);
    const row = within(screen.getByRole("table")).getAllByRole("row")[1]!;
    expect(within(row).getByText("Unknown", { selector: "span.inline-flex" })).toBeTruthy();
    expect(within(row).getByText("Never / unknown")).toBeTruthy();
    expect(within(row).getByText("Not available")).toBeTruthy();
    expect(within(row).queryByText("0")).toBeNull();
  });
});
