// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { MatchReason, SearchResult } from "../../lib/api";
import { offer } from "../../test/utils";
import { MatchInfo, strongestReasons } from "./MatchInfo";
import { RejectedSection } from "./RejectedSection";
import { ResultCard } from "./ResultCard";

afterEach(cleanup);

const reason = (code: MatchReason["code"], factor: MatchReason["factor"], points: number, message: string, factorValue: number | null = 1): MatchReason => ({ code, factor, points, factorValue, message });
const REASONS: MatchReason[] = [
  reason("NAME_MATCH", "relevance", 10, "Matches the brand name you searched exactly."),
  reason("IN_STOCK", "availability", 40, "In stock, which earns the full availability credit."),
  reason("NEARBY", "distance", 24, "About 1.2 km away: close enough to earn most of the distance credit.", 0.88),
  reason("PRICE_COMPARISON", "price", 20, "₹25. The lowest price in ₹25 to ₹31 across 3 pharmacies with stock in these results: a lower price earns more credit."),
];
const withMatch = (over: Partial<SearchResult> = {}) => ({ ...offer(), matchPercent: 94, matchReasons: REASONS, ...over }) as unknown as SearchResult;

describe("strongestReasons", () => {
  it("orders by points, keeps the fixed order for ties, drops anything that earned nothing, and stops at n", () => {
    expect(strongestReasons(REASONS).map((r) => r.code)).toEqual(["IN_STOCK", "NEARBY"]);
    expect(strongestReasons(REASONS, 3).map((r) => r.code)).toEqual(["IN_STOCK", "NEARBY", "PRICE_COMPARISON"]);
    const tie = [reason("NAME_MATCH", "relevance", 10, "a"), reason("IN_STOCK", "availability", 10, "b"), reason("MISSING_DISTANCE", "distance", 0, "c", null), reason("PRICE_NO_COMPARISON", "price", 10, "d")];
    expect(strongestReasons(tie, 5).map((r) => r.code)).toEqual(["NAME_MATCH", "IN_STOCK", "PRICE_NO_COMPARISON"]);
    expect(strongestReasons([reason("OUT_OF_STOCK", "availability", 0, "x")])).toEqual([]);
  });
});

