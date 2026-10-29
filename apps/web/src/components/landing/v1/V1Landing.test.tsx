// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, offer, renderWithProviders } from "../../../test/utils";

const font = vi.hoisted(() => ({ variable: "font-var", className: "font-class" }));
vi.mock("./fonts", () => ({ display: font, mono: font }));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }), usePathname: () => "/landing/v1" }));

import { PIPELINE } from "../shared/content";
import { V1Landing } from "./V1Landing";

beforeEach(() => {
  localStorage.clear();
  nav.push.mockClear();
  mockApi({
    "GET /api/notifications": () => ({ body: { data: [] } }),
    "GET /api/search": () => ({ body: { data: [offer()], meta: { live: true } } }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const after = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("V1 landing: hero and navigation", () => {
  it("states the proposition and shows the interactive hero illustration at the original artwork's proportions", () => {
    const { container } = renderWithProviders(<V1Landing />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Find your medicine. Know where to look.");
    const art = container.querySelector("[data-hero-map]") as HTMLElement;
    expect(art.style.aspectRatio).toBe("1600 / 2000");
    expect(art.getAttribute("role")).toBe("group");
    expect(art.getAttribute("aria-label")).toMatch(/not live stock/);
    expect(art.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(art.querySelectorAll("button[data-chip]")).toHaveLength(0); // the capsule comes first
    expect(screen.getByRole("button", { name: /Explore/ })).toBeTruthy();
    expect(art.textContent).toMatch(/A world of medicine, waiting to be found\./i);
    expect(container.querySelector('[data-slot="hero-image"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Image slot|Direction 0?1|Sheet 01/);
  });

  it("searches through the existing flow from the hero and from the closing section", async () => {
    renderWithProviders(<V1Landing />);
    const boxes = screen.getAllByRole("combobox");
    expect(boxes).toHaveLength(2);
    await userEvent.type(boxes[0]!, "Crocin 500mg{Enter}");
    expect(nav.push).toHaveBeenLastCalledWith("/search?q=Crocin+500mg");
    await userEvent.type(boxes[1]!, "Augmentin");
    await userEvent.click(screen.getAllByRole("button", { name: "Find a Medicine" })[1]!);
    expect(nav.push).toHaveBeenLastCalledWith("/search?q=Augmentin");
  });

  it("points Explore How It Works at the how-it-works section and the portal links at /portal", () => {
    const { container } = renderWithProviders(<V1Landing />);
    const explore = screen.getByRole("link", { name: /Explore How It Works/ });
    expect(explore.getAttribute("href")).toBe("#how-it-works");
    expect(container.querySelector("#how-it-works")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Open the pharmacy portal/ }).getAttribute("href")).toBe("/portal");
  });
});

describe("V1 landing: ownership and the technical section", () => {
  it("keeps the light ownership section free of a diagram", () => {
    const { container } = renderWithProviders(<V1Landing />);
    const section = container.querySelector("#network")!;
    expect(within(section as HTMLElement).getByText("Records kept by")).toBeTruthy();
    expect(section.querySelector("svg")).toBeNull();
  });

  it("places the technical section after ownership and before the closing section", () => {
    const { container } = renderWithProviders(<V1Landing />);
    const heading = (name: string) => screen.getByRole("heading", { level: 2, name });
    const ownership = heading("Each pharmacy keeps its own records. MedLink makes them searchable.");
    const pipeline = heading(PIPELINE.title);
    const staff = heading("Pharmacy staff keep their own shelf accurate.");
    const closing = heading("Find your medicine.");
    expect(after(heading("Pharmacies, side by side"), ownership)).toBe(true);
    expect(after(ownership, pipeline)).toBe(true);
    expect(after(pipeline, staff)).toBe(true);
    expect(after(staff, closing)).toBe(true);
    expect(container.querySelectorAll("section#under-the-surface")).toHaveLength(1);
  });

  it("walks the five real stages in order, in plain words", () => {
    renderWithProviders(<V1Landing />);
    const section = screen.getByRole("heading", { level: 2, name: PIPELINE.title }).closest("section")!;
    const items = within(section).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("h3")!.textContent)).toEqual([
      "Each pharmacy's own database",
      "A change becomes an event",
      "Synchronisation",
      "Searchable inventory state",
      "Medicine discovery",
    ]);
    expect(within(section).getByText(PIPELINE.lead)).toBeTruthy();
  });

  it("labels the schematic illustrative and makes no claim about speed, scale or coverage", () => {
    renderWithProviders(<V1Landing />);
    const section = screen.getByRole("heading", { level: 2, name: PIPELINE.title }).closest("section")!;
    expect(within(section).getByRole("img").textContent).toMatch(/^Illustrative schematic:/);
    expect(within(section).getByText("Illustrative schematic.")).toBeTruthy();
    const text = section.textContent ?? "";
    expect(text).toMatch(/search is not instant/);
    expect(text).toMatch(/Only participating pharmacies are included/);
    expect(text).toMatch(/last known values and says so/);
    expect(text).not.toMatch(/real-?time|latency|uptime|throughput|\d+\s?(ms|milliseconds)\b|99(\.\d)?%|every pharmacy is/i);
    expect(text).not.toMatch(/(?<!not )instant/i);
  });

  it("is self-contained: no search box, ledger or links inside it", () => {
    renderWithProviders(<V1Landing />);
    const section = screen.getByRole("heading", { level: 2, name: PIPELINE.title }).closest("section")!;
    expect(section.querySelector("[data-ls], [data-av], a, button, input")).toBeNull();
  });
});

describe("V1 landing: availability", () => {
  it("still shows the API's data with live / last known freshness", async () => {
    renderWithProviders(<V1Landing />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText(/Crocin 500mg/)).toBeTruthy();
    expect(within(table).getByText(/Live · updated/)).toBeTruthy();
  });

  it("explains the symbols and freshness labels above the ledger", () => {
    renderWithProviders(<V1Landing />);
    expect(screen.getByText(/Live: reported by the pharmacy's own system/)).toBeTruthy();
    expect(screen.getByText(/Last known: an older value held by MedLink/)).toBeTruthy();
  });
});
