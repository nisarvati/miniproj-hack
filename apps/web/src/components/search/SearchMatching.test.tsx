// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { medicine, mockApi, offer, pharmacy, renderWithProviders } from "../../test/utils";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/search",
  useSearchParams: () => nav.params,
}));
vi.mock("./ResultsMap", () => ({ default: (p: { results: unknown[] }) => <div data-testid="map" data-count={p.results.length} /> }));

import { SearchPage } from "./SearchPage";

beforeEach(() => {
  localStorage.clear();
  nav.params = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reasons = (pct = 90) => [
  { code: "NAME_MATCH", factor: "relevance", points: 10, factorValue: 1, message: "Matches the brand name you searched exactly." },
  { code: "IN_STOCK", factor: "availability", points: 40, factorValue: 1, message: "In stock, which earns the full availability credit." },
  { code: "NEARBY", factor: "distance", points: pct - 70, factorValue: 0.7, message: "About 1.2 km away: close enough to earn most of the distance credit." },
  { code: "PRICE_COMPARISON", factor: "price", points: 20, factorValue: 1, message: "₹25. The lowest price in ₹25 to ₹31 across 3 pharmacies with stock in these results: a lower price earns more credit." },
];
const eligible = (over: Record<string, unknown> = {}) => offer({ matchPercent: 90, matchReasons: reasons(90), ...over });
const rejectedOffer = (id: number, name: string, message = "Out of stock, and you chose in-stock pharmacies only.", code = "OUT_OF_STOCK", filter = "inStock") => ({
  medicine: medicine(),
  pharmacy: pharmacy({ id, code: `P00${id}`, name }),
  price: 28, stockStatus: "OUT_OF_STOCK", distanceKm: 9.1, distanceVerified: true, updatedAt: new Date().toISOString(), source: "live",
  reasons: [{ code, filter, message, limit: null, actual: 0 }],
});
const noNotifications = { "GET /api/notifications": () => ({ body: { data: [] } }) };
const at = (qs: string) => (nav.params = new URLSearchParams(qs));

describe("SearchPage: match explanations", () => {
  it("shows each result's match percentage and a way to read why, without a separate section when nothing was left out", async () => {
    at("q=Crocin");
    mockApi({
      "GET /api/search": () => ({ body: { data: [eligible(), eligible({ rank: 2, matchPercent: 55, pharmacy: pharmacy({ id: 2, code: "P002", name: "Pharmacy B" }) })], meta: { live: true, rejected: [], rejectionSummary: { total: 0, byReason: {}, shown: 0, truncated: false } } } }),
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText("90% match")).toBeTruthy();
    expect(screen.getByText("55% match")).toBeTruthy();
    expect(screen.getAllByText(/^Why \d+%\?$/)).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Not matching your filters" })).toBeNull();
  });

  it("still works against an older API that sends no match data", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": () => ({ body: { data: [offer()], meta: { live: true } } }), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findAllByText("Pharmacy A - Andheri West")).toBeTruthy();
    expect(screen.queryByText(/% match/)).toBeNull();
  });
});

describe("SearchPage: results left out by the chosen filters", () => {
  const filtered = (rejected: unknown[], data: unknown[]) =>
    mockApi({
      "GET /api/search": (url) =>
        url.searchParams.has("inStock")
          ? { body: { data, meta: { live: true, rejected, rejectionSummary: { total: rejected.length, byReason: { OUT_OF_STOCK: rejected.length }, shown: rejected.length, truncated: false } } } }
          : { body: { data: [...data, offer({ stockStatus: "OUT_OF_STOCK", quantity: 0, pharmacy: pharmacy({ id: 4, code: "P004", name: "Pharmacy D" }) })], meta: { live: true } } },
      ...noNotifications,
    });

  it("lists them in a separate section after the results, with why, and not as results", async () => {
    at("q=Crocin&stock=1");
    filtered([rejectedOffer(4, "Pharmacy D")], [eligible()]);
    renderWithProviders(<SearchPage />);
    const section = (await screen.findByRole("heading", { name: "Not matching your filters" })).closest("section")!;
    expect(within(section).getByText("Pharmacy D")).toBeTruthy();
    expect(within(section).getByText("Out of stock, and you chose in-stock pharmacies only.")).toBeTruthy();
    expect(within(section).getByText(/not a recommendation/)).toBeTruthy();
    // The results list holds the eligible offer only, and the left-out one is not in it.
    const results = document.querySelector("ol.results-list")!;
    expect(within(results as HTMLElement).getByText("Pharmacy A - Andheri West")).toBeTruthy();
    expect(within(results as HTMLElement).queryByText("Pharmacy D")).toBeNull();
    expect(results.contains(section)).toBe(false);
    expect(section.compareDocumentPosition(results) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy(); // results come first
    expect(within(section).queryByText(/% match/)).toBeNull();
  });

  it("explains an empty result by what was left out, next to the usual way to clear the filters", async () => {
    at("q=Crocin&stock=1");
    filtered([rejectedOffer(4, "Pharmacy D"), rejectedOffer(5, "Pharmacy E")], []);
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText("No pharmacies match your filters")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeTruthy();
    const section = screen.getByRole("heading", { name: "Not matching your filters" }).closest("section")!;
    expect(within(section).getByText("Pharmacy D")).toBeTruthy();
    expect(within(section).getByText("Pharmacy E")).toBeTruthy();
    expect(within(section).getByText(/2 listings were checked and left out/)).toBeTruthy();
  });

  it("shows several reasons for one listing, each as the API gave it", async () => {
    at("q=Crocin&stock=1&dist=5");
    const two = { ...rejectedOffer(4, "Pharmacy D"), reasons: [
      { code: "OUT_OF_STOCK", filter: "inStock", message: "Out of stock, and you chose in-stock pharmacies only.", limit: null, actual: 0 },
      { code: "OUTSIDE_DISTANCE_LIMIT", filter: "maxDistanceKm", message: "About 9.1 km away, beyond your limit of 5 km.", limit: 5, actual: 9.1 },
    ] };
    mockApi({ "GET /api/search": () => ({ body: { data: [], meta: { live: true, rejected: [two], rejectionSummary: { total: 1, byReason: {}, shown: 1, truncated: false } } } }), ...noNotifications });
    renderWithProviders(<SearchPage />);
    const section = (await screen.findByRole("heading", { name: "Not matching your filters" })).closest("section")!;
    const reasonsList = within(section).getByText("Left out because").parentElement!;
    expect(within(reasonsList).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Out of stock, and you chose in-stock pharmacies only.", "About 9.1 km away, beyond your limit of 5 km."]);
  });

  it("is hidden when no filter is chosen, even if the API sent a list (nothing can have been rejected)", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": () => ({ body: { data: [eligible()], meta: { live: true, rejected: [rejectedOffer(4, "Pharmacy D")], rejectionSummary: { total: 1, byReason: {}, shown: 1, truncated: false } } } }), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByText("90% match");
    expect(screen.queryByRole("heading", { name: "Not matching your filters" })).toBeNull();
    expect(screen.queryByText("Pharmacy D")).toBeNull();
  });

  it("is hidden when the filters left nothing out", async () => {
    at("q=Crocin&stock=1");
    filtered([], [eligible()]);
    renderWithProviders(<SearchPage />);
    await screen.findByText("90% match");
    expect(screen.queryByRole("heading", { name: "Not matching your filters" })).toBeNull();
  });

  it("is not shown with an error, and a retry brings it back", async () => {
    at("q=Crocin&stock=1");
    let up = false;
    mockApi({
      "GET /api/search": (url) =>
        !up && url.searchParams.has("inStock")
          ? { status: 503, body: { error: { code: "X", message: "down" } } }
          : { body: { data: [eligible()], meta: { live: true, rejected: [rejectedOffer(4, "Pharmacy D")], rejectionSummary: { total: 1, byReason: {}, shown: 1, truncated: false } } } },
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't load the results/);
    expect(screen.queryByRole("heading", { name: "Not matching your filters" })).toBeNull();
    up = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Not matching your filters" })).toBeTruthy();
  });

  it("shows the loading placeholders first, with no explanation yet", async () => {
    at("q=Crocin&stock=1");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    renderWithProviders(<SearchPage />);
    expect(screen.getByRole("list", { name: "Loading results" })).toBeTruthy();
    expect(screen.queryByText(/% match/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Not matching your filters" })).toBeNull();
  });
});
