// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, offer, renderWithProviders } from "../../test/utils";

// next/font only works inside the Next compiler; the variants just need its class names.
const font = vi.hoisted(() => ({ variable: "font-var", className: "font-class" }));
vi.mock("./v1/fonts", () => ({ display: font, mono: font }));
vi.mock("./v2/fonts", () => ({ sans: font, mono: font }));
vi.mock("./v3/fonts", () => ({ serif: font, mono: font }));
vi.mock("./v4/fonts", () => ({ display: font, mono: font }));
vi.mock("./v5/fonts", () => ({ serif: font, sans: font }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/landing" }));

import { V1Landing } from "./v1/V1Landing";
import { V2Landing } from "./v2/V2Landing";
import { V3Landing } from "./v3/V3Landing";
import { V4Landing } from "./v4/V4Landing";
import { V5Landing } from "./v5/V5Landing";

const VARIANTS = [
  ["v1", V1Landing],
  ["v2", V2Landing],
  ["v3", V3Landing],
  ["v4", V4Landing],
  ["v5", V5Landing],
] as const;

/** Routes that exist in the app, plus the landing previews themselves. */
const ALLOWED = new Set(["/", "/portal", "/pharmacies", "/notifications", "/landing/v1", "/landing/v2", "/landing/v3", "/landing/v4", "/landing/v5"]);

beforeEach(() => {
  localStorage.clear();
  mockApi({
    "GET /api/notifications": () => ({ body: { data: [] } }),
    "GET /api/search": () => ({ body: { data: [offer()], meta: { live: true } } }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(VARIANTS)("landing direction %s", (_name, Variant) => {
  it("has one h1, a skip link and landmarks", () => {
    const { container } = renderWithProviders(<Variant />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main-content");
    expect(container.querySelector("main#main-content")).not.toBeNull();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("contentinfo")).toBeTruthy();
    expect(screen.getAllByRole("search")).toHaveLength(2);
  });

  it("offers the primary CTA in the hero and again at the end, each as a working search button", () => {
    renderWithProviders(<Variant />);
    const buttons = screen.getAllByRole("button", { name: "Find a Medicine" });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b.getAttribute("type")).toBe("submit");
    expect(screen.getByRole("link", { name: /Explore How It Works/ }).getAttribute("href")).toBe("#how-it-works");
  });

  it("only links to anchors that exist and routes that exist, and invents no legal or company pages", () => {
    const { container } = renderWithProviders(<Variant />);
    const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")!);
    for (const href of hrefs) {
      if (href.startsWith("#")) expect(container.querySelector(`[id="${href.slice(1)}"]`), `anchor ${href}`).not.toBeNull();
      else if (href.startsWith("/search?q=")) continue;
      else expect(ALLOWED.has(href), `route ${href}`).toBe(true);
    }
    expect(screen.queryByRole("link", { name: /privacy|terms/i })).toBeNull();
    expect(screen.getAllByRole("link", { name: /portal/i }).some((a) => a.getAttribute("href") === "/portal")).toBe(true);
  });

  it("reserves exactly one hero visual with a fixed aspect ratio", () => {
    const { container } = renderWithProviders(<Variant />);
    // V1's visual is the interactive illustration (`data-hero-map`); the other directions still reserve an image slot.
    const slots = container.querySelectorAll('[data-slot="hero-image"], [data-hero-map]');
    expect(slots).toHaveLength(1);
    expect((slots[0] as HTMLElement).style.aspectRatio).toMatch(/^\d+ \/ \d+$/);
    if (slots[0]!.hasAttribute("data-hero-map")) {
      expect(slots[0]!.getAttribute("role")).toBe("group");
      return;
    }
    const art = slots[0]!.querySelector("img");
    if (art) {
      expect(art.getAttribute("src")).toMatch(/^\/images\/landing\/.+\.webp$/);
    } else {
      expect(slots[0]!.getAttribute("role")).toBe("img");
      expect(slots[0]!.textContent).toMatch(/Image slot · \d+:\d+ · \d+ × \d+ px/);
    }
  });

  it("states what MedLink does not do, and shows no invented claims", () => {
    const { container } = renderWithProviders(<Variant />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/does not sell or dispense medicines/);
    expect(text).toMatch(/does not diagnose/);
    expect(text).toMatch(/Call the pharmacy/);
    expect(text).toMatch(/does not cover every pharmacy/);
    expect(text).not.toMatch(/testimonial|\d+,?\d* (users|customers|pharmacies connected)|guarantee|100%|always in stock/i);
  });

  it("shows real availability from the search API in its availability section", async () => {
    renderWithProviders(<Variant />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText(/Crocin 500mg/)).toBeTruthy();
  });
});
