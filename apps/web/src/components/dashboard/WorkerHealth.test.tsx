// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodesResponse, NodeStatusEntry } from "../../lib/api";
import { mockApi } from "../../test/utils";
import { DashboardPage } from "./DashboardPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AT = "2026-10-29T12:00:00.000Z";
const node = (over: Partial<NodeStatusEntry> = {}): NodeStatusEntry => ({
  pharmacyCode: "P001", name: "Alpha Chemist", status: "unknown", statusReason: "x", lastSyncedAt: AT, syncLagMs: 1000, unpublishedOutbox: null, staleCount: 0, duplicateCount: 0, processedCount: 4, ...over,
});
const setup = (meta: Partial<NodesResponse["meta"]>) => {
  mockApi({
    "GET /api/nodes": () => ({ body: { data: [node()], meta: { generatedAt: AT, redis: "up", connector: "up", syncService: "ready", ...meta } } }),
    "GET /api/analytics/network": () => ({ status: 503, body: { error: { code: "X", message: "x" } } }),
    "GET /portal/me": () => ({ status: 401, body: { error: { code: "U", message: "s" } } }),
  });
  render(<DashboardPage />);
};

describe("the dashboard and worker heartbeats", () => {
  it("says the sync service has gone quiet (stale), not that it could not be reached, and still does not call a node healthy", async () => {
    setup({ syncService: "stale" });
    expect(await screen.findByText("The sync service has gone quiet")).toBeTruthy();
    expect(screen.getByText(/last heartbeat is too old to say it is still running/)).toBeTruthy();
    expect(screen.queryByText("The sync service could not be reached")).toBeNull();
    expect(screen.queryByText("Healthy")).toBeNull();
  });
  it("still says unreachable and not-ready as before", async () => {
    setup({ syncService: "unreachable" });
    expect(await screen.findByText("The sync service could not be reached")).toBeTruthy();
    cleanup();
    setup({ syncService: "not-ready" });
    expect(await screen.findByText("The sync service says it is not ready")).toBeTruthy();
  });
  it("says the connector has gone quiet when its heartbeat is stale, and keeps the other readings", async () => {
    setup({ connector: "stale" });
    expect(await screen.findByText(/inventory connector has gone quiet \(its last heartbeat is too old\)/)).toBeTruthy();
    expect(screen.getByText(/Other readings are unaffected/)).toBeTruthy();
  });
});
