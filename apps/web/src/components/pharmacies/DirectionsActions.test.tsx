// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import directory from "../../../../../packages/db/pharmacy-directory/mumbai-demo.json";
import { DirectionsActions } from "./DirectionsActions";

afterEach(cleanup);

interface Entry {
  code: string;
  name: string;
  address: string;
  location: { status: string; latitude?: number; longitude?: number };
}
const entries = directory.pharmacies as unknown as Entry[];
/** What the API would send for a directory pharmacy: its address, and its point only when verified. */
const asPharmacy = (e: Entry) => ({
  name: e.name,
  address: e.address,
  latitude: e.location.latitude ?? Number.NaN,
  longitude: e.location.longitude ?? Number.NaN,
  locationVerified: e.location.status === "verified",
});

describe("Get Directions for every pharmacy of the directory", () => {
  it("renders a Get Directions and a View on Google Maps link for each, opening in a new tab safely", () => {
    for (const e of entries) {
      const { unmount } = render(<DirectionsActions pharmacy={asPharmacy(e)} origin={null} showView />);
      const directions = screen.getByRole("link", { name: `Get Directions to ${e.name}` });
      expect(directions.textContent).toContain("Get Directions");
      expect(directions.getAttribute("target")).toBe("_blank");
      expect(directions.getAttribute("rel")).toBe("noopener noreferrer");
      expect(directions.getAttribute("href")!.startsWith("https://www.google.com/maps/dir/?api=1&destination=")).toBe(true);
      const view = screen.getByRole("link", { name: `View ${e.name} on Google Maps` });
      expect(view.getAttribute("target")).toBe("_blank");
      expect(view.getAttribute("rel")).toBe("noopener noreferrer");
      unmount();
    }
  });

  it("sends each pharmacy to its own destination: its verified point, else its own address", () => {
    const hrefs = entries.map((e) => {
      const { unmount } = render(<DirectionsActions pharmacy={asPharmacy(e)} origin={null} />);
      const href = screen.getByRole("link", { name: /Get Directions/ }).getAttribute("href")!;
      unmount();
      return { e, href };
    });
    expect(new Set(hrefs.map((h) => h.href)).size).toBe(entries.length); // no two pharmacies share a destination
    for (const { e, href } of hrefs) {
      const destination = new URL(href).searchParams.get("destination");
      if (e.location.status === "verified") expect(destination).toBe(`${e.location.latitude},${e.location.longitude}`);
      else expect(destination).toBe(e.address); // address fallback, never a candidate point
    }
    // Only one entry has a verified point today; the others must all use their address.
    expect(hrefs.filter(({ e }) => e.location.status !== "verified").length).toBeGreaterThan(0);
    expect(hrefs.some(({ href }) => /destination=NaN/.test(href))).toBe(false);
  });

  it("adds the origin only when the user chose one", () => {
    const e = entries[0]!;
    render(<DirectionsActions pharmacy={asPharmacy(e)} origin={{ latitude: 19.1, longitude: 72.9 }} />);
    expect(new URL(screen.getByRole("link", { name: /Get Directions/ }).getAttribute("href")!).searchParams.get("origin")).toBe("19.1,72.9");
    cleanup();
    render(<DirectionsActions pharmacy={asPharmacy(e)} origin={null} />);
    expect(new URL(screen.getByRole("link", { name: /Get Directions/ }).getAttribute("href")!).searchParams.has("origin")).toBe(false);
  });

  it("renders nothing for a pharmacy with no destination", () => {
    const { container } = render(<DirectionsActions pharmacy={{ name: "Nowhere", address: "", latitude: Number.NaN, longitude: Number.NaN, locationVerified: false }} origin={null} />);
    expect(container.textContent).toBe("");
  });
});
