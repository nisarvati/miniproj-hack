import { describe, expect, it } from "vitest";
import { formatDistance, formatPrice, formatRelativeTime, pluralise } from "./format";

describe("pluralise", () => {
  it("handles pharmacy counts conversationally", () => {
    expect(pluralise(1, "pharmacy")).toBe("1 pharmacy");
    expect(pluralise(5, "pharmacy")).toBe("5 pharmacies");
  });
});

describe("formatPrice", () => {
  it("formats rupees, dropping .00", () => {
    expect(formatPrice(25)).toBe("₹25");
    expect(formatPrice(23.5)).toBe("₹23.50");
    expect(formatPrice(218.4)).toBe("₹218.40");
    expect(formatPrice(122.72)).toBe("₹122.72");
    expect(formatPrice(1250)).toBe("₹1,250");
  });
});

describe("formatDistance", () => {
  it("uses metres under 1 km and km otherwise", () => {
    expect(formatDistance(0)).toBe("Less than 100 m away");
    expect(formatDistance(0.43)).toBe("400 m away");
    expect(formatDistance(1.2)).toBe("1.2 km away");
    expect(formatDistance(8.54)).toBe("8.5 km away");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
  it("describes recent and older updates", () => {
    expect(formatRelativeTime(ago(10), now)).toBe("just now");
    expect(formatRelativeTime(ago(5 * 60), now)).toBe("5 min ago");
    expect(formatRelativeTime(ago(3 * 3600), now)).toBe("3 hr ago");
    expect(formatRelativeTime(ago(86400), now)).toBe("1 day ago");
    expect(formatRelativeTime(ago(3 * 86400), now)).toBe("3 days ago");
  });
  it("copes with invalid input", () => {
    expect(formatRelativeTime("garbage", now)).toBe("unknown");
  });
});
