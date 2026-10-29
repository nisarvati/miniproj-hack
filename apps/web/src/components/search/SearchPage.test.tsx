// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { medicine, mockApi, offer, pharmacy, renderWithProviders } from "../../test/utils";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/search",
  useSearchParams: () => nav.params,
}));
// Leaflet needs a real browser; the map has its own tests of what it is given.
vi.mock("./ResultsMap", () => ({ default: (p: { results: unknown[] }) => <div data-testid="map" data-count={p.results.length} /> }));

import { SearchPage } from "./SearchPage";

const at = (qs: string) => (nav.params = new URLSearchParams(qs));
const out = (over: Record<string, unknown> = {}) => offer({ quantity: 0, stockStatus: "OUT_OF_STOCK", ...over });
const search = (results: unknown[], live = true) => () => ({ body: { data: results, meta: { live } } });
const withMatches = (results: unknown[], matches: { medicine: ReturnType<typeof medicine>; listed: boolean }[]) => () => ({ body: { data: results, meta: { live: true, matches } } });
const noNotifications = { "GET /api/notifications": () => ({ body: { data: [] } }) };

beforeEach(() => {
  localStorage.clear();
  nav.push.mockClear();
  nav.replace.mockClear();
  at("");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SearchPage without a query", () => {
  it("shows the welcome, makes no request, and searches when a suggestion is chosen", async () => {
    const api = mockApi({});
    renderWithProviders(<SearchPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Find your medicine");
    expect(screen.getByRole("heading", { name: "Common essentials" })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search medicine name or brand")).toBeTruthy();
    // one search box, and no promotional sections around it
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByText("Real-time shelf updates")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Stock you can understand." })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Paracetamol" }));
    expect(nav.push).toHaveBeenCalledWith("/search?q=Paracetamol", { scroll: false });
    expect(api.calls).toEqual([]);
  });

  it("will not search an empty box, and says why", async () => {
    mockApi({});
    renderWithProviders(<SearchPage />);
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Enter a medicine name/);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("offers debounced keyboard suggestions through the combobox pattern", async () => {
    mockApi({});
    renderWithProviders(<SearchPage />);
    const box = screen.getByRole("combobox", { name: "Medicine name" });
    await userEvent.type(box, "Cro");
    const option = await screen.findByRole("option", { name: "Crocin 500mg" });
    expect(box.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(option.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(nav.push).toHaveBeenCalledWith("/search?q=Crocin+500mg", { scroll: false });
  });

  it("searches from the common essentials browse cards", async () => {
    mockApi({});
    renderWithProviders(<SearchPage />);
    await userEvent.click(screen.getByRole("button", { name: "Dolo 650" }));
    expect(nav.push).toHaveBeenCalledWith("/search?q=Dolo+650", { scroll: false });
  });
});

describe("SearchPage with results", () => {
  it("searches from the chosen location and shows each offer, the best first", async () => {
    at("q=Crocin+500mg");
    const api = mockApi({
      "GET /api/search": search([offer(), offer({ rank: 2, pharmacy: pharmacy({ id: 2, name: "Pharmacy B" }), quantity: 3, stockStatus: "LOW_STOCK", source: "catalogue", price: 32 })]),
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);

    expect(await screen.findByText(/Pharmacy A - Andheri West/)).toBeTruthy();
    const call = api.calls.find((c) => c.path === "/api/search")!;
    expect(call.search.get("q")).toBe("Crocin 500mg");
    expect(call.search.get("lat")).toBe("19.1364");
    expect(call.search.get("inStock")).toBeNull();

    expect(screen.getByText("★ Best match", { selector: "span" })).toBeTruthy(); // the badge, not the sort option
    expect(screen.getByText(/2 pharmacies near Andheri West have Crocin 500mg/)).toBeTruthy();
    expect(screen.getByText("Typical price range")).toBeTruthy();
    expect(screen.getByText("₹25 – ₹32")).toBeTruthy();
    expect(screen.getAllByText("400 m away").length).toBeGreaterThan(0);
    expect(screen.getByText("Live stock")).toBeTruthy();
    // only the status: never how many units a pharmacy has
    expect(screen.getByText("In stock", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("Low stock", { selector: "span" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b(12|3) (in stock|left|available)|only \d+ left|\d+ units/i);
    expect(screen.getAllByText(/Live/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Last known · updated/)).toBeTruthy(); // the catalogue-sourced offer says so
  });

  it("shows the medicine's generic name and form on the card, and a substitutes link when it is out of stock", async () => {
    at("q=Crocin");
    mockApi({
      "GET /api/search": search([out()]),
      "GET /api/medicines/1/substitutes": () => ({ body: { data: [{ medicine: medicine({ id: 2, brandName: "Dolo", dosage: "650mg" }), sameStrength: false, sameForm: true, best: offer({ medicine: medicine({ id: 2, brandName: "Dolo", dosage: "650mg" }) }), pharmaciesInStock: 1 }], meta: { notice: "Ask a pharmacist before switching." } } }),
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);
    await screen.findByText(/Pharmacy A/);
    expect(screen.getAllByText(/Paracetamol/).length).toBeGreaterThan(0);
    expect(screen.queryByText("More medicine details")).toBeNull(); // one medicine: nothing more to expand
    expect(screen.getByRole("link", { name: "Show substitutes" }).getAttribute("href")).toBe("#alternatives-1");
  });

  it("a new search goes into the URL", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": search([offer()]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByText(/Pharmacy A/);
    const box = screen.getByRole("combobox", { name: "Medicine name" });
    await userEvent.clear(box);
    await userEvent.type(box, "Dolo{Enter}");
    expect(nav.push).toHaveBeenCalledWith("/search?q=Dolo", { scroll: false });
  });

  it("warns that figures may be out of date when live stock is down", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": search([offer({ source: "catalogue" })], false), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect((await screen.findByText("Showing last known stock")).textContent).toBeTruthy();
    expect(screen.queryByText("Live stock")).toBeNull();
  });

  it("does not claim live stock when Redis answered but nothing live has arrived yet", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": search([offer({ source: "catalogue" })], true), ...noNotifications });
    renderWithProviders(<SearchPage />);
    const warning = await screen.findByText("Showing last known stock");
    expect(warning.closest("[role=status]")!.textContent).toMatch(/No live updates have reached MedLink/);
    expect(screen.queryByText("Live stock")).toBeNull();
  });

  it("says 'live' as soon as any result really is", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": search([offer({ source: "catalogue" }), offer({ source: "live", pharmacy: pharmacy({ id: 2 }) })]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText("Live stock")).toBeTruthy();
    expect(screen.queryByText("Showing last known stock")).toBeNull();
  });

  it("only the best-ranked offer is called 'best match', and only for the default sort", async () => {
    at("q=Crocin&sort=price");
    mockApi({ "GET /api/search": search([offer()]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByText(/Pharmacy A/);
    expect(screen.queryByText("★ Best match", { selector: "span" })).toBeNull();
  });

  it("shows the list or the map, as the URL says", async () => {
    at("q=Crocin&view=map");
    mockApi({ "GET /api/search": search([offer(), offer({ pharmacy: pharmacy({ id: 2 }) })]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect((await screen.findByTestId("map")).getAttribute("data-count")).toBe("2");
    expect(screen.queryByRole("article")).toBeNull();
  });
});

describe("SearchPage when a medicine is out of stock everywhere", () => {
  const unavailable = () =>
    mockApi({
      "GET /api/search": search([out(), out({ pharmacy: pharmacy({ id: 2, name: "Pharmacy B" }) })]),
      "GET /api/medicines/1/substitutes": () => ({
        body: {
          data: [{ medicine: medicine({ id: 2, code: "M002", brandName: "Dolo", dosage: "650mg" }), sameStrength: false, sameForm: true, best: offer({ medicine: medicine({ id: 2, brandName: "Dolo", dosage: "650mg" }), price: 32 }), pharmaciesInStock: 3 }],
          meta: { notice: "Strength or form may differ. Check with a pharmacist or your doctor before switching." },
        },
      }),
      ...noNotifications,
    });

  it("offers to notify, and suggests same-ingredient alternatives with the differences spelled out", async () => {
    at("q=Crocin");
    unavailable();
    renderWithProviders(<SearchPage />);

    expect((await screen.findByText(/Crocin 500mg is out of stock at all 2 pharmacies we found/)).textContent).toBeTruthy();
    expect(screen.getByLabelText(/notify me when/i)).toBeTruthy();

    const alternatives = await screen.findByRole("region", { name: /Alternatives to Crocin 500mg/ });
    expect(within(alternatives).getByText("Dolo 650mg")).toBeTruthy();
    expect(within(alternatives).getByText(/Different strength \(650mg\)/)).toBeTruthy();
    expect(within(alternatives).getByText("Same form")).toBeTruthy();
    expect(within(alternatives).getByText(/Check with a pharmacist or your doctor/)).toBeTruthy();
  });

  it("a failing alternatives lookup never hides the notify form", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": search([out()]), "GET /api/medicines/1/substitutes": () => ({ status: 500 }), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByLabelText(/notify me when/i)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("region", { name: /Alternatives/ })).toBeNull());
  });

  it("does not offer it for a medicine that is in stock somewhere", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": search([out(), offer({ pharmacy: pharmacy({ id: 2 }) })]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findAllByRole("article");
    expect(screen.queryByLabelText(/notify me when/i)).toBeNull();
  });

  it("still offers it when 'in stock only' hides every result, by asking once more without the filters", async () => {
    at("q=Crocin&stock=1");
    const api = mockApi({
      "GET /api/search": (url) => (url.searchParams.get("inStock") === "true" ? { body: { data: [], meta: { live: true } } } : { body: { data: [out()], meta: { live: true } } }),
      "GET /api/medicines/1/substitutes": () => ({ body: { data: [], meta: {} } }),
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByLabelText(/notify me when/i)).toBeTruthy();
    expect(screen.getByText("No pharmacies match your filters")).toBeTruthy();
    expect(api.calls.filter((c) => c.path === "/api/search").map((c) => c.search.get("inStock"))).toEqual(expect.arrayContaining(["true", null]));
  });
});

describe("SearchPage filters", () => {
  it("send the filters to the API and write them to the URL", async () => {
    at("q=Crocin&stock=1&dist=5&price=50&sort=distance");
    const api = mockApi({ "GET /api/search": search([offer()]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByText(/Pharmacy A/);
    const filtered = api.calls.find((c) => c.path === "/api/search" && c.search.get("inStock") === "true")!;
    expect(Object.fromEntries(filtered.search)).toMatchObject({ q: "Crocin", inStock: "true", maxDistanceKm: "5", maxPrice: "50", sort: "distance" });

    await userEvent.selectOptions(screen.getByLabelText("Sort by"), "price");
    expect(nav.push).toHaveBeenLastCalledWith("/search?q=Crocin&stock=1&dist=5&price=50&sort=price", { scroll: false });
    await userEvent.click(screen.getByRole("button", { name: /clear filters \(3\)/i }));
    expect(nav.push).toHaveBeenLastCalledWith("/search?q=Crocin&sort=distance", { scroll: false });
  });

  it("explains an empty result caused by filters, and clears them", async () => {
    at("q=Crocin&price=25");
    mockApi({ "GET /api/search": search([]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText("No pharmacies match your filters")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(nav.push).toHaveBeenLastCalledWith("/search?q=Crocin", { scroll: false });
  });

  it("says plainly when nothing matches the name", async () => {
    at("q=zzzz");
    mockApi({ "GET /api/search": search([]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText(/No medicines found for “zzzz”/)).toBeTruthy();
  });
});

describe("SearchPage failures", () => {
  it("shows a safe message with a retry that searches again", async () => {
    at("q=Crocin");
    let fail = true;
    const api = mockApi({
      "GET /api/search": () => (fail ? { status: 503, body: { error: { message: "connect ECONNREFUSED 10.0.0.5" } } } : { body: { data: [offer()], meta: { live: true } } }),
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/temporarily unavailable/i);
    expect(alert.textContent).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Pharmacy A/)).toBeTruthy();
    expect(api.count("GET", "/api/search")).toBe(2);
  });
});

describe("SearchPage catalogue awareness", () => {
  const retaunch = medicine({ id: 40, code: "M025", brandName: "Retaunch", genericName: "N-Acetylcysteine + Taurine", dosage: "150mg/500mg" });

  it("says a catalogued medicine is not listed by any pharmacy, without implying stock", async () => {
    at("q=Retaunch");
    mockApi({ "GET /api/search": withMatches([], [{ medicine: retaunch, listed: false }]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText("No pharmacy has listed this medicine yet")).toBeTruthy();
    expect(screen.getByText(/Retaunch 150mg\/500mg tablet/)).toBeTruthy();
    expect(screen.getByText(/not the same as being out of stock/)).toBeTruthy();
    expect(screen.queryByText(/No medicines found/)).toBeNull();
    expect(screen.queryByText(/isn't in the MedLink catalogue/)).toBeNull();
    expect(screen.queryByLabelText(/notify me when/i)).toBeNull(); // nothing to wait for: it is not even listed
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("lists every unlisted match when the query matches several catalogue medicines", async () => {
    at("q=acetylcysteine");
    const other = medicine({ id: 41, brandName: "Nefrosave", dosage: "150mg/500mg", genericName: "N-Acetylcysteine + Taurine" });
    mockApi({ "GET /api/search": withMatches([], [{ medicine: retaunch, listed: false }, { medicine: other, listed: false }]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByText("No pharmacy has listed this medicine yet");
    const list = screen.getByRole("list", { name: "Catalogue medicines no pharmacy has listed" });
    expect(list.textContent).toMatch(/Retaunch/);
    expect(list.textContent).toMatch(/Nefrosave/);
  });

  it("keeps the offers and notes the other matches that no pharmacy lists", async () => {
    at("q=cetirizine");
    const listed = medicine({ id: 8, brandName: "Cetzine", genericName: "Cetirizine", dosage: "10mg" });
    const unlisted = medicine({ id: 90, brandName: "Okacet", genericName: "Cetirizine", dosage: "10mg" });
    mockApi({
      "GET /api/search": withMatches([offer({ medicine: listed, price: 22.5, quantity: 7 })], [{ medicine: listed, listed: true }, { medicine: unlisted, listed: false }]),
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText(/Pharmacy A/)).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText(/Also in the MedLink catalogue, but not listed by any pharmacy yet/)).toBeTruthy();
    const note = screen.getByRole("list", { name: "Catalogue medicines no pharmacy has listed" });
    expect(note.textContent).toMatch(/Okacet/);
    expect(note.textContent).not.toMatch(/Cetzine/);
  });

  it("shows no unlisted note when every match has offers", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": withMatches([offer()], [{ medicine: medicine(), listed: true }]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByText(/Pharmacy A/);
    expect(screen.queryByText(/not listed by any pharmacy/)).toBeNull();
    expect(screen.queryByText("No pharmacy has listed this medicine yet")).toBeNull();
  });

  it("says a medicine that is not in the catalogue at all is not in the catalogue", async () => {
    at("q=Viotace");
    mockApi({ "GET /api/search": withMatches([], []), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText("“Viotace” isn't in the MedLink catalogue")).toBeTruthy();
    expect(screen.queryByText("No pharmacy has listed this medicine yet")).toBeNull();
  });

  it("filters hiding the offers of a listed medicine are still a filter problem, not 'unlisted'", async () => {
    at("q=Crocin&price=1");
    mockApi({ "GET /api/search": withMatches([], [{ medicine: medicine(), listed: true }]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText("No pharmacies match your filters")).toBeTruthy();
    expect(screen.queryByText("No pharmacy has listed this medicine yet")).toBeNull();
  });

  it("keeps the old empty state when an older API does not send matches", async () => {
    at("q=zzzz");
    mockApi({ "GET /api/search": search([]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(await screen.findByText(/No medicines found for “zzzz”/)).toBeTruthy();
    expect(screen.queryByText(/isn't in the MedLink catalogue/)).toBeNull();
  });

  it("shows loading, then an error with retry, without any catalogue claim", async () => {
    at("q=Retaunch");
    mockApi({ "GET /api/search": () => ({ status: 503, body: {} }), ...noNotifications });
    renderWithProviders(<SearchPage />);
    expect(screen.getByText("Loading results for Retaunch")).toBeTruthy();
    expect(await screen.findByText("We couldn't load the results")).toBeTruthy();
    expect(screen.queryByText("No pharmacy has listed this medicine yet")).toBeNull();
    expect(screen.queryByText(/isn't in the MedLink catalogue/)).toBeNull();
  });
});

const LABEL = "Demo directory listing — not a confirmed MedLink partner.";

describe("SearchPage demo listings", () => {
  it("marks a demo pharmacy's result with the exact demo directory label, and does not mark one that is not", async () => {
    at("q=Crocin");
    mockApi({
      "GET /api/search": search([
        offer({ pharmacy: pharmacy({ id: 1, name: "Bandra Medical Stores", demo: true, independent: true }) }),
        offer({ pharmacy: pharmacy({ id: 2, name: "Some Real Chemist", demo: false }) }),
      ]),
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);
    await screen.findByRole("heading", { name: /Bandra Medical Stores/ });
    const badges = screen.getAllByText(LABEL);
    expect(badges).toHaveLength(1);
    expect(badges[0]!.getAttribute("title")).toMatch(/synthetic demo data/);
    expect(badges[0]!.getAttribute("title")).toMatch(/not this pharmacy's actual inventory/);
    expect(badges[0]!.getAttribute("title")).toMatch(/has not approved the use of its name/);
  });

  it("states separately that the inventory is simulated and not confirmed by the named pharmacy, and shows no distance for an unverified location", async () => {
    at("q=Crocin");
    const paras = pharmacy({ id: 1, name: "Paras Medical and General Store", demo: true, independent: true, locationVerified: false, inventorySimulated: true });
    const bandra = pharmacy({ id: 4, name: "Bandra Medical Stores", demo: true, independent: true, locationVerified: true, inventorySimulated: true });
    mockApi({ "GET /api/search": search([offer({ pharmacy: paras, distanceKm: null, distanceVerified: false }), offer({ pharmacy: bandra, distanceKm: 9 })]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByRole("heading", { name: /Paras Medical and General Store/ });
    expect(screen.getByText("Inventory shown is simulated and not confirmed by Paras Medical and General Store.")).toBeTruthy();
    expect(screen.getByText("Inventory shown is simulated and not confirmed by Bandra Medical Stores.")).toBeTruthy();
    expect(screen.getAllByText("Demo directory listing — not a confirmed MedLink partner.")).toHaveLength(2);
    expect(screen.getAllByText("Distance not shown")).toHaveLength(1); // only the unverified one
    expect(screen.queryByText(/^0 m|Less than 100 m/)).toBeNull();
  });

  it("shows no demo marking when the API does not say (an older API)", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": search([offer()]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByText(/Pharmacy A/);
    expect(screen.queryByText(LABEL)).toBeNull();
  });
});

describe("SearchPage Get Directions", () => {
  const verified = pharmacy({ id: 1, name: "Bandra Medical Stores", address: "Hill Road, Bandra West, Mumbai 400050", latitude: 19.05548, longitude: 72.83152, demo: true, locationVerified: true });
  const addressOnly = pharmacy({ id: 2, name: "Roopam Medical and General Stores", address: "Shop 8, Bhavani Nagar Shopping Centre, Marol, Andheri East 400059", latitude: 0, longitude: 0, demo: true, locationVerified: false });
  const hrefs = () => screen.getAllByRole("link", { name: /^Get Directions to/ }).map((a) => ({ label: a.getAttribute("aria-label")!, href: a.getAttribute("href")!, target: a.getAttribute("target"), rel: a.getAttribute("rel") }));

  it("gives every result its own Get Directions link: the point when verified, the address when not, and no origin by default", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": search([offer({ pharmacy: verified }), offer({ pharmacy: addressOnly })]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByRole("heading", { name: /Bandra Medical Stores/ });
    const links = hrefs();
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ label: "Get Directions to Bandra Medical Stores", href: "https://www.google.com/maps/dir/?api=1&destination=19.05548,72.83152", target: "_blank", rel: "noopener noreferrer" });
    expect(links[1]!.href).toBe(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addressOnly.address)}`);
    expect(links.every((l) => !l.href.includes("origin="))).toBe(true); // the built-in default area is not the user's choice
  });

  it("adds the origin once the user has chosen a location", async () => {
    localStorage.setItem("medlink:location", JSON.stringify({ label: "Powai, Mumbai", location: { latitude: 19.1187, longitude: 72.9073 } }));
    at("q=Crocin");
    mockApi({ "GET /api/search": search([offer({ pharmacy: verified })]), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByRole("heading", { name: /Bandra Medical Stores/ });
    expect(hrefs()[0]!.href).toBe("https://www.google.com/maps/dir/?api=1&destination=19.05548,72.83152&origin=19.1187,72.9073");
  });
});

describe("SearchPage nearest-first with unverified locations", () => {
  const verified = pharmacy({ id: 4, name: "Bandra Medical Stores", demo: true, locationVerified: true });
  const unverified = pharmacy({ id: 1, name: "Paras Medical and General Store", demo: true, locationVerified: false });
  const body = (results: unknown[], meta: Record<string, unknown> = {}) => () => ({ body: { data: results, meta: { live: true, ...meta } } });

  it("sets the unverified results apart from the verified ones, without inventing a distance", async () => {
    at("q=Crocin&sort=distance");
    mockApi({
      "GET /api/search": body([offer({ pharmacy: verified, distanceKm: 9, distanceVerified: true }), offer({ pharmacy: unverified, distanceKm: null, distanceVerified: false })], { sortApplied: "distance", sortNote: null, unverifiedCount: 1 }),
      ...noNotifications,
    });
    renderWithProviders(<SearchPage />);
    await screen.findByRole("heading", { name: /Bandra Medical Stores/ });
    expect(screen.getByText(/Location not verified: no distance shown, ordered by availability, price and relevance/)).toBeTruthy();
    expect(screen.getByText("9.0 km away")).toBeTruthy();
    expect(screen.getAllByText("Distance not shown")).toHaveLength(1);
  });

  it("says plainly when it could not order by distance, and does not add a section divider", async () => {
    at("q=Crocin&sort=distance");
    const note = "No result has a verified location, so these are not ordered by distance. They are ordered by availability, price and relevance instead.";
    mockApi({ "GET /api/search": body([offer({ pharmacy: unverified, distanceKm: null, distanceVerified: false })], { sortApplied: "best", sortNote: note, unverifiedCount: 1 }), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByRole("heading", { name: /Paras Medical and General Store/ });
    expect(screen.getByText("Not ordered by distance")).toBeTruthy();
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.queryByText(/Location not verified: no distance shown/)).toBeNull();
    expect(screen.queryByText(/km away|m away/)).toBeNull();
  });

  it("shows no ordering note for the default ordering", async () => {
    at("q=Crocin");
    mockApi({ "GET /api/search": body([offer({ pharmacy: unverified, distanceKm: null })], { sortApplied: "best", sortNote: null }), ...noNotifications });
    renderWithProviders(<SearchPage />);
    await screen.findByRole("heading", { name: /Paras Medical and General Store/ });
    expect(screen.queryByText("Not ordered by distance")).toBeNull();
  });
});
