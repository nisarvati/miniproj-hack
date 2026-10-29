// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodesResponse, NodeStatusEntry } from "../../lib/api";
import { FakeEventSource, nodeEvent } from "../../test/fake-event-source";
import { mockApi } from "../../test/utils";
import { DashboardPage } from "./DashboardPage";

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FETCHED_AT = "2026-10-29T12:00:00.000Z";
const node = (over: Partial<NodeStatusEntry> = {}): NodeStatusEntry => ({
  pharmacyCode: "P001", name: "Alpha Chemist", status: "healthy", statusReason: "No events are waiting; the last event was processed.",
  lastSyncedAt: "2026-10-29T11:59:00.000Z", syncLagMs: 60_000, unpublishedOutbox: 0, staleCount: 0, duplicateCount: 3, processedCount: 42, ...over,
});
const body = (data: NodeStatusEntry[], meta: Partial<NodesResponse["meta"]> = {}) => ({ body: { data, meta: { generatedAt: FETCHED_AT, redis: "up", connector: "up", syncService: "ready", ...meta } } });
const card = (name: string) => within(screen.getByRole("group", { name: new RegExp(name) }));
const setup = (nodes = [node(), node({ pharmacyCode: "P002", name: "Beta Chemist" })]) => {
  const api = mockApi({ "GET /api/nodes": () => body(nodes) });
  render(<DashboardPage />);
  return api;
};
const live = () => document.querySelector("[data-live-state]")!.getAttribute("data-live-state");
const send = (type: string, data: unknown, id = "") => act(() => FakeEventSource.last.emit(type, data, id));

describe("the dashboard's live updates", () => {
  it("shows the connection state: connecting, then live, then reconnecting", async () => {
    setup();
    await screen.findByText("Alpha Chemist");
    expect(live()).toBe("connecting");
    expect(document.querySelector("[data-live-state]")!.textContent).toMatch(/Connecting/);
    send("connected", { version: 1, resync: false });
    expect(live()).toBe("connected");
    expect(document.querySelector("[data-live-state]")!.textContent).toMatch(/Live updates: Live/);
    act(() => FakeEventSource.last.fail(false));
    expect(live()).toBe("reconnecting");
    expect(document.querySelector("[data-live-state]")!.textContent).toMatch(/Reconnecting/);
  });

  it("updates a card from a node event without asking the API again", async () => {
    const api = setup();
    await screen.findByText("Alpha Chemist");
    send("connected", { version: 1, resync: false });
    expect(card("Alpha Chemist").getByText("Healthy")).toBeTruthy();
    send("node", nodeEvent({ status: "down", statusReason: "The connector cannot reach this pharmacy's database.", processedCount: 50, syncLagMs: 90_000 }), "b.1");
    expect(card("Alpha Chemist").getByText("Down")).toBeTruthy();
    expect(card("Alpha Chemist").getByText("50")).toBeTruthy();
    expect(card("Alpha Chemist").getByText(/cannot reach this pharmacy/)).toBeTruthy();
    expect(card("Beta Chemist").getByText("Healthy")).toBeTruthy(); // the other card is untouched
    expect(api.count("GET", "/api/nodes")).toBe(1);
  });

  it("shows when the live data is from, and that the status store is unavailable if a node event says so", async () => {
    setup();
    await screen.findByText("Alpha Chemist");
    send("node", nodeEvent({ status: "unknown", lastSyncedAt: null, syncLagMs: null, processedCount: null, staleCount: null, duplicateCount: null, unpublishedOutbox: null }, { redis: "down" }));
    expect(await screen.findByText(/can't read synchronization status/)).toBeTruthy();
    expect(card("Alpha Chemist").getByText("Unknown", { selector: "span.inline-flex" })).toBeTruthy();
  });

  it("ignores a node event that is older than what the page already has", async () => {
    setup();
    await screen.findByText("Alpha Chemist");
    send("node", nodeEvent({ status: "down", processedCount: 7 }, { generatedAt: "2026-10-29T11:00:00.000Z" }));
    expect(card("Alpha Chemist").getByText("Healthy")).toBeTruthy();
    expect(card("Alpha Chemist").queryByText("7")).toBeNull();
  });

  it("lets a manual Refresh win over earlier live updates", async () => {
    let n = 0;
    mockApi({ "GET /api/nodes": () => body([node({ status: n++ === 0 ? "healthy" : "degraded", pharmacyCode: "P001" })], n > 1 ? { generatedAt: "2026-10-29T12:30:00.000Z" } : {}) });
    render(<DashboardPage />);
    await screen.findByText("Alpha Chemist");
    send("node", nodeEvent({ status: "down" }, { generatedAt: "2026-10-29T12:10:00.000Z" }));
    expect(card("Alpha Chemist").getByText("Down")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await within(await screen.findByRole("group", { name: /Alpha/ })).findByText("Degraded")).toBeTruthy();
  });

  it("reads the API again after a reconnect, once, and not for the first connection", async () => {
    const api = setup();
    await screen.findByText("Alpha Chemist");
    send("connected", { version: 1, resync: false });
    expect(api.count("GET", "/api/nodes")).toBe(1);
    act(() => FakeEventSource.last.fail(false));
    send("connected", { version: 1, resync: false });
    await vi.waitFor(() => expect(api.count("GET", "/api/nodes")).toBe(2));
    send("node", nodeEvent(), "b.2"); // events after that do not refetch
    expect(api.count("GET", "/api/nodes")).toBe(2);
  });

  it("ignores malformed and unrelated events", async () => {
    const api = setup();
    await screen.findByText("Alpha Chemist");
    send("node", "{broken");
    send("node", nodeEvent({ status: "melting" }));
    send("alert", { version: 1, anything: true });
    send("stock", { version: 1, medicineCode: "M001" });
    expect(card("Alpha Chemist").getByText("Healthy")).toBeTruthy();
    expect(api.count("GET", "/api/nodes")).toBe(1);
  });

  it("does not apply the same event twice", async () => {
    setup();
    await screen.findByText("Alpha Chemist");
    send("node", nodeEvent({ processedCount: 60 }), "b.5");
    expect(card("Alpha Chemist").getByText("60")).toBeTruthy();
    send("node", nodeEvent({ processedCount: 61 }), "b.5"); // same id: a replay, ignored
    expect(card("Alpha Chemist").queryByText("61")).toBeNull();
  });

  it("opens one connection and closes it when the page is left", async () => {
    setup();
    const { unmount } = { unmount: () => cleanup() };
    await screen.findByText("Alpha Chemist");
    expect(FakeEventSource.instances).toHaveLength(1);
    const es = FakeEventSource.last;
    unmount();
    expect(es.closed).toBe(true);
  });

  it("keeps working, and says live updates are off, when the browser has no EventSource", async () => {
    vi.unstubAllGlobals();
    mockApi({ "GET /api/nodes": () => body([node()]) });
    render(<DashboardPage />);
    expect(await screen.findByText("Alpha Chemist")).toBeTruthy();
    expect(live()).toBe("disconnected");
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
  });
});
