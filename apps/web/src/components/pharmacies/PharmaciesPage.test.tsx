// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, pharmacy, renderWithProviders } from "../../test/utils";
import { PharmaciesPage } from "./PharmaciesPage";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }), usePathname: () => "/pharmacies", useSearchParams: () => new URLSearchParams() }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PharmaciesPage", () => {
  it("gives each pharmacy its own Get Directions link and the demo directory label", async () => {
    mockApi({
      "GET /api/pharmacies": () => ({
        body: {
          data: [
            pharmacy({ id: 1, name: "Bandra Medical Stores", address: "Hill Road, Bandra West 400050", latitude: 19.05548, longitude: 72.83152, demo: true, independent: true, locationVerified: true }),
            pharmacy({ id: 2, name: "Roopam Medical and General Stores", address: "Shop 8, Marol, Andheri East 400059", latitude: 0, longitude: 0, demo: true, independent: true, locationVerified: false }),
          ],
        },
      }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<PharmaciesPage />);
    await screen.findByText("Bandra Medical Stores");
    const links = screen.getAllByRole("link", { name: /^Get Directions to/ });
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "https://www.google.com/maps/dir/?api=1&destination=19.05548,72.83152",
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("Shop 8, Marol, Andheri East 400059")}`,
    ]);
    expect(screen.getAllByText("Demo directory listing — not a confirmed MedLink partner.")).toHaveLength(2);
  });

  it("lists verified points first with a distance, then unverified ones with no distance, and states that inventory is simulated", async () => {
    mockApi({
      "GET /api/pharmacies": () => ({
        body: {
          data: [
            pharmacy({ id: 1, name: "Aaa Unverified", address: "A Road", latitude: 19.1364, longitude: 72.8296, demo: true, independent: true, locationVerified: false, inventorySimulated: true }),
            pharmacy({ id: 4, name: "Bandra Medical Stores", address: "Hill Road", latitude: 19.05548, longitude: 72.83152, demo: true, independent: true, locationVerified: true, inventorySimulated: true }),
          ],
        },
      }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<PharmaciesPage />);
    await screen.findByText("Bandra Medical Stores");
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(names).toEqual(["Bandra Medical Stores", "Aaa Unverified"]); // the verified point sorts first, though its name comes later
    expect(screen.getByText("Location not verified: distance not shown")).toBeTruthy();
    expect(screen.getByText("Inventory shown is simulated and not confirmed by Bandra Medical Stores.")).toBeTruthy();
    expect(screen.getByText("Inventory shown is simulated and not confirmed by Aaa Unverified.")).toBeTruthy();
  });
});

describe("PharmaciesPage directory listings (no inventory)", () => {
  const entry = (over: Record<string, unknown>) => ({
    code: "P050", name: "Lead Chemist", area: "Kandivali West", address: "Shop 2, Test Road, Kandivali West, Mumbai 400067", listingStatus: "needs-review", reason: "x",
    directions: "approximate", demo: true, label: "Demo directory listing — not a confirmed MedLink partner.", inventory: "none", locationVerified: false, ...over,
  });

  it("shows leads with the disclaimer, no stock/distance/pin, and honest directions", async () => {
    mockApi({
      "GET /api/pharmacies": () => ({ body: { data: [] } }),
      "GET /api/directory": () => ({
        body: {
          data: [
            entry({}),
            entry({ code: "P051", name: "Provisional Chemist", listingStatus: "provisional", directions: "address" }),
            entry({ code: "P052", name: "Partial Chemist", address: "Hanuman Nagar, Kandivali East", directions: "unavailable" }),
            entry({ code: "P053", name: "Chain Pharmacy", listingStatus: "excluded", directions: "unavailable" }),
          ],
        },
      }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<PharmaciesPage />);
    await screen.findByText("Lead Chemist");
    expect(screen.queryByText("Chain Pharmacy")).toBeNull();
    expect(screen.getByText(/1 further lead excluded/)).toBeTruthy();
    expect(screen.getAllByText("Demo directory listing — not a confirmed MedLink partner.")).toHaveLength(3);
    expect(screen.getAllByText(/Location not verified: no distance or map pin/)).toHaveLength(3);
    expect(screen.getByRole("link", { name: "Get approximate directions to Lead Chemist" }).getAttribute("href")).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("Shop 2, Test Road, Kandivali West, Mumbai 400067")}`,
    );
    expect(screen.getByRole("link", { name: "Get Directions to Provisional Chemist" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Partial Chemist/ })).toBeNull();
    expect(screen.getByText(/Directions unavailable: the address is incomplete/)).toBeTruthy();
    expect(screen.queryByText(/km/)).toBeNull();
  });

  it("the pharmacy list still works when the directory cannot be loaded", async () => {
    mockApi({
      "GET /api/pharmacies": () => ({ body: { data: [pharmacy({ id: 1, name: "Bandra Medical Stores", latitude: 19.05548, longitude: 72.83152, demo: true, locationVerified: true })] } }),
      "GET /api/notifications": () => ({ body: { data: [] } }),
    });
    renderWithProviders(<PharmaciesPage />);
    await screen.findByText("Bandra Medical Stores");
    expect(screen.queryByText(/Directory listings: no inventory/)).toBeNull();
  });
});
