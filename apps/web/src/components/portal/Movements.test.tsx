// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PortalMovement, PortalStockItem } from "../../lib/portal";
import { mockApi } from "../../test/utils";
import { HistoryPanel, TransactionPanel } from "./Movements";
import { PortalPage } from "./PortalPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (code: string, brand: string, quantity: number, over: Partial<PortalStockItem> = {}): PortalStockItem => ({
  medicineCode: code, brandName: brand, genericName: "Paracetamol", dosage: "500mg", form: "tablet", quantity, price: 25, updatedAt: new Date().toISOString(), ...over,
});
const STOCK = [item("M001", "Crocin", 5), item("M002", "Dolo", 0, { dosage: "650mg" })];
const movement = (over: Partial<PortalMovement> = {}): PortalMovement => ({
  movementId: "00000000-0000-4000-8000-000000000001", pharmacyCode: "P001", medicineCode: "M001", medicineName: "Crocin 500mg", operation: "SALE", source: "TRANSACTION",
  quantity: 2, quantityDelta: -2, quantityBefore: 5, quantityAfter: 3, occurredAt: new Date().toISOString(), byYou: true, ...over,
});
const created = (m: PortalMovement, replayed = false) => ({ status: replayed ? 200 : 201, body: { data: m, meta: { replayed } } });
const page = (items: PortalMovement[], total = items.length, offset = 0) => ({ body: { data: items, meta: { total, limit: 10, offset, hasMore: offset + items.length < total } } });

async function pick(code: string, qty: string) {
  await userEvent.selectOptions(screen.getByLabelText("Medicine for this entry"), code);
  if (qty) await userEvent.type(screen.getByLabelText(/^Units (sold|received)$/), qty);
}
const sellButton = () => screen.getByRole("button", { name: "Record sale" });

