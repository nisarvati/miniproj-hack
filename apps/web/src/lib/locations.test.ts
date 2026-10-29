import { describe, expect, it } from "vitest";
import { AREAS, parseCoordinates } from "./locations";
import { buildDirectionsUrl } from "./maps";

describe("parseCoordinates", () => {
  it("accepts valid decimals, including boundaries", () => {
    expect(parseCoordinates(" 19.1364 ", "72.8296")).toEqual({ ok: true, location: { latitude: 19.1364, longitude: 72.8296 } });
    expect(parseCoordinates("-90", "180")).toMatchObject({ ok: true });
  });
  it.each([
    ["", ""],
    ["abc", "72"],
    ["19", ""],
    ["0x10", "72"],
    ["1e1", "72"],
  ])("rejects non-decimal input (%j, %j)", (lat, lng) => {
    expect(parseCoordinates(lat, lng)).toMatchObject({ ok: false });
  });
  it("rejects out-of-range values with a specific message", () => {
    expect(parseCoordinates("91", "0")).toMatchObject({ ok: false, error: expect.stringContaining("Latitude") });
    expect(parseCoordinates("0", "-181")).toMatchObject({ ok: false, error: expect.stringContaining("Longitude") });
  });
});

describe("AREAS", () => {
  it("have unique ids and valid coordinates", () => {
    expect(new Set(AREAS.map((a) => a.id)).size).toBe(AREAS.length);
    for (const a of AREAS) expect(parseCoordinates(String(a.latitude), String(a.longitude))).toMatchObject({ ok: true });
  });
});

describe("buildDirectionsUrl", () => {
  it("builds a Google Maps directions link", () => {
    const url = new URL(buildDirectionsUrl({ latitude: 1, longitude: 2 }, { latitude: 3.5, longitude: 4.5 }));
    expect(url.origin + url.pathname).toBe("https://www.google.com/maps/dir/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ api: "1", origin: "1,2", destination: "3.5,4.5" });
  });
  it("omits the origin when unknown", () => {
    expect(new URL(buildDirectionsUrl(null, { latitude: 3, longitude: 4 })).searchParams.has("origin")).toBe(false);
  });
});
