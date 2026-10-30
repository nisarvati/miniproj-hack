// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodesResponse, NodeStatusEntry } from "../../lib/api";
import { mockApi } from "../../test/utils";
import { DashboardPage } from "./DashboardPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GENERATED_AT = "2026-10-29T12:00:00.000Z";
const node = (over: Partial<NodeStatusEntry> = {}): NodeStatusEntry => ({
  pharmacyCode: "P001",
  name: "Alpha Chemist",
  status: "healthy",
  statusReason: "No events are waiting; the last event was processed.",
  lastSyncedAt: "2026-10-29T11:59:58.800Z",
  syncLagMs: 1200,
  unpublishedOutbox: 0,
  staleCount: 0,
  duplicateCount: 3,
  processedCount: 42,
  ...over,
});
const response = (data: NodeStatusEntry[], meta: Partial<NodesResponse["meta"]> = {}): { body: NodesResponse } => ({
  body: { data, meta: { generatedAt: GENERATED_AT, redis: "up", connector: "up", ...meta } },
});
/** The other things the page reads. A visitor who is not signed in gets no private figures; the network figures are unavailable here, which the page must say without breaking. */
const others = {
  "GET /api/analytics/network": () => ({ body: { data: { window: { hours: 24, bucketMinutes: 60, from: GENERATED_AT, to: GENERATED_AT, bucketStarts: [] }, events: { available: false, reason: "NOT_CONFIGURED" }, stock: { available: false, reason: "ERROR" } }, meta: { generatedAt: GENERATED_AT } } }),
  "GET /portal/me": () => ({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Sign in" } } }),
};
const card = (name: string) => screen.getByRole("group", { name: new RegExp(name) }) as HTMLElement;

describe("DashboardPage", () => {
  it("shows a card per pharmacy with its name, code, status, times and counts", async () => {
    mockApi({
      ...others,
      "GET /api/nodes": () =>
        response([
          node(),
          node({ pharmacyCode: "P002", name: "Beta Chemist", status: "degraded", syncLagMs: 83_000, processedCount: 7, duplicateCount: 0, staleCount: 2, unpublishedOutbox: 4 }),
        ]),
    });
    render(<DashboardPage />);
    expect(await screen.findByRole("heading", { level: 3, name: "Alpha Chemist" })).toBeTruthy();
    const a = within(card("Alpha Chemist"));
    expect(a.getByText("Pharmacy P001")).toBeTruthy();
    expect(a.getByText("Healthy")).toBeTruthy();
    expect(a.getByText("1.2 s")).toBeTruthy(); // lag, with its unit
    expect(a.getByText("42")).toBeTruthy();
    expect(a.getByText("3")).toBeTruthy();
    expect(a.getByText("just now")).toBeTruthy(); // 1.2 s before the response
    const b = within(card("Beta Chemist"));
    expect(b.getByText("Degraded")).toBeTruthy();
    expect(b.getByText("1 min 23 s")).toBeTruthy();
    expect(b.getByText("4")).toBeTruthy(); // outbox
    expect(screen.getByText("Showing 2 pharmacies")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Pharmacy synchronization status" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("explains that MedLink is eventually consistent and promises no delivery time", async () => {
    mockApi({ ...others, "GET /api/nodes": () => response([node()]) });
    render(<DashboardPage />);
    await screen.findByText("Alpha Chemist");
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/eventually consistent/);
    expect(text).toMatch(/not instantly/);
    expect(text).not.toMatch(/within \d+ ?(s|sec|seconds)\b|guaranteed|real[- ]time/i);
  });

  it("shows a loading state first", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<DashboardPage />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading pharmacy status/);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows an error with a retry that loads the data", async () => {
    let up = false;
    const api = mockApi({ ...others, "GET /api/nodes": () => (up ? response([node()]) : { status: 503, body: { error: { code: "X", message: "down" } } }) });
    render(<DashboardPage />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/temporarily unavailable/);
    up = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Alpha Chemist")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.calls.filter((c) => c.path === "/api/nodes")).toHaveLength(2);
  });

  it("shows an empty state when no pharmacy is configured", async () => {
    mockApi({ ...others, "GET /api/nodes": () => response([]) });
    render(<DashboardPage />);
    expect(await screen.findByRole("heading", { name: "No pharmacies are configured" })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("labels unknown and unavailable metrics instead of showing zero", async () => {
    mockApi({
      ...others,
      "GET /api/nodes": () =>
        response([node({ pharmacyCode: "P003", name: "Gamma Chemist", status: "unknown", statusReason: "No event has been synchronized for this pharmacy yet.", lastSyncedAt: null, syncLagMs: null, unpublishedOutbox: null, staleCount: null, duplicateCount: null, processedCount: null })]),
    });
    render(<DashboardPage />);
    await screen.findByText("Gamma Chemist");
    const g = within(card("Gamma Chemist"));
    expect(g.getByText("Never / unknown")).toBeTruthy();
    expect(g.getByText("Not available")).toBeTruthy();
    expect(g.getAllByText("Unknown").length).toBeGreaterThanOrEqual(5); // lag, three counts, and the status itself
    expect(g.queryByText("0")).toBeNull();
    expect(g.getByText(/No event has been synchronized/)).toBeTruthy();
  });

  it("gives every status a text label, not only a colour", async () => {
    mockApi({
      ...others,
      "GET /api/nodes": () =>
        response([
          node({ pharmacyCode: "P001", name: "A1", status: "healthy" }),
          node({ pharmacyCode: "P002", name: "A2", status: "degraded" }),
          node({ pharmacyCode: "P003", name: "A3", status: "down" }),
          node({ pharmacyCode: "P004", name: "A4", status: "unknown" }),
        ]),
    });
    render(<DashboardPage />);
    await screen.findByText("A1");
    for (const [name, label] of [["A1", "Healthy"], ["A2", "Degraded"], ["A3", "Down"], ["A4", "Unknown"]] as const) {
      const c = within(card(name));
      expect(c.getByText(label).textContent).toBe(`Status: ${label}`);
    }
  });

  it("says plainly when the status store cannot be read, and that nothing is healthy", async () => {
    mockApi({ ...others, "GET /api/nodes": () => response([node({ status: "unknown", lastSyncedAt: null, syncLagMs: null, processedCount: null, staleCount: null, duplicateCount: null, unpublishedOutbox: null })], { redis: "down", connector: "unreachable" }) });
    render(<DashboardPage />);
    expect(await screen.findByText(/can't read synchronization status/)).toBeTruthy();
    expect(screen.getByText(/not healthy/)).toBeTruthy();
    expect(screen.queryByText("Healthy")).toBeNull();
  });

  it("warns when the sync service cannot be reached, so unknown is not mistaken for a fault in the pharmacy", async () => {
    mockApi({ ...others, "GET /api/nodes": () => response([node({ status: "unknown", statusReason: "No events are waiting, but the sync service could not be reached to confirm it is running." })], { syncService: "unreachable" }) });
    render(<DashboardPage />);
    expect(await screen.findByText("The sync service could not be reached")).toBeTruthy();
    expect(screen.getByText(/shown as unknown/)).toBeTruthy();
    expect(screen.queryByText("Healthy")).toBeNull();
  });

  it("notes when only the outbox counts are unavailable", async () => {
    mockApi({ ...others, "GET /api/nodes": () => response([node({ unpublishedOutbox: null })], { connector: "unreachable" }) });
    render(<DashboardPage />);
    expect(await screen.findByText(/Waiting-in-outbox counts are not available because the inventory connector could not be reached/)).toBeTruthy();
    expect(within(card("Alpha Chemist")).getByText("Healthy")).toBeTruthy(); // (the overview table shows it too)
  });

  it("refreshes on request and shows the new readings", async () => {
    let n = 0;
    const api = mockApi({ ...others, "GET /api/nodes": () => response([node({ processedCount: 10 + 5 * n++ })]) });
    render(<DashboardPage />);
    expect(await within(await screen.findByRole("group", { name: /Alpha Chemist/ })).findByText("10")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(within(card("Alpha Chemist")).getByText("15")).toBeTruthy());
    expect(api.calls.filter((c) => c.path === "/api/nodes")).toHaveLength(2);
  });
});