describe("TransactionPanel", () => {
  it("offers only the pharmacy's own medicines, with how many are in stock, and shows the stock of the chosen one", async () => {
    mockApi({});
    render(<TransactionPanel items={STOCK} onRecorded={() => undefined} onSignedOut={() => undefined} />);
    const options = within(screen.getByLabelText("Medicine for this entry")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Choose a medicine", "Crocin 500mg · 5 in stock", "Dolo 650mg · 0 in stock"]);
    expect(screen.getByText(/Pick a medicine to see how many you have/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Medicine for this entry"), "M001");
    expect(screen.getByText("5", { selector: "span" })).toBeTruthy();
    expect(screen.queryByLabelText(/pharmacy/i)).toBeNull(); // the browser never chooses the pharmacy
  });

  it("records a sale with a retry key, says what happened, clears the field and tells the page", async () => {
    const onRecorded = vi.fn();
    const api = mockApi({ "POST /portal/sales": () => created(movement()) });
    render(<TransactionPanel items={STOCK} onRecorded={onRecorded} onSignedOut={() => undefined} />);
    await pick("M001", "2");
    await userEvent.click(sellButton());
    expect((await screen.findByText(/Sold 2 × Crocin 500mg\. 3 now in stock\./)).textContent).toMatch(/Shoppers will see it within a few seconds/);
    const call = api.calls.find((c) => c.path === "/portal/sales")!;
    expect(call.body).toEqual({ medicineCode: "M001", quantity: 2 });
    expect(call.headers["idempotency-key"]).toMatch(/^.{8,100}$/);
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText(/^Units sold$/) as HTMLInputElement).value).toBe("");
  });

  it("records a restock on the restock endpoint", async () => {
    const api = mockApi({ "POST /portal/restocks": () => created(movement({ operation: "RESTOCK", quantity: 10, quantityDelta: 10, quantityBefore: 5, quantityAfter: 15 })) });
    render(<TransactionPanel items={STOCK} onRecorded={() => undefined} onSignedOut={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Restock" }));
    await pick("M001", "10");
    await userEvent.click(screen.getByRole("button", { name: "Record restock" }));
    expect(await screen.findByText(/Received 10 × Crocin 500mg\. 15 now in stock\./)).toBeTruthy();
    expect(api.calls.map((c) => c.path)).toEqual(["/portal/restocks"]);
    expect(api.calls[0]!.body).toEqual({ medicineCode: "M001", quantity: 10 });
  });

  it.each(["", "0", "-1", "1.5", "abc", "1e3", "2000000"])("does not send the quantity '%s'", async (bad) => {
    const api = mockApi({});
    render(<TransactionPanel items={STOCK} onRecorded={() => undefined} onSignedOut={() => undefined} />);
    await pick("M001", bad);
    await userEvent.click(sellButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/whole number, 1 or more/);
    expect(api.calls).toEqual([]);
  });

  it("asks for a medicine, and will not sell more than the shelf holds (the server still decides)", async () => {
    const api = mockApi({});
    render(<TransactionPanel items={STOCK} onRecorded={() => undefined} onSignedOut={() => undefined} />);
    await userEvent.click(sellButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a medicine/);
    await pick("M001", "6");
    await userEvent.click(sellButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/Only 5 in stock: you can't sell 6/);
    expect(api.calls).toEqual([]);
  });

  it("shows the server's refusal when the stock changed underneath (insufficient stock) and keeps the entry", async () => {
    mockApi({ "POST /portal/sales": () => ({ status: 409, body: { error: { code: "INSUFFICIENT_STOCK", message: "P001 has only 1 of Crocin 500mg, cannot sell 2" } } }) });
    const onRecorded = vi.fn();
    render(<TransactionPanel items={STOCK} onRecorded={onRecorded} onSignedOut={() => undefined} />);
    await pick("M001", "2");
    await userEvent.click(sellButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/The sale was not recorded/);
    expect(alert.textContent).toMatch(/has only 1 of Crocin 500mg/);
    expect((screen.getByLabelText(/^Units sold$/) as HTMLInputElement).value).toBe("2");
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("sends one request even if the button is pressed twice while it is in progress", async () => {
    let release: (v: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((res) => (release = res)));
    vi.stubGlobal("fetch", fetchMock);
    render(<TransactionPanel items={STOCK} onRecorded={() => undefined} onSignedOut={() => undefined} />);
    await pick("M001", "1");
    const form = sellButton().closest("form")!;
    await userEvent.click(sellButton());
    act(() => { form.requestSubmit(); form.requestSubmit(); }); // a second and third try while the first is still on its way
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Record sale" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release(new Response(JSON.stringify({ data: movement(), meta: { replayed: false } }), { status: 201 })));
    expect(await screen.findByText(/Sold 2/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Record sale" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("retries the same entry with the same key, and uses a new key once the entry is edited or recorded", async () => {
    let fail = true;
    const api = mockApi({ "POST /portal/sales": () => (fail ? { status: 503, body: { error: { code: "X", message: "down" } } } : created(movement())) });
    render(<TransactionPanel items={STOCK} onRecorded={() => undefined} onSignedOut={() => undefined} />);
    await pick("M001", "2");
    await userEvent.click(sellButton());
    await screen.findByRole("alert");
    fail = false;
    await userEvent.click(sellButton()); // the retry
    await screen.findByText(/Sold 2/);
    const [first, retry] = api.calls.map((c) => c.headers["idempotency-key"]);
    expect(retry).toBe(first);

    await userEvent.type(screen.getByLabelText(/^Units sold$/), "3"); // a new entry
    await userEvent.click(sellButton());
    await waitFor(() => expect(api.calls).toHaveLength(3));
    expect(api.calls[2]!.headers["idempotency-key"]).not.toBe(first);
  });

  it("says so when the server reports the request was already recorded", async () => {
    mockApi({ "POST /portal/sales": () => created(movement(), true) });
    render(<TransactionPanel items={STOCK} onRecorded={() => undefined} onSignedOut={() => undefined} />);
    await pick("M001", "2");
    await userEvent.click(sellButton());
    expect(await screen.findByText(/already recorded, so nothing changed\. 3 in stock\./)).toBeTruthy();
  });

  it("goes back to sign-in when the session has ended", async () => {
    mockApi({ "POST /portal/sales": () => ({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Please sign in" } } }) });
    const onSignedOut = vi.fn();
    render(<TransactionPanel items={STOCK} onRecorded={() => undefined} onSignedOut={onSignedOut} />);
    await pick("M001", "1");
    await userEvent.click(sellButton());
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });
});

describe("HistoryPanel", () => {
  it("shows a loading state, then each movement: medicine, operation, signed change and stock before and after", async () => {
    mockApi({ "GET /portal/history": () => page([movement(), movement({ movementId: "2", operation: "RESTOCK", quantity: 10, quantityDelta: 10, quantityBefore: 3, quantityAfter: 13, medicineName: "Dolo 650mg", byYou: false }), movement({ movementId: "3", source: "STOCK_COUNT" })]) });
    render(<HistoryPanel refreshKey={0} onSignedOut={() => undefined} />);
    expect(screen.getByRole("status").textContent).toMatch(/Loading movement history/);
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(4); // header + 3
    expect(within(rows[1]!).getByText("Crocin 500mg")).toBeTruthy();
    expect(within(rows[1]!).getByText("Sale")).toBeTruthy();
    expect(within(rows[1]!).getByText("−2")).toBeTruthy();
    expect(rows[1]!.textContent).toMatch(/5\s*→\s*3/);
    expect(within(rows[1]!).getByText("by you")).toBeTruthy();
    expect(within(rows[2]!).getByText("Restock")).toBeTruthy();
    expect(within(rows[2]!).getByText("+10")).toBeTruthy();
    expect(within(rows[2]!).queryByText("by you")).toBeNull();
    expect(within(rows[3]!).getByText("Stock count")).toBeTruthy();
    expect(screen.getByText("Showing 1–3 of 3")).toBeTruthy();
    // the change is readable without the symbols
    expect(within(rows[1]!).getByText("minus 2")).toBeTruthy();
  });

  it("explains an empty history, and says earlier changes are not listed", async () => {
    mockApi({ "GET /portal/history": () => page([]) });
    render(<HistoryPanel refreshKey={0} onSignedOut={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "No movements recorded yet" })).toBeTruthy();
    expect(screen.getByText(/Changes made before this list existed/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows an error with a retry", async () => {
    let ok = false;
    const api = mockApi({ "GET /portal/history": () => (ok ? page([movement()]) : { status: 503, body: { error: { code: "X", message: "down" } } }) });
    render(<HistoryPanel refreshKey={0} onSignedOut={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't load the history/);
    ok = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Crocin 500mg")).toBeTruthy();
    expect(api.count("GET", "/portal/history")).toBe(2);
  });

  it("pages through older movements, and goes back to the newest when something new is recorded", async () => {
    const api = mockApi({
      "GET /portal/history": (url) => {
        const offset = Number(url.searchParams.get("offset"));
        return page(Array.from({ length: Math.min(10, 25 - offset) }, (_, i) => movement({ movementId: `m${offset + i}`, medicineName: `Medicine ${offset + i + 1}` })), 25, offset);
      },
    });
    const { rerender } = render(<HistoryPanel refreshKey={0} onSignedOut={() => undefined} />);
    expect(await screen.findByText("Showing 1–10 of 25")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Newer" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(await screen.findByText("Showing 11–20 of 25")).toBeTruthy();
    expect(screen.getByText("Medicine 11")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Older" }));
    expect(await screen.findByText("Showing 21–25 of 25")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Older" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.calls.map((c) => c.search.get("offset"))).toEqual(["0", "10", "20"]);
    expect(api.calls.every((c) => c.search.get("limit") === "10")).toBe(true);

    rerender(<HistoryPanel refreshKey={1} onSignedOut={() => undefined} />);
    expect(await screen.findByText("Showing 1–10 of 25")).toBeTruthy();
    expect(api.calls.at(-1)!.search.get("offset")).toBe("0");
  });

  it("goes back to sign-in when the session has ended", async () => {
    mockApi({ "GET /portal/history": () => ({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Please sign in" } } }) });
    const onSignedOut = vi.fn();
    render(<HistoryPanel refreshKey={0} onSignedOut={onSignedOut} />);
    await waitFor(() => expect(onSignedOut).toHaveBeenCalled());
  });
});

describe("in the portal", () => {
  const session = { email: "staff@p001.test", pharmacy: { code: "P001", name: "Paras Medical and General Store", address: "x", registeredName: null } };

  it("a recorded sale refreshes the stock list and the history, for the pharmacy in the session", async () => {
    let sold = false;
    const api = mockApi({
      "GET /portal/me": () => ({ body: { data: session } }),
      "GET /portal/stock": () => ({ body: { data: [item("M001", "Crocin", sold ? 3 : 5)] } }),
      "GET /portal/history": () => page(sold ? [movement()] : []),
      "GET /portal/alerts": () => ({ body: { data: [], meta: { total: 0, limit: 20, offset: 0, hasMore: false, threshold: 5 } } }),
      "GET /portal/risk": () => ({ body: { data: [], meta: { total: 0, limit: 8, offset: 0, hasMore: false, threshold: 5 } } }),
      "GET /portal/catalogue": () => ({ body: { data: [] } }),
      "POST /portal/sales": () => ((sold = true), created(movement())),
    });
    render(<PortalPage />);
    expect(await screen.findByRole("heading", { level: 2, name: /Managing inventory for Paras Medical and General Store/ })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "No movements recorded yet" })).toBeTruthy();
    await pick("M001", "2");
    await userEvent.click(sellButton());
    expect(await screen.findByText(/Sold 2 × Crocin 500mg/)).toBeTruthy();
    expect(await screen.findByRole("table")).toBeTruthy(); // the history now has the sale
    await waitFor(() => expect(api.count("GET", "/portal/stock")).toBe(2));
    const row = screen.getAllByRole("listitem").find((li) => li.textContent?.includes("Crocin 500mg") && li.textContent?.includes("in stock"))!;
    expect(row.textContent).toMatch(/₹25\s*3 in stock/); // price, then what is left on the shelf
    // Whichever pharmacy it is, it is not in any request the page makes.
    expect(api.calls.every((c) => !JSON.stringify(c).includes("pharmacyCode") && !c.search.has("pharmacy"))).toBe(true);
  });

  it("a stock count edit also refreshes the history", async () => {
    const api = mockApi({
      "GET /portal/me": () => ({ body: { data: session } }),
      "GET /portal/stock": () => ({ body: { data: [item("M001", "Crocin", 5)] } }),
      "GET /portal/history": () => page([]),
      "GET /portal/alerts": () => ({ body: { data: [], meta: { total: 0, limit: 20, offset: 0, hasMore: false, threshold: 5 } } }),
      "GET /portal/risk": () => ({ body: { data: [], meta: { total: 0, limit: 8, offset: 0, hasMore: false, threshold: 5 } } }),
      "GET /portal/catalogue": () => ({ body: { data: [] } }),
      "PATCH /portal/stock/M001": () => ({ body: { data: { medicineCode: "M001", before: { quantity: 5, price: 25 }, after: { quantity: 8, price: 25 }, events: ["RESTOCK"] } } }),
    });
    render(<PortalPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit Crocin 500mg" }));
    const quantity = await screen.findByLabelText(/quantity/i);
    await userEvent.clear(quantity);
    await userEvent.type(quantity, "8");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.count("GET", "/portal/history")).toBe(2));
  });
});
