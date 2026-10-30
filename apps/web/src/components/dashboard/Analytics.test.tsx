// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NetworkAnalytics, NodesResponse, NodeStatusEntry } from "../../lib/api";
import type { PortalAnalytics } from "../../lib/portal";
import { FakeEventSource, nodeEvent, stockEvent } from "../../test/fake-event-source";
import { mockApi } from "../../test/utils";
import { DashboardPage } from "./DashboardPage";

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const AT = "2026-10-29T12:00:00.000Z";
const node = (over: Partial<NodeStatusEntry> = {}): NodeStatusEntry => ({
  pharmacyCode: "P001", name: "Alpha Chemist", status: "healthy", statusReason: "caught up", lastSyncedAt: "2026-10-29T11:59:00.000Z", syncLagMs: 60_000, unpublishedOutbox: 0, staleCount: 1, duplicateCount: 3, processedCount: 42, ...over,
});
const NODES = [node(), node({ pharmacyCode: "P002", name: "Beta Chemist", status: "degraded", processedCount: 8, duplicateCount: 0, staleCount: 0, unpublishedOutbox: 2, syncLagMs: 90_000 })];
const nodesBody = (data = NODES, meta: Partial<NodesResponse["meta"]> = {}) => ({ body: { data, meta: { generatedAt: AT, redis: "up", connector: "up", syncService: "ready", ...meta } } });
const starts = Array.from({ length: 24 }, (_, i) => new Date(Date.parse("2026-10-28T12:00:00.000Z") + i * 3_600_000).toISOString());
const networkBody = (over: Partial<NetworkAnalytics["data"]> = {}) => ({
  body: {
    data: {
      window: { hours: 24, bucketMinutes: 60, from: starts[0]!, to: AT, bucketStarts: starts },
      events: { available: true, truncated: false, byPharmacy: [{ pharmacyCode: "P001", total: 5, buckets: starts.map((_, i) => (i === 3 ? 5 : 0)) }, { pharmacyCode: "P002", total: 2, buckets: starts.map((_, i) => (i === 4 ? 2 : 0)) }] },
      stock: { available: true, live: true, threshold: 5, byPharmacy: [{ pharmacyCode: "P001", inStock: 6, lowStock: 3, outOfStock: 1, listings: 10 }, { pharmacyCode: "P002", inStock: 8, lowStock: 1, outOfStock: 0, listings: 9 }] },
      ...over,
    },
    meta: { generatedAt: AT },
  },
});
const dates = Array.from({ length: 14 }, (_, i) => `2026-10-${String(16 + i).padStart(2, "0")}`);
const mineBody = (over: Partial<PortalAnalytics> = {}) => ({
  body: {
    data: {
      pharmacyCode: "P001", generatedAt: AT, range: { days: 14, from: AT, to: AT, timeZone: "UTC" },
      movements: { available: true, daily: dates.map((date, i) => ({ date, salesUnits: i === 13 ? 9 : 0, salesTransactions: i === 13 ? 2 : 0, restockUnits: i === 12 ? 30 : 0, restockTransactions: i === 12 ? 1 : 0 })), totals: { salesUnits: 9, salesTransactions: 2, restockUnits: 30, restockTransactions: 1 }, stockCountAdjustments: 0 },
      topSold: { available: true, items: [{ medicineCode: "M001", medicineName: "Crocin 500mg", units: 7, transactions: 1 }, { medicineCode: "M003", medicineName: "Dolo 650mg", units: 2, transactions: 1 }] },
      stock: { available: true, total: 10, inStock: 6, lowStock: 3, outOfStock: 1, threshold: 5 },
      risk: { available: true, byLevel: { LOW: 5, MODERATE: 2, HIGH: 2, CRITICAL: 1, UNKNOWN: 0 }, total: 10, threshold: 5 },
      alerts: { available: true, active: 4, resolvedInRange: 1, openedInRange: 5 },
      plans: { available: true, byStatus: { PLANNED: 2, IN_PROGRESS: 1, COMPLETED: 3, CANCELLED: 1 }, open: 3, overdue: 1 },
      ...over,
    },
    meta: { generatedAt: AT },
  },
});
const STAFF = { body: { data: { email: "a@pharmacy.test", role: "STAFF", pharmacy: { code: "P001", name: "Alpha Chemist" } }, meta: {} } };
const SIGNED_OUT = { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Sign in" } } };

type Routes = Parameters<typeof mockApi>[0];
const setup = (extra: Routes = {}) => {
  const api = mockApi({ "GET /api/nodes": () => nodesBody(), "GET /api/analytics/network": () => networkBody(), "GET /portal/me": () => SIGNED_OUT, ...extra });
  render(<DashboardPage />);
  return api;
};
const kpi = (title: string) => within(screen.getByRole("group", { name: title }));
const send = (type: string, data: unknown, id = "") => act(() => FakeEventSource.last.emit(type, data, id));

describe("the overview", () => {
  it("shows the header, and figures that say what they measure", async () => {
    setup();
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("MedLink Analytics");
    expect(screen.getByText("Pharmacy network, inventory and synchronization insights.")).toBeTruthy();
    await screen.findByRole("group", { name: "Pharmacy nodes" });
    expect(kpi("Pharmacy nodes").getByText("2")).toBeTruthy();
    expect(kpi("Healthy nodes").getByText("1 of 2")).toBeTruthy();
    expect(kpi("Healthy nodes").getByText("1 degraded · 0 down · 0 unknown")).toBeTruthy();
    expect(kpi("Events processed").getByText("50")).toBeTruthy();
    expect(kpi("Waiting in outboxes").getByText("2")).toBeTruthy();
    expect(kpi("Since last event").getByText("1 min")).toBeTruthy(); // the mean of 60 s and 90 s, in words
    expect(kpi("Since last event").getByText(/Not the delay of a change/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
    expect(document.querySelector("[data-live-state]")).toBeTruthy();
  });

  it("marks what cannot be read as unavailable or partial, and never as zero", async () => {
    setup({ "GET /api/nodes": () => nodesBody([node({ processedCount: null, unpublishedOutbox: null, syncLagMs: null }), node({ pharmacyCode: "P002", name: "Beta Chemist", processedCount: 8, unpublishedOutbox: null, syncLagMs: 5000 })]) });
    await screen.findByRole("group", { name: "Pharmacy nodes" });
    expect(kpi("Events processed").getByText("8")).toBeTruthy();
    expect(kpi("Events processed").getByText("Counted for 1 of 2 pharmacies only")).toBeTruthy();
    expect(kpi("Waiting in outboxes").getByText("Unavailable")).toBeTruthy();
    expect(kpi("Waiting in outboxes").getByText("The inventory connector could not be reached")).toBeTruthy();
    expect(kpi("Since last event").getByText("Known for 1 of 2 pharmacies")).toBeTruthy();
  });

  it("says Unavailable when no pharmacy reported a count", async () => {
    setup({ "GET /api/nodes": () => nodesBody([node({ processedCount: null, duplicateCount: null, staleCount: null, unpublishedOutbox: null, syncLagMs: null, status: "unknown" })], { redis: "down" }) });
    await screen.findByRole("group", { name: "Pharmacy nodes" });
    expect(kpi("Events processed").getByText("Unavailable")).toBeTruthy();
    expect(kpi("Since last event").getByText("Unknown")).toBeTruthy();
    expect(kpi("Healthy nodes").getByText("0 of 1")).toBeTruthy();
    expect(screen.getByText(/can't read synchronization status/)).toBeTruthy();
    expect(screen.getByText("No pharmacy has reported event counts, so nothing is charted. Unknown is not zero.")).toBeTruthy();
  });

  it("shows only one loading status while loading, and no charts yet", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<DashboardPage />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByRole("group", { name: "Pharmacy nodes" })).toBeNull();
  });
});

describe("a visitor who is not signed in", () => {
  it("sees the public network figures and charts, and is told what is private, without any private request being answered with data", async () => {
    const api = setup();
    await screen.findByRole("img", { name: /Stock availability across 2 pharmacies/ });
    expect(screen.getByRole("img", { name: /Events published per 60 minutes, last 24 hours/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Events processed, duplicate and stale, per pharmacy" })).toBeTruthy();
    expect((await screen.findAllByText(/shown only to that pharmacy's signed-in staff/)).length).toBe(2); // the inventory section and the restock section
    expect(screen.queryByRole("img", { name: /Units sold and restocked/ })).toBeNull();
    expect(screen.queryByText("Most frequently sold")).toBeNull();
    expect(kpi("Alerts and plans").getByText("Private")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Sign in/ }).length).toBeGreaterThan(0);
    expect(api.calls.some((c) => c.path === "/portal/analytics")).toBe(false);
  });

  it("explains that published events are not processed events, and that stock risk, node health and event health are different things", async () => {
    setup();
    await screen.findByText("Events published to the stream");
    expect(screen.getByText(/This is published, not processed/)).toBeTruthy();
    expect(screen.getByText("Three different kinds of health")).toBeTruthy();
    expect(screen.getByText("Event processing")).toBeTruthy();
    expect(screen.getByText("Pharmacy node")).toBeTruthy();
    expect(screen.getByText("Medicine stock risk")).toBeTruthy();
  });

  it("says plainly when event activity or stock cannot be read, instead of drawing zeros", async () => {
    setup({ "GET /api/analytics/network": () => networkBody({ events: { available: false, reason: "NOT_CONFIGURED" }, stock: { available: false, reason: "ERROR" } }) });
    expect(await screen.findByText(/Event activity is switched off on this server/)).toBeTruthy();
    expect(screen.getAllByText(/Nothing is shown rather than a zero/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("img", { name: /Events published per/ })).toBeNull();
    expect(screen.queryByRole("img", { name: /Stock availability across/ })).toBeNull();
  });

  it("notes when the stream's counts were capped", async () => {
    setup({ "GET /api/analytics/network": () => networkBody({ events: { available: true, truncated: true, byPharmacy: [{ pharmacyCode: "P001", total: 5000, buckets: starts.map(() => 208) }] } }) });
    expect(await screen.findByText(/capped at 5,000 entries per pharmacy/)).toBeTruthy();
  });

  it("says an empty window is empty, not broken", async () => {
    setup({ "GET /api/analytics/network": () => networkBody({ events: { available: true, truncated: false, byPharmacy: [{ pharmacyCode: "P001", total: 0, buckets: starts.map(() => 0) }] } }) });
    expect(await screen.findByText("No events were published in the last 24 hours.")).toBeTruthy();
  });

  it("keeps the rest of the page when the network figures fail, and recovers with Try again", async () => {
    let up = false;
    setup({ "GET /api/analytics/network": () => (up ? networkBody() : { status: 503, body: { error: { code: "X", message: "down" } } }) });
    expect((await screen.findAllByText("We couldn't load the network figures")).length).toBe(1);
    expect(screen.getByRole("group", { name: "Pharmacy nodes" })).toBeTruthy(); // the node figures are unaffected
    expect(screen.getByRole("group", { name: /Alpha Chemist/ })).toBeTruthy();
    up = true;
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    expect(await screen.findByRole("img", { name: /Stock availability across/ })).toBeTruthy();
    expect(screen.queryByText("We couldn't load the network figures")).toBeNull();
  });

  it("changes the time window and asks for it", async () => {
    const api = setup();
    await screen.findByRole("img", { name: /Events published per/ });
    await userEvent.click(screen.getByRole("button", { name: "72 h" }));
    await waitFor(() => expect(api.calls.some((c) => c.path === "/api/analytics/network" && c.search.get("hours") === "72")).toBe(true));
  });
});

describe("pharmacy staff", () => {
  const staffSetup = (mine: () => ReturnType<typeof mineBody> = () => mineBody()) => setup({ "GET /portal/me": () => STAFF, "GET /portal/analytics": mine });

  it("sees their own pharmacy's movements, top sellers, risk, alerts and plans", async () => {
    const api = staffSetup();
    expect(await screen.findByRole("img", { name: "Units sold and restocked per day, last 14 days" })).toBeTruthy();
    expect(screen.getByText(/Your pharmacy:/).textContent).toMatch(/Alpha Chemist.*P001/);
    expect(screen.getByText("9 units sold in 2 sales; 30 units received in 1 restocks.", { exact: false })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Most sold medicines" })).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Crocin 500mg7 units", "Dolo 650mg2 units"]);
    expect(screen.getByRole("img", { name: "Stock-risk levels" })).toBeTruthy();
    expect(screen.getByText("Critical").closest("li")!.textContent).toBe("Critical1 · 10%");
    expect(await screen.findByRole("img", { name: "Restock plans by status" })).toBeTruthy();
    expect(within(document.getElementById("restock")!).getByText(/overdue/, { selector: "p" }).textContent).toMatch(/1 overdue/);
    expect(kpi("Your active alerts").getByText("4")).toBeTruthy();
    expect(kpi("Your open restock plans").getByText("3")).toBeTruthy();
    expect(kpi("Your open restock plans").getByText("1 overdue")).toBeTruthy();
    expect(api.calls.filter((c) => c.path === "/portal/analytics")[0]!.search.get("days")).toBe("14");
  });

  it("changes the date range and asks for it", async () => {
    const api = staffSetup();
    await screen.findByRole("img", { name: /Units sold and restocked per day/ });
    await userEvent.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => expect(api.calls.some((c) => c.path === "/portal/analytics" && c.search.get("days") === "30")).toBe(true));
  });

  it("says when nothing was recorded, rather than drawing an empty chart", async () => {
    staffSetup(() => mineBody({ movements: { available: true, daily: dates.map((date) => ({ date, salesUnits: 0, salesTransactions: 0, restockUnits: 0, restockTransactions: 0 })), totals: { salesUnits: 0, salesTransactions: 0, restockUnits: 0, restockTransactions: 0 }, stockCountAdjustments: 0 }, topSold: { available: true, items: [] }, plans: { available: true, byStatus: { PLANNED: 0, IN_PROGRESS: 0, COMPLETED: 0, CANCELLED: 0 }, open: 0, overdue: 0 } }));
    expect(await screen.findByText(/No sales or restocks were recorded in these 14 days/)).toBeTruthy();
    expect(screen.getByText("No sales were recorded in this range.")).toBeTruthy();
    expect(screen.getByText(/No restock plans yet/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: /Units sold and restocked/ })).toBeNull();
  });

  it("marks a section that could not be read as unavailable and still shows the others", async () => {
    staffSetup(() => mineBody({ movements: { available: false, reason: "SCHEMA_OUTDATED" }, plans: { available: false, reason: "ERROR" }, alerts: { available: false, reason: "ERROR" } }));
    expect(await screen.findByText(/Movement history can't be read right now/)).toBeTruthy();
    expect(screen.getByText(/Restock plans can't be read right now/)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Stock-risk levels" })).toBeTruthy();
    expect(kpi("Your active alerts").getByText("Unavailable")).toBeTruthy();
    expect(kpi("Your open restock plans").getByText("Unavailable")).toBeTruthy();
  });

  it("shows an error with a retry when the pharmacy's figures fail, and the public part still works", async () => {
    let up = false;
    staffSetup(() => (up ? mineBody() : ({ status: 503, body: { error: { code: "X", message: "down" } } } as never)));
    expect(await screen.findByText("We couldn't load your pharmacy's figures")).toBeTruthy();
    expect(screen.getByRole("img", { name: /Stock availability across/ })).toBeTruthy();
    up = true;
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    expect(await screen.findByRole("img", { name: /Units sold and restocked/ })).toBeTruthy();
  });
});

describe("administrators and an unreachable portal", () => {
  it("tells an administrator that an administrator account has no pharmacy, and does not ask for pharmacy figures", async () => {
    const api = setup({ "GET /portal/me": () => ({ body: { data: { email: "admin@example.org", role: "ADMIN", pharmacy: null }, meta: {} } }) });
    expect((await screen.findAllByText(/An administrator account has no pharmacy/)).length).toBeGreaterThan(0);
    expect(api.calls.some((c) => c.path === "/portal/analytics")).toBe(false);
  });

  it("says the portal did not answer, rather than claiming nobody is signed in", async () => {
    setup({ "GET /portal/me": () => ({ status: 503, body: {} }) });
    expect((await screen.findAllByText(/because the pharmacy portal did not answer/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/never across the network/)).toBeNull();
  });
});

describe("live updates", () => {
  const SOON = 2_600;
  const fake = async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = setup({ "GET /portal/me": () => STAFF, "GET /portal/analytics": () => mineBody() });
    await screen.findByRole("img", { name: /Units sold and restocked/ });
    send("connected", { version: 1, resync: false });
    return api;
  };
  const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
  const count = (api: ReturnType<typeof mockApi>, path: string) => api.calls.filter((c) => c.path === path).length;

  it("reads the network figures once after a burst of stock events, not once per event", async () => {
    const api = await fake();
    const before = count(api, "/api/analytics/network");
    send("stock", stockEvent({ pharmacyCode: "P002", eventId: "a" }), "b.1");
    send("stock", stockEvent({ pharmacyCode: "P002", eventId: "b" }), "b.2");
    send("stock", stockEvent({ pharmacyCode: "P002", eventId: "c" }), "b.3");
    expect(count(api, "/api/analytics/network")).toBe(before); // not at once
    await advance(SOON);
    await waitFor(() => expect(count(api, "/api/analytics/network")).toBe(before + 1));
    expect(count(api, "/portal/analytics")).toBe(1); // another pharmacy's sale is none of this pharmacy's business
  });

  it("also reads the signed-in pharmacy's own figures when its own stock changes", async () => {
    const api = await fake();
    send("stock", stockEvent({ pharmacyCode: "P001" }), "b.1");
    await advance(SOON);
    await waitFor(() => expect(count(api, "/portal/analytics")).toBe(2));
  });

  it("does not read either when only a node's status changes, and the node card updates", async () => {
    const api = await fake();
    const before = [count(api, "/api/analytics/network"), count(api, "/portal/analytics"), count(api, "/api/nodes")];
    send("node", nodeEvent({ pharmacyCode: "P001", name: "Alpha Chemist", status: "down", processedCount: 50 }), "b.1");
    await advance(SOON);
    expect(within(screen.getByRole("group", { name: /Alpha Chemist/ })).getByText("Down")).toBeTruthy();
    expect([count(api, "/api/analytics/network"), count(api, "/portal/analytics"), count(api, "/api/nodes")]).toEqual(before);
  });

  it("reads everything again after the stream reconnects, because events may have been missed", async () => {
    const api = await fake();
    const before = [count(api, "/api/nodes"), count(api, "/api/analytics/network"), count(api, "/portal/analytics")];
    act(() => FakeEventSource.last.fail(false));
    send("connected", { version: 1, resync: false });
    await waitFor(() => expect([count(api, "/api/nodes"), count(api, "/api/analytics/network"), count(api, "/portal/analytics")]).toEqual(before.map((n) => n + 1)));
  });

  it("stops its timer when the page goes away", async () => {
    const api = await fake();
    const before = count(api, "/api/analytics/network");
    send("stock", stockEvent({ pharmacyCode: "P002" }), "b.1");
    cleanup();
    await advance(SOON * 2);
    expect(count(api, "/api/analytics/network")).toBe(before);
  });
});

describe("the entrance animation", () => {
  class FakeObserver {
    static all: FakeObserver[] = [];
    seen: Element[] = [];
    constructor(private readonly cb: (entries: { isIntersecting: boolean }[]) => void) {
      FakeObserver.all.push(this);
    }
    observe(el: Element) { this.seen.push(el); }
    disconnect() { this.seen = []; }
    show(el: Element) { act(() => this.cb([{ isIntersecting: true, target: el } as never])); }
  }
  const cards = () => [...document.querySelectorAll<HTMLElement>(".dash-drop")];

  it("holds each card above its place until it is on screen, then lets it drop in, staggered 110 ms apart", async () => {
    FakeObserver.all = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    setup();
    await screen.findByRole("group", { name: "Pharmacy nodes" });
    expect(cards().length).toBeGreaterThan(8);
    expect(cards().every((c) => c.dataset.drop === "pending")).toBe(true);
    const kpis = [...document.querySelectorAll<HTMLElement>("ul[aria-label='Key figures'] > li")];
    const delays = kpis.map((k) => Number.parseInt(k.style.getPropertyValue("--drop-delay")));
    expect(delays.slice(1).map((d, i) => d - delays[i]!)).toEqual(delays.slice(1).map(() => 110));
    expect(delays[0]).toBeGreaterThan(0); // after the header
    const header = document.querySelector<HTMLElement>("header.dash-drop")!;
    expect(Number.parseInt(header.style.getPropertyValue("--drop-delay"))).toBe(0); // the header goes first
    const first = kpis[0]!;
    FakeObserver.all.find((o) => o.seen.includes(first))!.show(first);
    expect(first.dataset.drop).toBe("in");
    expect(kpis[1]!.dataset.drop).toBe("pending"); // one that is not visible yet keeps waiting
  });

  it("does not replay when live data arrives: the same card element stays, already in place", async () => {
    setup();
    await screen.findByRole("group", { name: "Pharmacy nodes" });
    await waitFor(() => expect(cards().every((c) => c.dataset.drop === "in")).toBe(true)); // no observer: shown at once
    const card = screen.getByRole("group", { name: /Alpha Chemist/ }).closest<HTMLElement>(".dash-drop")!;
    const kpiCard = screen.getByRole("group", { name: "Events processed" }).closest<HTMLElement>(".dash-drop")!;
    const delay = card.style.getPropertyValue("--drop-delay");
    send("node", nodeEvent({ pharmacyCode: "P001", name: "Alpha Chemist", processedCount: 99 }), "b.1");
    await within(screen.getByRole("group", { name: /Alpha Chemist/ })).findByText("99");
    expect(screen.getByRole("group", { name: /Alpha Chemist/ }).closest(".dash-drop")).toBe(card);
    expect(screen.getByRole("group", { name: "Events processed" }).closest(".dash-drop")).toBe(kpiCard);
    expect(card.dataset.drop).toBe("in");
    expect(card.style.getPropertyValue("--drop-delay")).toBe(delay);
    expect(kpi("Events processed").getByText("107")).toBeTruthy(); // the figure updated in place
  });

  it("is defined with transform and opacity only, a short travel, and no movement when reduced motion is asked for", () => {
    const here = fileURLToPath(import.meta.url);
    const theme = readFileSync(resolve(here, "../../../app/app-theme.css"), "utf8");
    const globals = readFileSync(resolve(here, "../../../app/globals.css"), "utf8");
    expect(globals).toMatch(/@keyframes mx-drop \{\s*from \{ opacity: 0; transform: translateY\(-8px\); \}\s*to \{ opacity: 1; transform: none; \}\s*\}/);
    expect(theme).toMatch(/\.app-theme \.dash-drop\[data-drop="in"\] \{ animation: mx-drop 520ms cubic-bezier\(0\.22, 0\.9, 0\.3, 1\) var\(--drop-delay, 0ms\) backwards; \}/);
    const reduced = theme.slice(theme.indexOf("@media (prefers-reduced-motion: reduce)", theme.indexOf(".dash-drop")));
    expect(reduced).toMatch(/\.dash-drop\[data-drop="pending"\] \{ opacity: 1; transform: none; \}/);
    expect(reduced).toMatch(/\.dash-drop\[data-drop="in"\] \{ animation: none; \}/);
  });
});
