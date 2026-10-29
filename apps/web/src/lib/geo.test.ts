import { describe, expect, it } from "vitest";
import { haversineKm } from "./geo";

describe("haversineKm", () => {
  it("is zero for the same point and symmetric", () => {
    const a = { latitude: 19.1364, longitude: 72.8296 };
    const b = { latitude: 19.0596, longitude: 72.8295 };
    expect(haversineKm(a, a)).toBe(0);
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 10);
  });

  it("matches a known distance: Andheri West to Bandra West is about 8.5 km", () => {
    const d = haversineKm({ latitude: 19.1364, longitude: 72.8296 }, { latitude: 19.0596, longitude: 72.8295 });
    expect(d).toBeGreaterThan(8.3);
    expect(d).toBeLessThan(8.7);
  });

  it("one degree of latitude is about 111 km", () => {
    expect(haversineKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(111.2, 0);
  });
});
