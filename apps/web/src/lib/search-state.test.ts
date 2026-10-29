import { describe, expect, it } from "vitest";
import { activeFilterCount, parseSearchParams, toSearchParams } from "./search-state";

const parse = (qs: string) => parseSearchParams(new URLSearchParams(qs));

describe("parseSearchParams", () => {
  it("reads the query, filters, sort and view", () => {
    expect(parse("q=Crocin+500mg&stock=1&dist=5&price=50&sort=price&view=map")).toEqual({
      q: "Crocin 500mg",
      filters: { inStock: true, maxDistanceKm: 5, maxPrice: 50, sort: "price" },
      view: "map",
    });
  });

  it("defaults to an empty list view when there is nothing in the URL", () => {
    expect(parse("")).toEqual({ q: "", filters: { inStock: undefined, maxDistanceKm: undefined, maxPrice: undefined, sort: undefined }, view: "list" });
  });

  it("ignores values that make no sense instead of failing", () => {
    const s = parse("stock=yes&dist=-3&price=abc&sort=cheapest&view=3d&q=%20%20x%20");
    expect(s.filters).toEqual({ inStock: undefined, maxDistanceKm: undefined, maxPrice: undefined, sort: undefined });
    expect(s.view).toBe("list");
    expect(s.q).toBe("x");
  });

  it("caps an absurdly long query", () => {
    expect(parse(`q=${"a".repeat(500)}`).q).toHaveLength(100);
  });
});

describe("toSearchParams", () => {
  it("only writes what differs from the defaults", () => {
    expect(toSearchParams({ q: "croc", filters: {}, view: "list" }).toString()).toBe("q=croc");
    expect(toSearchParams({ q: "croc", filters: { sort: "best" }, view: "list" }).toString()).toBe("q=croc");
    expect(toSearchParams({ q: "", filters: {}, view: "list" }).toString()).toBe("");
  });

  it("round-trips", () => {
    const state = { q: "Paracetamol", filters: { inStock: true, maxDistanceKm: 2, maxPrice: 100, sort: "distance" as const }, view: "map" as const };
    expect(parseSearchParams(toSearchParams(state))).toEqual(state);
  });
});

describe("activeFilterCount", () => {
  it("counts filters but not the sort", () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ sort: "price" })).toBe(0);
    expect(activeFilterCount({ inStock: true, maxPrice: 50 })).toBe(2);
    expect(activeFilterCount({ inStock: true, maxDistanceKm: 1, maxPrice: 25 })).toBe(3);
  });
});
