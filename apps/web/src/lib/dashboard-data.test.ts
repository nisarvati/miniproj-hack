import { describe, expect, it } from "vitest";
import type { NodeStatusEntry } from "./api";
import { addLagSample, bucketLabel, dayLabel, formatSpan, MAX_SAMPLES, niceMax, percentOf, sumBuckets, summarizeNodes } from "./dashboard-data";

const node = (over: Partial<NodeStatusEntry> = {}): NodeStatusEntry => ({
  pharmacyCode: "P001", name: "A", status: "healthy", statusReason: "", lastSyncedAt: null, syncLagMs: 1000, unpublishedOutbox: 0, staleCount: 0, duplicateCount: 0, processedCount: 10, ...over,
});

describe("summarizeNodes", () => {
  it("totals what pharmacies reported and counts statuses", () => {
    const s = summarizeNodes([node({ processedCount: 10, duplicateCount: 2, staleCount: 1, unpublishedOutbox: 3, syncLagMs: 2000 }), node({ pharmacyCode: "P002", status: "degraded", processedCount: 5, duplicateCount: 0, staleCount: 0, unpublishedOutbox: 4, syncLagMs: 4000 })]);
    expect(s.nodes).toBe(2);
    expect(s.byStatus).toEqual({ healthy: 1, degraded: 1, down: 0, unknown: 0 });
    expect(s.processed).toEqual({ value: 15, known: 2, of: 2 });
    expect(s.duplicates.value).toBe(2);
    expect(s.stale.value).toBe(1);
    expect(s.outbox.value).toBe(7);
    expect(s.averageSinceLastEventMs).toEqual({ value: 3000, known: 2, of: 2 });
  });

  it("never turns unknown into zero: a total says how many pharmacies it covers, and is null when none reported", () => {
    const partial = summarizeNodes([node({ processedCount: 10, unpublishedOutbox: null, syncLagMs: null }), node({ pharmacyCode: "P002", processedCount: null, unpublishedOutbox: null, syncLagMs: 6000 })]);
    expect(partial.processed).toEqual({ value: 10, known: 1, of: 2 });
    expect(partial.outbox).toEqual({ value: null, known: 0, of: 2 });
    expect(partial.averageSinceLastEventMs).toEqual({ value: 6000, known: 1, of: 2 });
    const none = summarizeNodes([node({ processedCount: null, duplicateCount: null, staleCount: null, syncLagMs: null })]);
    expect(none.processed.value).toBeNull();
    expect(none.duplicates.value).toBeNull();
    expect(none.averageSinceLastEventMs.value).toBeNull();
    expect(summarizeNodes([]).processed).toEqual({ value: null, known: 0, of: 0 });
  });

  it("ignores a nonsense lag (negative, not a number) instead of averaging it in", () => {
    const s = summarizeNodes([node({ syncLagMs: -5 }), node({ syncLagMs: Number.NaN }), node({ syncLagMs: 1000 })]);
    expect(s.averageSinceLastEventMs).toEqual({ value: 1000, known: 1, of: 3 });
  });
});

describe("small helpers", () => {
  it("percentOf is a whole percentage, and null rather than a division by zero", () => {
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(2, 3)).toBe(67);
    expect(percentOf(0, 0)).toBeNull();
  });

  it("niceMax gives an axis top that always contains the data and starts a scale even when everything is 0", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(Number.NaN)).toBe(1);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(10)).toBe(10);
    expect(niceMax(11)).toBe(20);
    expect(niceMax(0.3)).toBe(0.5);
    for (const v of [0.01, 1, 4.9, 99, 1234, 56_789]) expect(niceMax(v)).toBeGreaterThanOrEqual(v);
  });

  it("sumBuckets adds bucket by bucket and tolerates short arrays", () => {
    expect(sumBuckets([{ buckets: [1, 2, 3] }, { buckets: [4, 0] }], 3)).toEqual([5, 2, 3]);
    expect(sumBuckets([], 2)).toEqual([0, 0]);
  });

  it("formatSpan uses units that do not suggest false precision, and says Unknown for what it cannot say", () => {
    expect(formatSpan(null)).toBe("Unknown");
    expect(formatSpan(-1)).toBe("Unknown");
    expect(formatSpan(Number.NaN)).toBe("Unknown");
    expect(formatSpan(12_000)).toBe("12 s");
    expect(formatSpan(5 * 60_000)).toBe("5 min");
    expect(formatSpan(3 * 3_600_000)).toBe("3 h");
    expect(formatSpan(5 * 86_400_000)).toBe("5 days");
  });

  it("labels days in UTC and buckets in short times, and returns nothing for a bad date", () => {
    expect(dayLabel("2026-10-30")).toBe("30 Oct");
    expect(dayLabel("nope")).toBe("");
    expect(bucketLabel("2026-10-30T09:00:00.000Z", "UTC")).toBe("09:00");
    expect(bucketLabel("nope")).toBe("");
  });
});

describe("addLagSample", () => {
  const nodes = [node({ unpublishedOutbox: 2 }), node({ pharmacyCode: "P002", unpublishedOutbox: 3 })];
  it("records the backlog total, and null when no pharmacy reported one", () => {
    expect(addLagSample([], 1000, nodes)).toEqual([{ at: 1000, backlog: 5 }]);
    expect(addLagSample([], 1000, [node({ unpublishedOutbox: null })])).toEqual([{ at: 1000, backlog: null }]);
  });
  it("ignores a reading that is not newer than the last, and a bad time", () => {
    const one = addLagSample([], 1000, nodes);
    expect(addLagSample(one, 1000, nodes)).toBe(one);
    expect(addLagSample(one, 500, nodes)).toBe(one);
    expect(addLagSample(one, Number.NaN, nodes)).toBe(one);
    expect(addLagSample(one, 2000, nodes)).toHaveLength(2);
  });
  it("keeps only the most recent readings", () => {
    let s = addLagSample([], 1, nodes);
    for (let i = 2; i <= MAX_SAMPLES + 10; i++) s = addLagSample(s, i, nodes);
    expect(s).toHaveLength(MAX_SAMPLES);
    expect(s.at(-1)!.at).toBe(MAX_SAMPLES + 10);
    expect(s[0]!.at).toBe(11);
  });
});
