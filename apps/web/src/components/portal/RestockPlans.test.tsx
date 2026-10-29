// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanStatus, PortalPlan, PortalStockItem } from "../../lib/portal";
import { mockApi } from "../../test/utils";
import { PortalPage } from "./PortalPage";
import { PlanPanel, type PlanRequest } from "./RestockPlans";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const pad = (n: number) => String(n).padStart(2, "0");
const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const stockItem = (code: string, brand: string, quantity: number): PortalStockItem => ({ medicineCode: code, brandName: brand, genericName: "Paracetamol", dosage: "500mg", form: "tablet", quantity, price: 25, updatedAt: new Date().toISOString() });
const STOCK = [stockItem("M001", "Crocin", 3), stockItem("M002", "Dolo", 40)];
const plan = (over: Partial<PortalPlan> = {}): PortalPlan => ({
  planId: "11111111-1111-4111-8111-111111111111", pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", plannedQuantity: 50, status: "PLANNED", targetDate: day(5),
  notes: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null, byYou: true, currentQuantity: 3, ...over,
});
const page = (items: PortalPlan[], total = items.length, offset = 0, status = "OPEN") => ({ body: { data: items, meta: { total, limit: 10, offset, hasMore: offset + items.length < total, status } } });
const noop = () => undefined;
const panel = (over: { stock?: PortalStockItem[]; request?: PlanRequest | null; onRecordRestock?: (c: string, q: number) => void; onSignedOut?: () => void; refreshKey?: number } = {}) => (
  <PlanPanel stock={STOCK} request={null} refreshKey={0} onRecordRestock={noop} onSignedOut={noop} {...over} />
);
/** A status badge reads "Plan status: <word>": a screen-reader prefix and the visible word are two nodes, so match the badge by its combined text. */
const statusBadge = (label: string) => (_content: string, el: Element | null) => el?.tagName === "SPAN" && el.textContent === `Plan status: ${label}`;

