import { describe, expect, it } from "vitest";
import { buildSearchHref, EMPTY_QUERY_MESSAGE, validateQuery } from "./search-query";

describe("landing search query", () => {
  it("builds the URL the existing search page reads (/search?q=...)", () => {
    expect(buildSearchHref("Crocin 500mg")).toBe("/search?q=Crocin+500mg");
    expect(buildSearchHref("  Paracetamol ")).toBe("/search?q=Paracetamol");
  });

  it("caps the query like the search page does and falls back to the bare search page when empty", () => {
    expect(new URLSearchParams(buildSearchHref("a".repeat(300)).slice("/search?".length)).get("q")).toHaveLength(100);
    expect(buildSearchHref("   ")).toBe("/search");
  });

  it("rejects an empty query with a message and accepts anything else", () => {
    expect(validateQuery("  ")).toBe(EMPTY_QUERY_MESSAGE);
    expect(validateQuery("Crocin")).toBeNull();
  });
});
