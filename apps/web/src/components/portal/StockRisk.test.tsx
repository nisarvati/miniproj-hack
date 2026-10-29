// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalAlert, PortalRisk, RiskFactor } from "../../lib/portal";
import { mockApi } from "../../test/utils";
import { PortalPage } from "./PortalPage";
import { RiskPanel } from "./StockRisk";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FACTORS: RiskFactor[] = [
  { id: "position", label: "Stock against the threshold", points: 60, available: true, detail: "3 units on hand is at or below the low-stock threshold of 5, which starts at 60 points." },
  { id: "depth", label: "How far below the threshold", points: 16, available: true, detail: "2 units short of the threshold of 5 (40% of it) adds 16 points." },
  { id: "demand", label: "Sales speed", points: null, available: false, detail: "Not used: the only sales history MedLink has is incomplete." },
];
const risk = (over: Partial<PortalRisk> = {}): PortalRisk => ({
  medicineCode: "M001", medicineName: "Crocin 500mg", quantity: 3, threshold: 5, belowThreshold: true, score: 76, level: "CRITICAL",
  summary: "3 units left, at or below the threshold of 5: risk 76, critical.", factors: FACTORS, alert: { alertId: "a1", state: "ACTIVE", createdAt: new Date().toISOString() }, ...over,
});
const alert = (over: Partial<PortalAlert> = {}): PortalAlert => ({
  alertId: "a1", pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", type: "LOW_STOCK", state: "ACTIVE", quantityAtCreation: 4, threshold: 5, riskScoreAtCreation: 68,
  createdAt: new Date().toISOString(), resolvedAt: null, resolvedReason: null, quantityAtResolution: null,
  current: { quantity: 3, threshold: 5, belowThreshold: true, score: 76, level: "CRITICAL", summary: "3 units left, at or below the threshold of 5: risk 76, critical.", factors: FACTORS }, ...over,
});
const alertsPage = (items: PortalAlert[], total = items.length) => ({ body: { data: items, meta: { total, limit: 20, offset: 0, hasMore: false, threshold: 5 } } });
const riskPage = (items: PortalRisk[], total = items.length, offset = 0) => ({ body: { data: items, meta: { total, limit: 8, offset, hasMore: offset + items.length < total, threshold: 5 } } });
const noop = () => undefined;
const panel = (over: { refreshKey?: number; onRestock?: (c: string) => void; onSignedOut?: () => void } = {}) => <RiskPanel refreshKey={0} onRestock={noop} onSignedOut={noop} {...over} />;