describe("PlanPanel: reading", () => {
  it("explains that a plan is only a plan, and that completing one adds no stock", async () => {
    mockApi({ "GET /portal/restock-plans": () => page([]) });
    render(panel());
    await screen.findByRole("heading", { name: "No open restock plans" });
    const text = document.body.textContent!;
    expect(text).toMatch(/completing one does not add stock/);
    expect(text).toMatch(/Record received stock/);
    expect(text).toMatch(/One open plan per medicine at a time/);
  });

  it("shows loading, then each plan with its medicine, quantity, target date, status as text and the stock for context", async () => {
    mockApi({ "GET /portal/restock-plans": () => page([plan({ notes: "ring the wholesaler", currentQuantity: 3 }), plan({ planId: "2", medicineCode: "M002", medicineName: "Dolo 650mg", status: "IN_PROGRESS", currentQuantity: null })]) });
    render(panel());
    expect(screen.getByRole("status").textContent).toMatch(/Loading restock plans/);
    const items = within(await screen.findByRole("list", { name: "Restock plans" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/Crocin 500mg.*M001/);
    expect(items[0]!.textContent).toMatch(/Plan to order 50 by/);
    expect(within(items[0]!).getByText(statusBadge("Planned"))).toBeTruthy(); // the status is words, not just colour
    expect(items[0]!.textContent).toMatch(/In stock now: 3/);
    expect(items[0]!.textContent).toMatch(/ring the wholesaler/);
    expect(items[1]!.textContent).toMatch(/In progress/);
    expect(items[1]!.textContent).toMatch(/In stock now: not listed/);
    expect(screen.getByText("Showing 1–2 of 2")).toBeTruthy();
  });

  it("marks an open plan whose target date has passed as overdue, in words", async () => {
    mockApi({ "GET /portal/restock-plans": () => page([plan({ targetDate: day(-3) }), plan({ planId: "2", targetDate: day(2), medicineCode: "M002", medicineName: "Dolo 650mg" })]) });
    render(panel());
    const items = within(await screen.findByRole("list", { name: "Restock plans" })).getAllByRole("listitem");
    expect(within(items[0]!).getByText("Overdue")).toBeTruthy();
    expect(within(items[1]!).queryByText("Overdue")).toBeNull();
  });

  it("filters by status, going back to the first page, and pages with bounded limits", async () => {
    const api = mockApi({
      "GET /portal/restock-plans": (url) => {
        const status = url.searchParams.get("status")!;
        const offset = Number(url.searchParams.get("offset"));
        const total = status === "OPEN" ? 25 : 2;
        return page(Array.from({ length: Math.min(10, total - offset) }, (_, i) => plan({ planId: `${status}-${offset + i}`, medicineName: `Medicine ${offset + i + 1}`, medicineCode: `M${100 + offset + i}` })), total, offset, status);
      },
    });
    render(panel());
    expect(await screen.findByText("Showing 1–10 of 25")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Earlier" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(await screen.findByText("Showing 11–20 of 25")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Completed" }));
    expect(await screen.findByText("Showing 1–2 of 2")).toBeTruthy();
    expect(api.calls.map((c) => `${c.search.get("status")}/${c.search.get("limit")}/${c.search.get("offset")}`)).toEqual(["OPEN/10/0", "OPEN/10/10", "COMPLETED/10/0"]);
  });

  it.each([
    ["OPEN", "No open restock plans"],
    ["COMPLETED", "No completed plans"],
    ["CANCELLED", "No cancelled plans"],
    ["ALL", "No restock plans yet"],
  ])("says so plainly when there is nothing under %s", async (filter, title) => {
    mockApi({ "GET /portal/restock-plans": () => page([]) });
    render(panel());
    await screen.findByRole("heading", { name: "No open restock plans" });
    if (filter !== "OPEN") await userEvent.click(screen.getByRole("button", { name: filter === "ALL" ? "All" : filter[0] + filter.slice(1).toLowerCase() }));
    expect(await screen.findByRole("heading", { name: title })).toBeTruthy();
  });

  it("shows an error with a retry", async () => {
    let up = false;
    const api = mockApi({ "GET /portal/restock-plans": () => (up ? page([plan()]) : { status: 503, body: { error: { code: "X", message: "down" } } }) });
    render(panel());
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't load your restock plans/);
    up = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Crocin 500mg")).toBeTruthy();
    expect(api.count("GET", "/portal/restock-plans")).toBe(2);
  });

  it("goes back to sign-in when the session has ended", async () => {
    mockApi({ "GET /portal/restock-plans": () => ({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Please sign in" } } }) });
    const onSignedOut = vi.fn();
    render(panel({ onSignedOut }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });
});

describe("PlanPanel: making a plan", () => {
  const open = async () => {
    await screen.findByRole("heading", { name: "No open restock plans" });
    await userEvent.click(screen.getAllByRole("button", { name: "New plan" })[0]!);
  };
  const created = (over: Partial<PortalPlan> = {}) => ({ status: 201, body: { data: plan(over) } });

  it("offers only this pharmacy's medicines and sends no pharmacy, no status and no suggested quantity", async () => {
    const api = mockApi({ "GET /portal/restock-plans": () => page([]), "POST /portal/restock-plans": () => created() });
    render(panel());
    await open();
    const options = within(screen.getByLabelText("Medicine to restock")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Choose a medicine", "Crocin 500mg · 3 in stock", "Dolo 650mg · 40 in stock".replace("Dolo 650mg", "Dolo 500mg")]);
    expect((screen.getByLabelText("Units to order") as HTMLInputElement).value).toBe(""); // MedLink has no demand data to suggest a number
    await userEvent.selectOptions(screen.getByLabelText("Medicine to restock"), "M001");
    await userEvent.type(screen.getByLabelText("Units to order"), "60");
    await userEvent.clear(screen.getByLabelText("Target date"));
    await userEvent.type(screen.getByLabelText("Target date"), day(4));
    await userEvent.type(screen.getByLabelText("Notes (optional)"), "  usual supplier ");
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(await screen.findByText(/No stock has changed/)).toBeTruthy();
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ medicineCode: "M001", quantity: 60, targetDate: day(4), notes: "usual supplier" });
    expect(Object.keys(post.body as object).sort()).toEqual(["medicineCode", "notes", "quantity", "targetDate"]);
    expect(api.calls.filter((c) => c.path.includes("restocks") || c.path.includes("/stock"))).toEqual([]); // a plan touches no stock endpoint
  });

  it.each(["", "0", "-1", "2.5", "abc", "1e3", "2000000"])("does not send the quantity '%s'", async (bad) => {
    const api = mockApi({ "GET /portal/restock-plans": () => page([]) });
    render(panel());
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Medicine to restock"), "M001");
    if (bad) await userEvent.type(screen.getByLabelText("Units to order"), bad);
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/whole number, 1 or more/);
    expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("asks for a medicine and a date before sending anything", async () => {
    const api = mockApi({ "GET /portal/restock-plans": () => page([]) });
    render(panel());
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a medicine/);
    await userEvent.selectOptions(screen.getByLabelText("Medicine to restock"), "M001");
    await userEvent.type(screen.getByLabelText("Units to order"), "5");
    await userEvent.clear(screen.getByLabelText("Target date"));
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a target date/);
    expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("sends one request even if the button is pressed twice while it is in progress", async () => {
    let release: (r: Response) => void = noop;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? new Promise<Response>((res) => (release = res)) : Promise.resolve(new Response(JSON.stringify(page([]).body), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(panel());
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Medicine to restock"), "M001");
    await userEvent.type(screen.getByLabelText("Units to order"), "5");
    const form = screen.getByRole("button", { name: "Save plan" }).closest("form")!;
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    act(() => { form.requestSubmit(); form.requestSubmit(); });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => release(new Response(JSON.stringify({ data: plan() }), { status: 201 })));
    expect(await screen.findByText(/No stock has changed/)).toBeTruthy();
  });

  it("when the medicine already has an open plan, says so and offers to open it", async () => {
    const existing = plan({ planId: "99999999-9999-4999-8999-999999999999" });
    const api = mockApi({
      "GET /portal/restock-plans": () => page([]),
      "POST /portal/restock-plans": () => ({ status: 409, body: { error: { code: "PLAN_ALREADY_OPEN", message: "There is already an open restock plan for this medicine. Change that one, or finish it first.", details: { planId: existing.planId, status: "PLANNED" } } } }),
      "GET /portal/restock-plans/*": () => ({ body: { data: existing } }),
    });
    render(panel());
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Medicine to restock"), "M001");
    await userEvent.type(screen.getByLabelText("Units to order"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already an open restock plan/);
    await userEvent.click(screen.getByRole("button", { name: "View the open plan" }));
    const opened = await screen.findByRole("list", { name: "Opened restock plan" });
    expect(opened.textContent).toMatch(/Crocin 500mg/);
    expect(api.calls.some((c) => c.path === `/portal/restock-plans/${existing.planId}`)).toBe(true);
  });

  it("shows the server's refusal for an invalid date and keeps what was typed", async () => {
    mockApi({ "GET /portal/restock-plans": () => page([]), "POST /portal/restock-plans": () => ({ status: 400, body: { error: { code: "INVALID", message: "The target date cannot be in the past." } } }) });
    render(panel());
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Medicine to restock"), "M001");
    await userEvent.type(screen.getByLabelText("Units to order"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/target date cannot be in the past/);
    expect((screen.getByLabelText("Units to order") as HTMLInputElement).value).toBe("5");
  });
});

describe("PlanPanel: changing a plan", () => {
  /** A fake server for one plan that follows the real lifecycle closely enough for the page. */
  function server(initial: PortalPlan) {
    let current = initial;
    const api = mockApi({
      "GET /portal/restock-plans": () => page([current]),
      "PATCH /portal/restock-plans/*": (_url, init) => {
        const patch = JSON.parse(String(init?.body)) as { status?: PlanStatus; targetDate?: string; quantity?: number; notes?: string | null };
        current = { ...current, ...(patch.status && { status: patch.status, completedAt: patch.status === "COMPLETED" ? new Date().toISOString() : null }), ...(patch.targetDate && { targetDate: patch.targetDate }), ...(patch.quantity && { plannedQuantity: patch.quantity }), ...("notes" in patch && { notes: patch.notes ?? null }) };
        return { body: { data: current } };
      },
    });
    return api;
  }
  const patches = (api: ReturnType<typeof mockApi>) => api.calls.filter((c) => c.method === "PATCH").map((c) => c.body);

  it("moves a plan along: start, complete (saying it added no stock), reopen", async () => {
    const api = server(plan());
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByText(/Plan started for Crocin 500mg/)).toBeTruthy();
    expect(await screen.findByText(statusBadge("In progress"))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Complete" }));
    expect((await screen.findByText(/Plan completed for Crocin 500mg/)).textContent).toMatch(/did not add stock.*Record received stock/);
    await waitFor(() => expect(screen.getByText(statusBadge("Completed"))).toBeTruthy());
    expect(screen.getByText(/Completed means the plan is done. It did not add any stock/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(screen.getByText(statusBadge("In progress"))).toBeTruthy());
    expect(patches(api)).toEqual([{ status: "IN_PROGRESS" }, { status: "COMPLETED" }, { status: "IN_PROGRESS" }]);
  });

  it("offers only the actions the lifecycle allows", async () => {
    const buttons = () => screen.getAllByRole("button").map((b) => b.textContent).filter((t) => ["Start", "Back to planned", "Complete", "Reopen", "Reschedule", "Edit", "Cancel plan", "Record received stock"].includes(t!));
    server(plan({ status: "PLANNED" }));
    const { unmount } = render(panel());
    await screen.findByText("Crocin 500mg");
    expect(buttons()).toEqual(["Start", "Complete", "Reschedule", "Edit", "Cancel plan", "Record received stock"]);
    unmount();
    server(plan({ status: "IN_PROGRESS" }));
    const second = render(panel());
    await screen.findByText("Crocin 500mg");
    expect(buttons()).toEqual(["Back to planned", "Complete", "Reschedule", "Edit", "Cancel plan", "Record received stock"]);
    second.unmount();
    server(plan({ status: "COMPLETED", completedAt: new Date().toISOString() }));
    const third = render(panel());
    await screen.findByText("Crocin 500mg");
    expect(buttons()).toEqual(["Reopen", "Record received stock"]); // no editing a completed plan
    third.unmount();
    server(plan({ status: "CANCELLED" }));
    render(panel());
    await screen.findByText("Crocin 500mg");
    expect(buttons()).toEqual([]); // cancelled is final
  });

  it("asks before cancelling, and sends nothing until confirmed", async () => {
    const api = server(plan());
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    expect(screen.getByText(/A cancelled plan cannot be reopened/)).toBeTruthy();
    expect(screen.getByText(/Your stock is not affected/)).toBeTruthy();
    expect(patches(api)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(patches(api)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, cancel the plan" }));
    expect(await screen.findByText(/Plan cancelled for Crocin 500mg/)).toBeTruthy();
    expect(patches(api)).toEqual([{ status: "CANCELLED" }]);
  });

  it("reschedules by sending only the new date, and refuses an empty one", async () => {
    const api = server(plan({ targetDate: day(5) }));
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    const input = screen.getByLabelText("New target date") as HTMLInputElement;
    expect(input.value).toBe(day(5));
    await userEvent.clear(input);
    await userEvent.click(screen.getByRole("button", { name: "Save date" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a target date/);
    expect(patches(api)).toEqual([]);
    await userEvent.type(input, day(12));
    await userEvent.click(screen.getByRole("button", { name: "Save date" }));
    expect(await screen.findByText(/Plan moved to/)).toBeTruthy();
    expect(patches(api)).toEqual([{ targetDate: day(12) }]);
  });

  it("edits the quantity and notes, validating the quantity first", async () => {
    const api = server(plan({ notes: "old" }));
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const qty = screen.getByLabelText("Units to order");
    await userEvent.clear(qty);
    await userEvent.type(qty, "0");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/whole number, 1 or more/);
    expect(patches(api)).toEqual([]);
    await userEvent.clear(qty);
    await userEvent.type(qty, "75");
    await userEvent.clear(screen.getByLabelText("Notes"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/Plan updated: 75 × Crocin 500mg/)).toBeTruthy();
    expect(patches(api)).toEqual([{ quantity: 75, notes: null }]);
  });

  it("shows the server's refusal of a move and leaves the plan as it was", async () => {
    mockApi({
      "GET /portal/restock-plans": () => page([plan({ status: "COMPLETED", completedAt: new Date().toISOString() })]),
      "PATCH /portal/restock-plans/*": () => ({ status: 409, body: { error: { code: "INVALID_TRANSITION", message: "The plan is already IN_PROGRESS." } } }),
    });
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/The plan is already IN_PROGRESS/);
    expect(screen.getByText(statusBadge("Completed"))).toBeTruthy();
  });

  it("'Record received stock' hands the medicine and planned quantity to the restock form, and changes nothing itself", async () => {
    const api = server(plan({ plannedQuantity: 50 }));
    const onRecordRestock = vi.fn();
    render(panel({ onRecordRestock }));
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Record received stock for Crocin 500mg" }));
    expect(onRecordRestock).toHaveBeenCalledWith("M001", 50);
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]); // no request: the restock is made (and confirmed) in the restock form
  });
});

describe("PlanPanel: CSV export", () => {
  let created: Blob[];
  let clicked: { download: string; href: string }[];
  beforeEach(() => {
    created = [];
    clicked = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => (created.push(b), "blob:fake")), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    });
  });
  const backend = (exportResponse: () => Response) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      return url.includes("export.csv") ? exportResponse() : new Response(JSON.stringify(page([plan()]).body), { status: 200 });
    }));
    return calls;
  };
  const csv = (extra: Record<string, string> = {}) => () =>
    new Response("plan_id,medicine_code\r\n", { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="restock-plans-P001-open-2026-11-01.csv"', "x-export-truncated": "false", ...extra } });

  it("downloads a real file named by the server, for the filter on screen, with the session cookie", async () => {
    const calls = backend(csv());
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Downloaded restock-plans-P001-open-2026-11-01.csv.")).toBeTruthy();
    const exportCall = calls.find((c) => c.url.includes("export.csv"))!;
    expect(exportCall.url).toMatch(/\/portal\/restock-plans\/export\.csv\?status=OPEN$/);
    expect(exportCall.init?.credentials).toBe("include");
    expect(created).toHaveLength(1);
    expect(await created[0]!.text()).toBe("plan_id,medicine_code\r\n");
    expect(clicked).toEqual([{ download: "restock-plans-P001-open-2026-11-01.csv", href: "blob:fake" }]);
    // The file is a download, not text shown on the page.
    expect(document.body.textContent).not.toMatch(/plan_id,medicine_code/);
  });

  it("exports the filter that is selected", async () => {
    const calls = backend(csv());
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Completed" }));
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await screen.findByText(/Downloaded/);
    expect(calls.find((c) => c.url.includes("export.csv"))!.url).toMatch(/status=COMPLETED$/);
  });

  it("says so when the file was cut short", async () => {
    backend(csv({ "x-export-truncated": "true" }));
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect((await screen.findByText(/Downloaded/)).textContent).toMatch(/first 10,000 plans only/);
  });

  it("shows a useful error, with a retry, when the download fails", async () => {
    let ok = false;
    backend(() => (ok ? csv()() : new Response(JSON.stringify({ error: { code: "X", message: "down" } }), { status: 503 })));
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Export failed/);
    expect(alert.textContent).toMatch(/The export did not download/);
    expect(clicked).toEqual([]);
    ok = true;
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Downloaded/)).toBeTruthy();
    expect(clicked).toHaveLength(1);
  });

  it("does not trust an odd filename from the server", async () => {
    backend(csv({ "content-disposition": 'attachment; filename="../../etc/passwd"' }));
    render(panel());
    await screen.findByText("Crocin 500mg");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await screen.findByText(/Downloaded/);
    expect(clicked[0]!.download).toBe("restock-plans.csv");
  });
});

describe("from a low-stock alert", () => {
  const session = { email: "staff@p001.test", pharmacy: { code: "P001", name: "Paras Medical and General Store", address: "x", registeredName: null } };
  const risk = { quantity: 3, threshold: 5, belowThreshold: true, score: 76, level: "CRITICAL", summary: "3 units left, at or below the threshold of 5: risk 76, critical.", factors: [{ id: "position", label: "Stock against the threshold", points: 60, available: true, detail: "x" }] };
  const alert = (restockPlan: unknown = null) => ({
    alertId: "a1", pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", type: "LOW_STOCK", state: "ACTIVE", quantityAtCreation: 4, threshold: 5, riskScoreAtCreation: 68,
    createdAt: new Date().toISOString(), resolvedAt: null, resolvedReason: null, quantityAtResolution: null, restockPlan, current: risk,
  });
  const routes = (alertData: unknown, extra: Parameters<typeof mockApi>[0] = {}) =>
    mockApi({
      "GET /portal/me": () => ({ body: { data: session } }),
      "GET /portal/stock": () => ({ body: { data: [stockItem("M001", "Crocin", 3), stockItem("M002", "Dolo", 40)] } }),
      "GET /portal/history": () => ({ body: { data: [], meta: { total: 0, limit: 10, offset: 0, hasMore: false } } }),
      "GET /portal/catalogue": () => ({ body: { data: [] } }),
      "GET /portal/alerts": () => ({ body: { data: [alertData], meta: { total: 1, limit: 20, offset: 0, hasMore: false, threshold: 5 } } }),
      "GET /portal/risk": () => ({ body: { data: [], meta: { total: 0, limit: 8, offset: 0, hasMore: false, threshold: 5 } } }),
      "GET /portal/restock-plans": () => page([]),
      ...extra,
    });

  it("'Plan restock' opens the plan form for that medicine with the risk and stock in view, a starting date, and no suggested quantity", async () => {
    const api = routes(alert());
    render(<PortalPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Plan a restock of Crocin 500mg" }));
    expect((screen.getByLabelText("Medicine to restock") as HTMLSelectElement).value).toBe("M001");
    const context = screen.getByLabelText("Low-stock alert for this medicine");
    expect(context.textContent).toMatch(/From a low-stock alert:.*Critical risk · 76\/100/);
    expect(context.textContent).toMatch(/3 units left, at or below the threshold of 5/);
    expect(context.textContent).toMatch(/In stock now: 3/);
    expect(context.textContent).toMatch(/threshold 5/);
    expect(context.textContent).toMatch(/MedLink has no sales history to suggest a number/);
    expect((screen.getByLabelText("Target date") as HTMLInputElement).value).toBe(day(1)); // critical: a starting date of tomorrow, editable
    expect((screen.getByLabelText("Units to order") as HTMLInputElement).value).toBe("");
    // Nothing was created by opening the form, or by reading the alert.
    expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("makes a plan only when the person saves it, and then the alert can show it", async () => {
    let made: PortalPlan | null = null;
    let alertData = alert();
    const api = routes(alertData, {
      "GET /portal/alerts": () => ({ body: { data: [made ? alert({ planId: made.planId, status: "PLANNED", targetDate: made.targetDate }) : alertData], meta: { total: 1, limit: 20, offset: 0, hasMore: false, threshold: 5 } } }),
      "POST /portal/restock-plans": (_u, init) => ((made = plan({ ...JSON.parse(String(init?.body)), plannedQuantity: JSON.parse(String(init?.body)).quantity })), { status: 201, body: { data: made } }),
    });
    render(<PortalPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Plan a restock of Crocin 500mg" }));
    await userEvent.type(screen.getByLabelText("Units to order"), "60");
    await userEvent.click(screen.getByRole("button", { name: "Save plan" }));
    expect(await screen.findByText(/No stock has changed/)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/portal/restock-plans"]);
    alertData = alert(); // (the alert list refreshes on the next change; the plan is shown there from then on)
    expect(api.calls.every((c) => !c.path.includes("/portal/restocks") && c.method !== "PATCH")).toBe(true);
  });

  it("shows an alert's open plan with a way to open it, instead of a second 'Plan restock'", async () => {
    const existing = plan({ planId: "55555555-5555-4555-8555-555555555555", status: "IN_PROGRESS", targetDate: day(4) });
    const api = routes(alert({ planId: existing.planId, status: "IN_PROGRESS", targetDate: existing.targetDate }), { "GET /portal/restock-plans/*": () => ({ body: { data: existing } }) });
    render(<PortalPage />);
    const view = await screen.findByRole("button", { name: "View the restock plan for Crocin 500mg" });
    expect(screen.queryByRole("button", { name: "Plan a restock of Crocin 500mg" })).toBeNull();
    expect(screen.getByText(/Restock plan:/).textContent).toMatch(/in progress, target/);
    await userEvent.click(view);
    const opened = await screen.findByRole("list", { name: "Opened restock plan" });
    expect(opened.textContent).toMatch(/Crocin 500mg/);
    expect(opened.textContent).toMatch(/In progress/);
    expect(api.calls.some((c) => c.path === `/portal/restock-plans/${existing.planId}`)).toBe(true);
    expect(api.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("'Record received stock' fills the restock form with the planned quantity, and nothing is recorded until it is submitted", async () => {
    const existing = plan({ plannedQuantity: 60, status: "COMPLETED", completedAt: new Date().toISOString() });
    const api = routes(alert(), { "GET /portal/restock-plans": () => page([existing]), "POST /portal/restocks": () => ({ status: 201, body: { data: { movementId: "m", pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", operation: "RESTOCK", source: "TRANSACTION", quantity: 60, quantityDelta: 60, quantityBefore: 3, quantityAfter: 63, occurredAt: new Date().toISOString(), byYou: true }, meta: { replayed: false } } }) });
    render(<PortalPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Record received stock for Crocin 500mg" }));
    expect(screen.getByRole("button", { name: "Restock" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Medicine for this entry") as HTMLSelectElement).value).toBe("M001");
    expect((screen.getByLabelText("Units received") as HTMLInputElement).value).toBe("60");
    expect(api.calls.filter((c) => c.method !== "GET")).toEqual([]); // completing the plan and filling the form changed nothing
    await userEvent.click(screen.getByRole("button", { name: "Record restock" }));
    expect(await screen.findByText(/Received 60 × Crocin 500mg/)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/portal/restocks"]); // the existing restock, and only it
    expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
