// @vitest-environment jsdom
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, stockEvent } from "../../test/fake-event-source";
import { medicine, mockApi, offer, renderWithProviders } from "../../test/utils";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: new URLSearchParams("q=Crocin") }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  usePathname: () => "/search",
  useSearchParams: () => nav.params,
}));
vi.mock("./ResultsMap", () => ({ default: () => <div data-testid="map" /> }));

import { SearchPage } from "./SearchPage";

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const crocin = offer({ medicine: medicine({ id: 1, code: "M001" }) });
const setup = async () => {
  const api = mockApi({
    "GET /api/search": () => ({ body: { data: [crocin], meta: { live: true } } }),
    "GET /api/notifications": () => ({ body: { data: [] } }),
  });
  renderWithProviders(<SearchPage />);
  await screen.findAllByText(/Pharmacy A/);
  return api;
};
const emit = (data: unknown, id = "") => act(() => FakeEventSource.last.emit("stock", data, id));
const searches = (api: Awaited<ReturnType<typeof setup>>) => api.count("GET", "/api/search");

describe("search results and live stock changes", () => {
  it("reads the same search again, once, a moment after a change to a medicine in the results", async () => {
    const api = await setup();
    expect(searches(api)).toBe(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    emit(stockEvent({ medicineCode: "M001", pharmacyCode: "P003" }), "b.1");
    expect(searches(api)).toBe(1); // not instantly: a short pause lets several changes become one reload
    await act(async () => void (await vi.advanceTimersByTimeAsync(799)));
    expect(searches(api)).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(2)));
    expect(searches(api)).toBe(2);
    expect(api.calls.filter((c) => c.path === "/api/search").every((c) => c.search.get("q") === "Crocin")).toBe(true);
  });

  it("makes one request for a burst of changes", async () => {
    const api = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (const n of [1, 2, 3, 4]) {
      emit(stockEvent({ medicineCode: "M001", quantity: n }), `b.${n}`);
      await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    }
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(searches(api)).toBe(2);
  });

  it("does nothing for a change to a medicine that is not in the results", async () => {
    const api = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    emit(stockEvent({ medicineCode: "M042" }), "b.1");
    emit({ version: 1, nonsense: true }, "b.2");
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(searches(api)).toBe(1);
  });

  it("reads again after the stream reconnects, and closes the stream when the page is left", async () => {
    const api = await setup();
    act(() => FakeEventSource.last.emit("connected", { version: 1, resync: false }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => FakeEventSource.last.fail(false));
    act(() => FakeEventSource.last.emit("connected", { version: 1, resync: false }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(searches(api)).toBe(2);
    const es = FakeEventSource.last;
    cleanup();
    expect(es.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("opens no stream until there is a search to keep fresh", async () => {
    nav.params = new URLSearchParams("");
    mockApi({});
    renderWithProviders(<SearchPage />);
    expect(FakeEventSource.instances).toHaveLength(0);
    nav.params = new URLSearchParams("q=Crocin");
  });
});
