import { describe, expect, it } from "vitest";
import { haversineKm } from "../src/modules/geo/haversine.js";

const p = (latitude: number, longitude: number) => ({ latitude, longitude });

describe("haversineKm", () => {
  it("is 0 for identical points", () => {
    expect(haversineKm(p(19.1364, 72.8296), p(19.1364, 72.8296))).toBe(0);
  });
  it("is ~111.19 km per degree of latitude", () => {
    expect(haversineKm(p(0, 0), p(1, 0))).toBeCloseTo(111.19, 1);
  });
  it("matches a known city pair (London - Paris ~343.5 km)", () => {
    expect(haversineKm(p(51.5074, -0.1278), p(48.8566, 2.3522))).toBeCloseTo(343.5, 0);
  });
  it("matches a known local pair (Andheri West - Bandra West ~8.5 km)", () => {
    expect(haversineKm(p(19.1364, 72.8296), p(19.0596, 72.8295))).toBeCloseTo(8.54, 1);
  });
  it("is symmetric", () => {
    const a = p(19.1, 72.8);
    const b = p(28.6, 77.2);
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });
  it("handles antipodal points and the antimeridian without NaN", () => {
    expect(haversineKm(p(0, 0), p(0, 180))).toBeCloseTo(20015.1, 0);
    expect(haversineKm(p(10, 179.5), p(10, -179.5))).toBeLessThan(120);
  });
});
