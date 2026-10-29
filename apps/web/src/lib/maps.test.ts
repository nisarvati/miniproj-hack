import { describe, expect, it } from "vitest";
import { buildDirectionsUrl, directionsUrlFor, mapsDestination, mapsViewUrl } from "./maps";

const A = { name: "Bandra Medical Stores", address: "Shop No. 139, Hill Road, Bandra West, Mumbai 400050", latitude: 19.05548, longitude: 72.83152, locationVerified: true };
const B = { name: "Other Chemist", address: "1 Other Road, Andheri East, Mumbai 400069", latitude: 19.11118, longitude: 72.85865 };

describe("mapsDestination", () => {
  it("uses the pharmacy's own verified point", () => {
    expect(mapsDestination(A)).toBe("19.05548,72.83152");
    expect(mapsDestination(B)).toBe("19.11118,72.85865"); // the API not saying anything about verification means the point is used
  });

  it("never mixes up pharmacies", () => {
    expect(mapsDestination(A)).not.toBe(mapsDestination(B));
    expect(mapsDestination({ ...A, latitude: 19.2, longitude: 72.9 })).toBe("19.2,72.9");
  });

  it("falls back to the percent-encoded full address when the point is not verified or missing", () => {
    const encoded = encodeURIComponent(A.address);
    expect(mapsDestination({ ...A, locationVerified: false })).toBe(encoded);
    expect(encoded).toContain("%20");
    expect(encoded).toContain("%2C");
    expect(encoded).not.toContain(" ");
    expect(mapsDestination({ address: A.address, latitude: null, longitude: null })).toBe(encoded);
    expect(mapsDestination({ address: A.address, latitude: Number.NaN, longitude: Number.NaN })).toBe(encoded);
    expect(mapsDestination({ address: "Shop #5 & Co / Road?", latitude: undefined })).toBe(encodeURIComponent("Shop #5 & Co / Road?"));
  });

  it("refuses an impossible point and gives nothing when there is no honest destination", () => {
    expect(mapsDestination({ address: "", latitude: 95, longitude: 10 })).toBeNull();
    expect(mapsDestination({ address: "   ", locationVerified: false, latitude: 19, longitude: 72 })).toBeNull();
    expect(mapsDestination({})).toBeNull();
  });
});

describe("directionsUrlFor", () => {
  it("builds the standard Google Maps directions URL with the destination and no key", () => {
    expect(directionsUrlFor(null, A)).toBe("https://www.google.com/maps/dir/?api=1&destination=19.05548,72.83152");
    expect(directionsUrlFor(null, A)).not.toMatch(/key=/);
  });

  it("leaves the origin out unless the user specified one, so Google Maps uses their current location", () => {
    expect(new URL(directionsUrlFor(null, A)!).searchParams.has("origin")).toBe(false);
    expect(directionsUrlFor({ latitude: 19.1, longitude: 72.8 }, A)).toBe("https://www.google.com/maps/dir/?api=1&destination=19.05548,72.83152&origin=19.1,72.8");
  });

  it("uses the address for an unverified point, and the URL still round-trips", () => {
    const url = directionsUrlFor(null, { ...B, locationVerified: false })!;
    expect(url).toBe(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(B.address)}`);
    expect(new URL(url).searchParams.get("destination")).toBe(B.address);
  });

  it("returns null when the pharmacy has no destination", () => {
    expect(directionsUrlFor(null, {})).toBeNull();
  });

  it("keeps the old coordinate-only helper working", () => {
    const url = new URL(buildDirectionsUrl({ latitude: 1, longitude: 2 }, { latitude: 3.5, longitude: 4.5 }));
    expect(url.origin + url.pathname).toBe("https://www.google.com/maps/dir/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ api: "1", origin: "1,2", destination: "3.5,4.5" });
  });
});

describe("mapsViewUrl", () => {
  it("opens the pharmacy's own location, by point or by address", () => {
    expect(mapsViewUrl(A)).toBe("https://www.google.com/maps/search/?api=1&query=19.05548,72.83152");
    expect(mapsViewUrl({ ...A, locationVerified: false })).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(A.address)}`);
    expect(mapsViewUrl({})).toBeNull();
  });
});
