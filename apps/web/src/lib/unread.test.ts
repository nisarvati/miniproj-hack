import { beforeEach, describe, expect, it } from "vitest";
import type { UserNotification } from "./api";
import { countUnread, loadLastSeen, newestId, saveLastSeen } from "./unread";

const n = (id: number): UserNotification => ({ id, message: "m", createdAt: "x", deliveredAt: null });

describe("unread notifications", () => {
  it("counts the ones newer than the last seen", () => {
    expect(countUnread([n(5), n(4), n(3)], 3)).toBe(2);
    expect(countUnread([n(5)], 5)).toBe(0);
    expect(countUnread([], 0)).toBe(0);
    expect(countUnread([n(1), n(2)], 0)).toBe(2);
  });

  it("finds the newest id", () => {
    expect(newestId([n(2), n(9), n(4)])).toBe(9);
    expect(newestId([])).toBe(0);
  });

  describe("remembering what was seen", () => {
    const store = new Map<string, string>();
    beforeEach(() => {
      store.clear();
      const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
      Object.defineProperty(globalThis, "window", { value: { localStorage: fake }, configurable: true });
    });

    it("is kept per email", () => {
      saveLastSeen("a@example.com", 7);
      expect(loadLastSeen("a@example.com")).toBe(7);
      expect(loadLastSeen("b@example.com")).toBe(0);
    });

    it("ignores garbage", () => {
      store.set("medlink:seen:a@example.com", "not a number");
      expect(loadLastSeen("a@example.com")).toBe(0);
    });
  });
});