describe("RiskPanel", () => {
  it("explains what the score is and is not, and shows the threshold in use", async () => {
    mockApi({ "GET /portal/alerts": () => alertsPage([]), "GET /portal/risk": () => riskPage([]) });
    render(panel());
    const text = (await screen.findByText(/not a forecast/)).textContent!;
    expect(text).toMatch(/compares the units you have with your low-stock threshold of 5/);
    expect(text).toMatch(/how fast something sells is not used/);
    expect(text).toMatch(/An alert opens when a medicine reaches the threshold and closes when it is back above it/);
    expect(document.body.textContent).not.toMatch(/expir|predict|medical advice/i);
  });

  it("shows loading, then each active alert with its stock, threshold, score, level and explanation", async () => {
    mockApi({ "GET /portal/alerts": () => alertsPage([alert()]), "GET /portal/risk": () => riskPage([risk()]) });
    render(panel());
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toEqual(expect.arrayContaining(["Loading low-stock alerts", "Loading stock risk"]));
    const list = await screen.findByRole("list", { name: "Active low-stock alerts" });
    const card = within(list);
    expect(card.getByText("Crocin 500mg")).toBeTruthy();
    expect(card.getByText("M001")).toBeTruthy();
    expect(card.getByText(/Low since/)).toBeTruthy();
    expect(list.textContent).toMatch(/3\s*in stock · threshold 5/);
    expect(card.getByText("Critical risk", { exact: false }).textContent).toMatch(/Stock risk: Critical risk · 76\/100/);
    expect(card.getByText("3 units left, at or below the threshold of 5: risk 76, critical.")).toBeTruthy();
    expect(card.getByRole("button", { name: "Restock Crocin 500mg" })).toBeTruthy();
  });

  it("shows the factors behind a score, including the one that is not used", async () => {
    mockApi({ "GET /portal/alerts": () => alertsPage([alert()]), "GET /portal/risk": () => riskPage([]) });
    render(panel());
    await screen.findByRole("list", { name: "Active low-stock alerts" });
    await userEvent.click(screen.getByText("How this score is made"));
    expect(screen.getByText(/at or below the low-stock threshold of 5, which starts at 60 points/)).toBeTruthy();
    expect(screen.getByText("+60")).toBeTruthy();
    expect(screen.getByText("+16")).toBeTruthy();
    expect(screen.getByText("n/a")).toBeTruthy();
    expect(screen.getByText(/Not used: the only sales history/)).toBeTruthy();
  });

  it("hands the medicine to the restock form when 'Restock this' is pressed", async () => {
    mockApi({ "GET /portal/alerts": () => alertsPage([alert()]), "GET /portal/risk": () => riskPage([]) });
    const onRestock = vi.fn();
    render(panel({ onRestock }));
    await userEvent.click(await screen.findByRole("button", { name: "Restock Crocin 500mg" }));
    expect(onRestock).toHaveBeenCalledWith("M001");
  });

  it("says plainly when there are no alerts, and when there is nothing to rate", async () => {
    mockApi({ "GET /portal/alerts": () => alertsPage([]), "GET /portal/risk": () => riskPage([]) });
    render(panel());
    expect(await screen.findByRole("heading", { name: "No low-stock alerts" })).toBeTruthy();
    expect(screen.getByText(/more than 5 in stock/)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "No medicines to rate" })).toBeTruthy();
  });

  it("lists every medicine by risk with a readable level and marks the ones with an open alert", async () => {
    mockApi({
      "GET /portal/alerts": () => alertsPage([]),
      "GET /portal/risk": () =>
        riskPage([
          risk(),
          risk({ medicineCode: "M002", medicineName: "Dolo 650mg", quantity: 30, belowThreshold: false, score: 1, level: "LOW", alert: null, summary: "30 units on hand, above the threshold of 5: risk 1, low." }),
          risk({ medicineCode: "M003", medicineName: "Cetzine 10mg", quantity: 7, belowThreshold: false, score: 31, level: "MODERATE", alert: null, summary: "7 units on hand, above the threshold of 5: risk 31, moderate." }),
        ]),
    });
    render(panel());
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]!.textContent).toMatch(/Crocin 500mg.*Alert open.*3.*Critical risk · 76\/100/);
    expect(rows[2]!.textContent).toMatch(/Dolo 650mg.*30.*Low risk · 1\/100/);
    expect(rows[3]!.textContent).toMatch(/Cetzine 10mg.*Moderate risk · 31\/100/);
    expect(within(rows[1]!).queryByText("Alert open")).toBeTruthy();
    expect(within(rows[2]!).queryByText("Alert open")).toBeNull();
  });

  it("never shows a score or a number it does not have: unknown stock reads as unknown", async () => {
    mockApi({
      "GET /portal/alerts": () => alertsPage([]),
      "GET /portal/risk": () => riskPage([risk({ medicineName: "Odd one", quantity: null, belowThreshold: null, score: null, level: "UNKNOWN", alert: null, summary: "No risk score: the current stock is not available." })]),
    });
    render(panel());
    const row = (await screen.findAllByRole("row"))[1]!;
    expect(row.textContent).toMatch(/Odd one.*\?.*Risk unknown.*No risk score: the current stock is not available/);
    expect(row.textContent).not.toMatch(/\/100|NaN/);
  });

  it("pages through the risk list, and returns to the top when stock changed here", async () => {
    const api = mockApi({
      "GET /portal/alerts": () => alertsPage([]),
      "GET /portal/risk": (url) => {
        const offset = Number(url.searchParams.get("offset"));
        return riskPage(Array.from({ length: Math.min(8, 20 - offset) }, (_, i) => risk({ medicineCode: `M${100 + offset + i}`, medicineName: `Medicine ${offset + i + 1}`, alert: null })), 20, offset);
      },
    });
    const { rerender } = render(panel());
    expect(await screen.findByText("Showing 1–8 of 20")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Higher" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Lower" }));
    expect(await screen.findByText("Showing 9–16 of 20")).toBeTruthy();
    expect(screen.getByText("Medicine 9")).toBeTruthy();
    expect(api.calls.filter((c) => c.path === "/portal/risk").map((c) => `${c.search.get("limit")}/${c.search.get("offset")}`)).toEqual(["8/0", "8/8"]);
    rerender(panel({ refreshKey: 1 }));
    expect(await screen.findByText("Showing 1–8 of 20")).toBeTruthy();
    expect(api.calls.filter((c) => c.path === "/portal/alerts")).toHaveLength(2); // alerts were read again too
  });

  it("shows an error with a retry for the alerts and for the ranking separately", async () => {
    let alertsUp = false;
    let riskUp = false;
    const api = mockApi({
      "GET /portal/alerts": () => (alertsUp ? alertsPage([alert()]) : { status: 503, body: { error: { code: "X", message: "down" } } }),
      "GET /portal/risk": () => (riskUp ? riskPage([risk()]) : { status: 503, body: { error: { code: "X", message: "down" } } }),
    });
    render(panel());
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toMatch(/couldn't load the alerts.*couldn't load the risk scores/);
    alertsUp = true;
    await userEvent.click(within(alerts.find((a) => /alerts/.test(a.textContent!))!).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Active low-stock alerts" })).toBeTruthy();
    expect(screen.getByText(/couldn't load the risk scores/)).toBeTruthy(); // the other part is unaffected
    riskUp = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("row")).toHaveLength(2);
    expect(api.count("GET", "/portal/alerts")).toBe(2);
    expect(api.count("GET", "/portal/risk")).toBe(2);
  });

  it("reads resolved alerts only when asked, and says how each ended", async () => {
    const api = mockApi({
      "GET /portal/alerts": (url) =>
        url.searchParams.get("state") === "RESOLVED"
          ? alertsPage([
              alert({ alertId: "r1", state: "RESOLVED", quantityAtCreation: 2, resolvedAt: new Date().toISOString(), resolvedReason: "STOCK_RECOVERED", quantityAtResolution: 14, current: null }),
              alert({ alertId: "r2", medicineName: "Dolo 650mg", state: "RESOLVED", resolvedAt: new Date().toISOString(), resolvedReason: "NO_LONGER_STOCKED", current: null }),
            ])
          : alertsPage([]),
      "GET /portal/risk": () => riskPage([]),
    });
    render(panel());
    await screen.findByRole("heading", { name: "No low-stock alerts" });
    expect(api.calls.some((c) => c.search.get("state") === "RESOLVED")).toBe(false);
    await userEvent.click(screen.getByText("Recently resolved alerts"));
    expect(await screen.findByText(/back to 14/)).toBeTruthy();
    expect(screen.getByText(/resolved when you stopped listing it/)).toBeTruthy();
    expect(api.calls.filter((c) => c.search.get("state") === "RESOLVED")).toHaveLength(1);
  });

  it("goes back to sign-in when the session has ended", async () => {
    mockApi({ "GET /portal/alerts": () => ({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Please sign in" } } }), "GET /portal/risk": () => riskPage([]) });
    const onSignedOut = vi.fn();
    render(panel({ onSignedOut }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });
});

describe("in the portal", () => {
  const session = { email: "staff@p001.test", pharmacy: { code: "P001", name: "Paras Medical and General Store", address: "x", registeredName: null } };
  const stock = [{ medicineCode: "M001", brandName: "Crocin", genericName: "Paracetamol", dosage: "500mg", form: "tablet", quantity: 3, price: 25, updatedAt: new Date().toISOString() }];
  const base = {
    "GET /portal/me": () => ({ body: { data: session } }),
    "GET /portal/stock": () => ({ body: { data: stock } }),
    "GET /portal/history": () => ({ body: { data: [], meta: { total: 0, limit: 10, offset: 0, hasMore: false } } }),
    "GET /portal/catalogue": () => ({ body: { data: [] } }),
    "GET /portal/restock-plans": () => ({ body: { data: [], meta: { total: 0, limit: 10, offset: 0, hasMore: false, status: "OPEN" } } }),
  };

  it("'Restock this' on an alert opens the restock form for that medicine, ready for a quantity", async () => {
    mockApi({ ...base, "GET /portal/alerts": () => alertsPage([alert()]), "GET /portal/risk": () => riskPage([risk()]) });
    render(<PortalPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Restock Crocin 500mg" }));
    expect(screen.getByRole("button", { name: "Restock" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Medicine for this entry") as HTMLSelectElement).value).toBe("M001");
    expect(screen.getByRole("button", { name: "Record restock" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe("txn-quantity"));
  });

  it("a recorded sale refreshes the alerts and the risk list", async () => {
    let sold = false;
    const api = mockApi({
      ...base,
      "GET /portal/alerts": () => alertsPage(sold ? [alert()] : []),
      "GET /portal/risk": () => riskPage(sold ? [risk()] : []),
      "POST /portal/sales": () => ((sold = true), { status: 201, body: { data: { movementId: "m", pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", operation: "SALE", source: "TRANSACTION", quantity: 1, quantityDelta: -1, quantityBefore: 4, quantityAfter: 3, occurredAt: new Date().toISOString(), byYou: true }, meta: { replayed: false } } }),
    });
    render(<PortalPage />);
    expect(await screen.findByRole("heading", { name: "No low-stock alerts" })).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Medicine for this entry"), "M001");
    await userEvent.type(screen.getByLabelText("Units sold"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Record sale" }));
    expect(await screen.findByRole("list", { name: "Active low-stock alerts" })).toBeTruthy();
    expect(api.count("GET", "/portal/alerts")).toBe(2);
    // The pharmacy is never a request parameter.
    expect(api.calls.every((c) => !c.search.has("pharmacyCode") && !JSON.stringify(c.body ?? {}).includes("pharmacyCode"))).toBe(true);
  });
});
