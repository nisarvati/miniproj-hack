// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchFilters } from "../../lib/api";
import type { View } from "../../lib/search-state";
import { FilterBar } from "./FilterBar";

afterEach(cleanup);
const setup = (filters: SearchFilters = {}, view: View = "list") => {
  const onFilters = vi.fn();
  const onView = vi.fn();
  render(<FilterBar filters={filters} view={view} onFilters={onFilters} onView={onView} />);
  return { onFilters, onView };
};

describe("FilterBar", () => {
  it("toggles 'In stock only' on and off, announcing the state", async () => {
    const off = setup();
    const chip = screen.getByRole("button", { name: /in stock only/i });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(chip);
    expect(off.onFilters).toHaveBeenCalledWith({ inStock: true });
    cleanup();

    const on = setup({ inStock: true });
    expect(screen.getByRole("button", { name: /in stock only/i }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: /in stock only/i }));
    expect(on.onFilters).toHaveBeenCalledWith({ inStock: undefined });
  });

  it("sets and clears the distance and price limits", async () => {
    const { onFilters } = setup({ sort: "price" });
    await userEvent.selectOptions(screen.getByLabelText("Maximum distance"), "5");
    expect(onFilters).toHaveBeenLastCalledWith({ sort: "price", maxDistanceKm: 5 });
    await userEvent.selectOptions(screen.getByLabelText("Maximum price"), "100");
    expect(onFilters).toHaveBeenLastCalledWith({ sort: "price", maxPrice: 100 });
    cleanup();

    const withLimit = setup({ maxDistanceKm: 5 });
    await userEvent.selectOptions(screen.getByLabelText("Maximum distance"), "");
    expect(withLimit.onFilters).toHaveBeenLastCalledWith({ maxDistanceKm: undefined });
  });

  it("changes the sort", async () => {
    const { onFilters } = setup({ inStock: true });
    await userEvent.selectOptions(screen.getByLabelText("Sort by"), "distance");
    expect(onFilters).toHaveBeenCalledWith({ inStock: true, sort: "distance" });
  });

  it("'Clear filters' appears only when a filter is on, counts them, and keeps the sort", async () => {
    setup({ sort: "price" });
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
    cleanup();

    const { onFilters } = setup({ inStock: true, maxPrice: 50, sort: "distance" });
    const clear = screen.getByRole("button", { name: /clear filters \(2\)/i });
    await userEvent.click(clear);
    expect(onFilters).toHaveBeenCalledWith({ sort: "distance" });
  });

  it("switches between list and map", async () => {
    const { onView } = setup({}, "list");
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(onView).toHaveBeenCalledWith("map");
  });
});
