import { afterEach, describe, expect, it } from "vitest";
import { addDays, addMonths, dayLabel, gridRange, monthGrid, monthLabel, parseIso, shortDayLabel, todayIso, toIso } from "./calendar-dates";

const original = process.env.TZ;
afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

describe("calendar days", () => {
  it("formats and parses plain days", () => {
    expect(toIso(2026, 3, 9)).toBe("2026-03-09");
    expect(parseIso("2026-03-09")).toEqual({ year: 2026, month: 3, day: 9 });
  });

  it("builds six whole weeks, Sunday first, with the month's own days marked", () => {
    const grid = monthGrid(2026, 11); // 1 Nov 2026 is a Sunday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ iso: "2026-11-01", day: 1, inMonth: true });
    expect(grid.filter((d) => d.inMonth)).toHaveLength(30);
    expect(grid[41]!.iso).toBe("2026-12-12");
    const feb = monthGrid(2028, 2); // a leap February that starts on a Tuesday
    expect(feb[0]!.iso).toBe("2028-01-30");
    expect(feb.filter((d) => d.inMonth)).toHaveLength(29);
  });

  it("asks the server for exactly the days the grid shows, which is always within the API's range limit", () => {
    for (const [y, m] of [[2026, 11], [2028, 2], [2026, 2], [2100, 12], [2000, 1]] as const) {
      const { from, to } = gridRange(y, m);
      expect((Date.parse(to) - Date.parse(from)) / 86_400_000).toBe(41);
    }
  });

  it("moves between months across year ends", () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths(2026, 3, 14)).toEqual({ year: 2027, month: 5 });
  });

  it("gives the same days and labels in any timezone", () => {
    for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "Asia/Kolkata", "UTC"]) {
      process.env.TZ = tz;
      expect(monthGrid(2026, 3)[0]!.iso).toBe("2026-03-01"); // 1 March 2026 is a Sunday
      expect(dayLabel("2026-11-10")).toMatch(/^Tuesday,? 10 November 2026$/); // the comma depends on the ICU version
      expect(shortDayLabel("2026-11-10")).toBe("10 Nov 2026");
      expect(monthLabel(2026, 11)).toBe("November 2026");
    }
  });

  it("today is the day on the person's own clock, not the UTC day", () => {
    expect(todayIso(new Date(2026, 10, 10, 23, 59, 59))).toBe("2026-11-10");
    expect(todayIso(new Date(2026, 10, 10, 0, 0, 1))).toBe("2026-11-10");
  });
});

describe("addDays", () => {
  it("steps across month, year and leap-day boundaries as plain calendar days", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2026-11-10", 7)).toBe("2026-11-17");
    expect(addDays("2026-11-10", 0)).toBe("2026-11-10");
  });

  it("gives the same answer in any timezone, including across a daylight-saving change", () => {
    for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "Europe/London", "UTC"]) {
      process.env.TZ = tz;
      expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
      expect(addDays("2026-10-24", 2)).toBe("2026-10-26");
    }
  });
});
