// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Donut, GroupedBars, HBars, LineChart, StackedRows } from "./charts";

afterEach(cleanup);

describe("GroupedBars", () => {
  const props = { label: "Units per day", unit: "units", labels: ["1 Oct", "2 Oct", "3 Oct"], series: [{ name: "Sold", color: "red", values: [4, 0, 9] }, { name: "Restocked", color: "blue", values: [0, 6, 0] }] };
  it("is a labelled image with the same numbers in a table, and a legend that names each series", () => {
    render(<GroupedBars {...props} />);
    expect(screen.getByRole("img", { name: "Units per day" })).toBeTruthy();
    const table = screen.getByRole("table", { name: "Units per day" });
    expect(within(table).getAllByRole("row").map((r) => r.textContent)).toEqual(["Sold (units)Restocked (units)", "1 Oct40", "2 Oct06", "3 Oct90"]);
    expect(screen.getByText("Sold")).toBeTruthy();
    expect(screen.getByText("Restocked")).toBeTruthy();
  });
  it("starts the axis at 0 and ends it at a round number above the data, so bar lengths are honest", () => {
    const { container } = render(<GroupedBars {...props} />);
    const ticks = [...container.querySelectorAll("svg text")].map((t) => t.textContent).filter((t) => /^\d+(\.\d+)?$/.test(t ?? ""));
    expect(ticks).toEqual(["0", "5", "10"]);
    // the tallest bar (9) is taller than the 4, and a zero has no height
    const heights = [...container.querySelectorAll("svg g[tabindex] rect[rx]")].map((r) => Number(r.getAttribute("height")));
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[1]).toBe(0);
    expect(Math.max(...heights)).toBeGreaterThan(heights[0]!);
  });
  it("shows a tooltip with every series when a group is focused, and removes it on blur", () => {
    const { container } = render(<GroupedBars {...props} />);
    const group = container.querySelectorAll("svg g[tabindex]")[2]!;
    fireEvent.focus(group);
    const tip = screen.getByRole("status");
    expect(tip.textContent).toMatch(/3 Oct/);
    expect(tip.textContent).toMatch(/Sold: 9/);
    expect(tip.textContent).toMatch(/Restocked: 0/);
    fireEvent.blur(group);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("describes each group for assistive technology", () => {
    const { container } = render(<GroupedBars {...props} />);
    expect(container.querySelectorAll("svg g[tabindex]")[1]!.getAttribute("aria-label")).toBe("2 Oct: Sold 0, Restocked 6 units");
  });
  it("draws an all-zero chart with a scale instead of breaking", () => {
    const { container } = render(<GroupedBars {...props} series={[{ name: "Sold", color: "red", values: [0, 0, 0] }]} />);
    expect(container.querySelectorAll("svg path[d*='NaN'], svg rect[height='NaN']")).toHaveLength(0);
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
  });
});

describe("LineChart", () => {
  it("breaks the line at an unknown value instead of dropping to zero, and calls it unknown in the tooltip and table", () => {
    const { container } = render(<LineChart label="Waiting" unit="events" labels={["a", "b", "c", "d"]} series={[{ name: "Waiting", color: "red", values: [2, null, 4, 4] }]} />);
    const d = container.querySelector("path")!.getAttribute("d")!;
    expect(d.match(/M/g)).toHaveLength(2); // two separate segments
    expect(within(screen.getByRole("table", { name: "Waiting" })).getAllByRole("row")[2]!.textContent).toBe("bunknown");
    expect(container.querySelectorAll("circle")).toHaveLength(3); // no point is drawn for the unknown reading
  });
  it("reads the nearest point under the pointer", () => {
    const { container } = render(<LineChart label="W" unit="events" labels={["a", "b", "c"]} series={[{ name: "W", color: "red", values: [1, 2, 3] }]} />);
    const svg = container.querySelector("svg")!;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 560, height: 200, right: 560, bottom: 200, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerMove(svg, { clientX: 560 });
    expect(screen.getByRole("status").textContent).toMatch(/c/);
    expect(screen.getByRole("status").textContent).toMatch(/W: 3/);
  });
});

describe("Donut", () => {
  it("lists every segment with its count and share, so nothing depends on colour, and shows the total in the centre", () => {
    render(<Donut label="Stock" centre={{ value: 10, caption: "listings" }} segments={[{ label: "In stock", value: 6, color: "green" }, { label: "Low stock", value: 3, color: "amber" }, { label: "Out of stock", value: 1, color: "red" }]} />);
    expect(screen.getByRole("img", { name: "Stock" })).toBeTruthy();
    expect(screen.getByText("In stock").closest("li")!.textContent).toBe("In stock6 · 60%");
    expect(screen.getByText("Out of stock").closest("li")!.textContent).toBe("Out of stock1 · 10%");
    expect(screen.getByText("listings")).toBeTruthy();
  });
  it("shows an empty ring and no percentages when the total is zero, and never NaN", () => {
    const { container } = render(<Donut label="Plans" centre={{ value: 0, caption: "open" }} segments={[{ label: "Planned", value: 0, color: "x" }]} />);
    expect(container.textContent).not.toMatch(/NaN|%/);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });
});

describe("HBars and StackedRows", () => {
  it("HBars scales bars from 0 against a round maximum and shows a display text when given", () => {
    const { container } = render(<HBars label="Top" unit="units" rows={[{ label: "Crocin", value: 8 }, { label: "Dolo", value: 2, display: "two" }]} />);
    const widths = [...container.querySelectorAll("li [style*='width']")].map((e) => (e as HTMLElement).style.width);
    expect(widths).toEqual(["80%", "20%"]);
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
  });
  it("HBars shows the empty message for no rows", () => {
    render(<HBars label="Top" unit="units" rows={[]} empty={<p>Nothing sold.</p>} />);
    expect(screen.getByText("Nothing sold.")).toBeTruthy();
  });
  it("StackedRows sizes parts by share of each row's total, and spells the numbers out", () => {
    const { container } = render(<StackedRows label="Stock" parts={[{ label: "In", color: "g" }, { label: "Out", color: "r" }]} rows={[{ label: "P001", values: [3, 1] }, { label: "P002", values: [0, 0] }]} />);
    expect(screen.getByText("3 in · 1 out")).toBeTruthy();
    expect([...container.querySelectorAll("[aria-hidden] > div")].map((d) => (d as HTMLElement).style.width)).toEqual(["75%", "25%"]);
  });
});
