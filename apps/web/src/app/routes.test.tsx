// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderWithProviders } from "../test/utils";

const font = vi.hoisted(() => ({ variable: "font-var", className: "font-class" }));
vi.mock("../components/landing/v1/fonts", () => ({ display: font, mono: font }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import config from "../../next.config";
import { isActive, NAV } from "../components/shell/nav";
import Home, { metadata as homeMetadata } from "./page";
import LandingV1, { metadata as v1Metadata } from "./landing/v1/page";
import Search from "./search/page";

beforeEach(() => mockApi({ "GET /api/notifications": () => ({ body: { data: [] } }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("routes", () => {
  it("serves the V1 landing page at / (and the same design at /landing/v1)", () => {
    for (const Page of [Home, LandingV1]) {
      const { container, unmount } = renderWithProviders(<Page />);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Find your medicine. Know where to look.");
      expect(container.querySelector("[data-hero-map]")).not.toBeNull();
      unmount();
    }
  });

  it("makes / indexable with its own canonical link, while the /landing/v1 preview stays noindex", () => {
    expect(homeMetadata.robots).toBeUndefined();
    expect(homeMetadata.alternates?.canonical).toBe("/");
    expect(v1Metadata.robots).toEqual({ index: false, follow: false });
  });

  it("keeps the search app, with its URL state, at /search", () => {
    renderWithProviders(<Search />);
    expect(document.querySelector("main, form, [role=search]") ?? document.body).toBeTruthy();
    expect(NAV.find((n) => n.label === "Search")?.href).toBe("/search");
    expect(isActive("/search", "/search")).toBe(true);
    expect(isActive("/search", "/pharmacies")).toBe(false);
    expect(isActive("/pharmacies/3", "/pharmacies")).toBe(true);
  });
});

describe("redirects", () => {
  it("sends /landing to the homepage, and old /?q=... searches to /search with their query", async () => {
    const rules = await config.redirects!();
    expect(rules).toContainEqual({ source: "/landing", destination: "/", permanent: false });
    const search = rules.find((r) => r.source === "/" && r.destination === "/search")!;
    expect(search.has).toEqual([{ type: "query", key: "q" }]);
  });

  it("does not redirect the other landing previews", async () => {
    const rules = await config.redirects!();
    for (const n of [1, 2, 3, 4, 5]) expect(rules.some((r) => r.source === `/landing/v${n}`)).toBe(false);
  });
});
