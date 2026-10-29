// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { MapPin } from "../../lib/map-data";

vi.mock("leaflet", () => ({ default: {} }));
vi.mock("leaflet/dist/leaflet.css", () => ({}));

import { popupFor } from "./ResultsMap";

const pin = (over: Record<string, unknown> = {}): MapPin =>
  ({
    pharmacy: { id: 4, code: "P004", name: "Bandra Medical Stores", address: "Hill Road, Bandra West, Mumbai 400050", latitude: 19.05548, longitude: 72.83152, demo: true, locationVerified: true, ...over },
    offers: [],
    status: "IN_STOCK",
    label: "1",
  }) as unknown as MapPin;

const links = (el: HTMLElement) => [...el.querySelectorAll("a")].map((a) => ({ text: a.textContent, href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") }));

describe("map popup", () => {
  it("shows Get Directions and View on Google Maps for that pharmacy, opening in a new tab", () => {
    const l = links(popupFor(pin(), () => undefined));
    expect(l.find((x) => x.text === "Get Directions")).toEqual({ text: "Get Directions", href: "https://www.google.com/maps/dir/?api=1&destination=19.05548,72.83152", target: "_blank", rel: "noopener noreferrer" });
    expect(l.find((x) => x.text === "View on Google Maps")).toMatchObject({ href: "https://www.google.com/maps/search/?api=1&query=19.05548,72.83152", target: "_blank", rel: "noopener noreferrer" });
    expect(l.find((x) => x.text === "View pharmacy →")!.href).toBe("/pharmacies/4");
  });

  it("uses the address for an unverified point, and the origin only when given", () => {
    const unverified = pin({ locationVerified: false, latitude: 0, longitude: 0 });
    expect(links(popupFor(unverified, () => undefined)).find((x) => x.text === "Get Directions")!.href).toBe(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("Hill Road, Bandra West, Mumbai 400050")}`);
    const withOrigin = links(popupFor(pin(), () => undefined, { latitude: 19.1, longitude: 72.9 })).find((x) => x.text === "Get Directions")!.href;
    expect(withOrigin).toBe("https://www.google.com/maps/dir/?api=1&destination=19.05548,72.83152&origin=19.1,72.9");
  });

  it("carries the demo directory notice and different destinations for different pharmacies", () => {
    const a = popupFor(pin(), () => undefined);
    const b = popupFor(pin({ id: 9, name: "Other", address: "Elsewhere", latitude: 19.2, longitude: 72.8 }), () => undefined);
    expect(a.textContent).toContain("Demo directory listing — not a confirmed MedLink partner.");
    expect(a.textContent).toContain("Inventory shown is simulated and not confirmed by Bandra Medical Stores.");
    expect(links(a).find((x) => x.text === "Get Directions")!.href).not.toBe(links(b).find((x) => x.text === "Get Directions")!.href);
  });
});