describe("MatchInfo", () => {
  it("shows the percentage as text, with the strongest factors, and nothing that depends on colour", () => {
    render(<MatchInfo result={withMatch()} />);
    expect(screen.getByText("94% match").textContent).toBe("Match: 94% match"); // the screen-reader label is part of the text
    expect(screen.getByText(/Strongest: In stock · Nearby/)).toBeTruthy();
  });

  it("explains every factor, with its points, when asked, and says what the percentage is not", async () => {
    render(<MatchInfo result={withMatch()} />);
    const list = screen.getByRole("list", { name: "How the 94% match is made" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(list.textContent).toMatch(/\+10.*Matches the brand name you searched exactly/);
    expect(list.textContent).toMatch(/\+40.*In stock/);
    expect(list.textContent).toMatch(/\+24.*About 1\.2 km away/);
    expect(list.textContent).toMatch(/\+20.*The lowest price in/);
    const points = within(list).getAllByRole("listitem").map((li) => Number(/\+(\d+)/.exec(li.textContent!)![1]));
    expect(points.reduce((a, b) => a + b, 0)).toBe(94); // the explanation adds up to the number
    expect(screen.getByText(/not medical advice, not a\s+recommendation to switch medicines, and not a promise the medicine is available/)).toBeTruthy();
    await userEvent.click(screen.getByText("Why 94%?"));
  });

  it("says plainly when there is no distance or nothing to compare a price with, and earns no credit for it", () => {
    const missing = withMatch({
      matchPercent: 62,
      matchReasons: [
        reason("NAME_MATCH", "relevance", 10, "Matches the brand name you searched exactly."),
        reason("IN_STOCK", "availability", 40, "In stock, which earns the full availability credit."),
        reason("MISSING_DISTANCE", "distance", 0, "No distance is known (this pharmacy's map location is not verified, or your location is not set), so it earns no distance credit. That is not the same as being far away.", null),
        reason("PRICE_NO_COMPARISON", "price", 12, "₹25. There is no other pharmacy with stock in these results to compare it with, so it counts in full and is not described as high or low."),
      ],
    });
    render(<MatchInfo result={missing} />);
    expect(screen.getByText(/not the same as being far away/)).toBeTruthy();
    expect(screen.getByText(/no other pharmacy with stock in these results to compare it with/)).toBeTruthy();
    expect(screen.getByText(/Strongest: In stock · Price/)).toBeTruthy();
    expect(screen.queryByText(/Nearby/)).toBeNull(); // never claims nearby without a distance
    expect(document.body.textContent).not.toMatch(/cheapest|lowest|nearest/i);
  });

  it("shows no unit count and no clinical wording", () => {
    render(<MatchInfo result={withMatch()} />);
    expect(document.body.textContent).not.toMatch(/\bunits?\b|\bleft\b/i);
    expect(document.body.textContent).not.toMatch(/suitab|effective|safe to|cure|treat/i);
  });

  it("renders nothing for a result without match data (an older API) or with an empty explanation", () => {
    const { container, rerender } = render(<MatchInfo result={offer() as unknown as SearchResult} />);
    expect(container.textContent).toBe("");
    rerender(<MatchInfo result={withMatch({ matchReasons: [] })} />);
    expect(container.textContent).toBe("");
    rerender(<MatchInfo result={withMatch({ matchPercent: undefined })} />);
    expect(container.textContent).toBe("");
  });

  it("shows a zero-percent match as 0%, not as missing", () => {
    render(<MatchInfo result={withMatch({ matchPercent: 0, matchReasons: REASONS.map((r) => ({ ...r, points: 0 })) })} />);
    expect(screen.getByText("0% match")).toBeTruthy();
    expect(screen.queryByText(/Strongest/)).toBeNull();
  });
});

describe("ResultCard", () => {
  it("carries the match explanation alongside the existing details", () => {
    render(<ol><ResultCard result={withMatch()} origin={null} best={false} /></ol>);
    expect(screen.getByText("94% match")).toBeTruthy();
    expect(screen.getByText("Pharmacy A - Andheri West")).toBeTruthy();
    expect(screen.getByText("In stock")).toBeTruthy(); // the stock badge, as before
  });

  it("is unchanged for a result with no match data", () => {
    render(<ol><ResultCard result={offer() as unknown as SearchResult} origin={null} best={false} /></ol>);
    expect(screen.queryByText(/% match/)).toBeNull();
    expect(screen.getByText("Pharmacy A - Andheri West")).toBeTruthy();
  });
});

describe("RejectedSection", () => {
  const rejectedOffer = (id: number, over: Record<string, unknown> = {}) => ({
    medicine: { id: 1, code: "M001", brandName: "Crocin", genericName: "Paracetamol", dosage: "500mg", form: "tablet" },
    pharmacy: { id, code: `P00${id}`, name: `Pharmacy ${id}`, address: "x", latitude: 19, longitude: 72 },
    price: 25, stockStatus: "OUT_OF_STOCK", distanceKm: 9.2, distanceVerified: true, updatedAt: "2026-10-29T12:00:00Z", source: "live",
    reasons: [{ code: "OUT_OF_STOCK", filter: "inStock", message: "Out of stock, and you chose in-stock pharmacies only.", limit: null, actual: 0 }],
    ...over,
  }) as never;

  it("renders nothing when nothing was left out", () => {
    const { container } = render(<RejectedSection rejected={[]} summary={{ total: 0, byReason: {}, shown: 0, truncated: false }} />);
    expect(container.textContent).toBe("");
  });

  it("sets the listings apart, says they are not recommendations, and gives each one's reason", () => {
    render(<RejectedSection rejected={[rejectedOffer(4), rejectedOffer(6, { stockStatus: "IN_STOCK", distanceKm: null, reasons: [
      { code: "MISSING_REQUIRED_DATA", filter: "maxDistanceKm", field: "distance", message: "Its location is not verified (or yours is not set), so it cannot be shown to be within your limit of 5 km.", limit: 5, actual: null },
      { code: "PRICE_LIMIT_EXCEEDED", filter: "maxPrice", message: "Costs ₹80, above your limit of ₹50.", limit: 50, actual: 80 },
    ] })]} summary={{ total: 2, byReason: {}, shown: 2, truncated: false }} />);
    expect(screen.getByRole("heading", { name: "Not matching your filters" })).toBeTruthy();
    expect(screen.getByText(/2 listings were checked and left out by the filters you chose/)).toBeTruthy();
    expect(screen.getByText(/They are not recommendations: change a filter to see them in your results\./)).toBeTruthy();
    const items = within(screen.getByRole("list", { name: "Listings left out by your filters" })).getAllByRole("listitem", { hidden: false }).filter((li) => li.textContent!.includes("Left out because"));
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/Pharmacy 4/);
    expect(items[0]!.textContent).toMatch(/9\.2 km/);
    expect(items[0]!.textContent).toMatch(/Left out because.*Out of stock, and you chose in-stock pharmacies only\./);
    expect(items[1]!.textContent).toMatch(/Distance not shown/);
    expect(items[1]!.textContent).toMatch(/cannot be shown to be within your limit of 5 km/);
    expect(items[1]!.textContent).toMatch(/Costs ₹80, above your limit of ₹50/); // every failed filter is listed
    expect(screen.queryByText(/% match/)).toBeNull(); // never scored or ranked
  });

  it("says how many are not listed when the list is cut short, with grammar for one", () => {
    const { rerender } = render(<RejectedSection rejected={[rejectedOffer(4)]} summary={{ total: 45, byReason: {}, shown: 1, truncated: true }} />);
    expect(screen.getByText("Showing 1 of 45 left out. Narrowing your search shows fewer.")).toBeTruthy();
    rerender(<RejectedSection rejected={[rejectedOffer(4)]} summary={{ total: 1, byReason: {}, shown: 1, truncated: false }} />);
    expect(screen.getByText(/1 listing was checked and left out/)).toBeTruthy();
    expect(screen.getByText(/It is not a recommendation: change a filter to see it in your results\./)).toBeTruthy();
    expect(screen.queryByText(/Showing 1 of/)).toBeNull();
  });

  it("works without a summary (an older API) by counting what it was given", () => {
    render(<RejectedSection rejected={[rejectedOffer(4), rejectedOffer(5)]} summary={null} />);
    expect(screen.getByText(/2 listings were checked/)).toBeTruthy();
  });
});
