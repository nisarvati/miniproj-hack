// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, nodeEvent, stockEvent } from "../test/fake-event-source";
import { parseNodeEvent, parseStockEvent, useLiveStream, type LiveHandlers, type LiveOptions } from "./live";

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Probe({ handlers, enabled = true, options }: { handlers: LiveHandlers; enabled?: boolean; options?: LiveOptions }) {
  const { state, lastEventAt } = useLiveStream(handlers, enabled, options);
  return <p data-testid="state" data-last={lastEventAt ? "yes" : "no"}>{state}</p>;
}
const state = () => screen.getByTestId("state").textContent;
const connect = (es = FakeEventSource.last, data: unknown = { version: 1, bootId: "b", resync: false }) => act(() => es.emit("connected", data));

describe("useLiveStream", () => {
  it("goes from connecting to connected, and opens exactly one source at the API's stream URL", () => {
    render(<Probe handlers={{}} />);
    expect(state()).toBe("connecting");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last.url).toMatch(/\/api\/stream$/);
    connect();
    expect(state()).toBe("connected");
  });

  it("shows reconnecting while the browser retries, and asks for a reload (once) when it is back", () => {
    const onResync = vi.fn();
    render(<Probe handlers={{ onResync }} />);
    connect();
    expect(onResync).not.toHaveBeenCalled(); // the first connection has nothing to catch up on
    act(() => FakeEventSource.last.fail(false));
    expect(state()).toBe("reconnecting");
    expect(FakeEventSource.instances).toHaveLength(1); // the browser reconnects the same source itself
    connect();
    expect(state()).toBe("connected");
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("asks for a reload when the server says events may have been missed", () => {
    const onResync = vi.fn();
    render(<Probe handlers={{ onResync }} />);
    connect(FakeEventSource.last, { version: 1, bootId: "b", resync: true });
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("retries by itself with a growing delay when the browser gives up, then stops as disconnected", () => {
    vi.useFakeTimers();
    render(<Probe handlers={{}} options={{ maxAttempts: 3, retryMs: 1000 }} />);
    act(() => FakeEventSource.last.fail(true));
    expect(state()).toBe("reconnecting");
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    act(() => void vi.advanceTimersByTime(999));
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => FakeEventSource.last.fail(true));
    act(() => void vi.advanceTimersByTime(2000)); // doubled
    expect(FakeEventSource.instances).toHaveLength(3);
    act(() => FakeEventSource.last.fail(true));
    expect(state()).toBe("disconnected");
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(3); // gave up: no further attempts
  });

  it("closes the source and cancels any retry when the component unmounts", () => {
    vi.useFakeTimers();
    const onNode = vi.fn();
    const { unmount } = render(<Probe handlers={{ onNode }} options={{ retryMs: 1000 }} />);
    const first = FakeEventSource.last;
    act(() => first.fail(true)); // a retry is now scheduled
    unmount();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(FakeEventSource.instances).toHaveLength(1); // no source was opened after unmount
    expect(first.closed).toBe(true);

    const live = render(<Probe handlers={{ onNode }} />);
    const second = FakeEventSource.last;
    live.unmount();
    expect(second.closed).toBe(true);
    act(() => second.emit("node", nodeEvent())); // a late event after unmount is ignored
    expect(onNode).not.toHaveBeenCalled();
  });

  it("does not open a second connection when it re-renders with new handlers", () => {
    const { rerender } = render(<Probe handlers={{ onNode: () => undefined }} />);
    rerender(<Probe handlers={{ onNode: () => undefined }} />);
    rerender(<Probe handlers={{ onStock: () => undefined }} />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last.closed).toBe(false);
  });

  it("calls the latest handler, and passes on valid node and stock events", () => {
    const first = vi.fn();
    const second = vi.fn();
    const onStock = vi.fn();
    const { rerender } = render(<Probe handlers={{ onNode: first, onStock }} />);
    rerender(<Probe handlers={{ onNode: second, onStock }} />);
    act(() => FakeEventSource.last.emit("node", nodeEvent({ status: "down" }), "b.1"));
    act(() => FakeEventSource.last.emit("stock", stockEvent({ medicineCode: "M042" }), "b.2"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ node: expect.objectContaining({ pharmacyCode: "P001", status: "down" }) }));
    expect(onStock).toHaveBeenCalledWith(expect.objectContaining({ medicineCode: "M042", quantity: 5 }));
    expect(screen.getByTestId("state").dataset.last).toBe("yes");
  });

  it("ignores malformed, unsupported and unknown events without breaking the stream", () => {
    const onNode = vi.fn();
    const onStock = vi.fn();
    render(<Probe handlers={{ onNode, onStock }} />);
    const es = FakeEventSource.last;
    act(() => {
      es.emit("node", "{not json");
      es.emit("node", nodeEvent({ status: "on-fire" }));
      es.emit("node", { ...nodeEvent(), version: 2 });
      es.emit("node", { version: 1 });
      es.emit("node", "null");
      es.emit("stock", stockEvent({ medicineCode: "not-a-code" }));
      es.emit("stock", { version: 1, pharmacyCode: "P001" });
      es.emit("alert", { version: 1 }); // a type this client does not know
      es.emit("heartbeat", { version: 1 });
    });
    expect(onNode).not.toHaveBeenCalled();
    expect(onStock).not.toHaveBeenCalled();
    expect(screen.getByTestId("state").dataset.last).toBe("no");
    act(() => es.emit("node", nodeEvent()));
    expect(onNode).toHaveBeenCalledTimes(1); // and it still works afterwards
  });

  it("ignores an event id it has already seen (a replay after a reconnect), but not an event without an id", () => {
    const onStock = vi.fn();
    render(<Probe handlers={{ onStock }} />);
    const es = FakeEventSource.last;
    act(() => {
      es.emit("stock", stockEvent(), "b.7");
      es.emit("stock", stockEvent(), "b.7");
      es.emit("stock", stockEvent(), "b.8");
      es.emit("stock", stockEvent(), "");
      es.emit("stock", stockEvent(), "");
    });
    expect(onStock).toHaveBeenCalledTimes(4);
  });

  it("stays disconnected, without error, where the browser has no EventSource", () => {
    vi.unstubAllGlobals();
    render(<Probe handlers={{}} />);
    expect(state()).toBe("disconnected");
  });

  it("opens nothing while disabled, and connects when it is enabled", () => {
    const { rerender } = render(<Probe handlers={{}} enabled={false} />);
    expect(state()).toBe("disconnected");
    expect(FakeEventSource.instances).toHaveLength(0);
    rerender(<Probe handlers={{}} enabled />);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(state()).toBe("connecting");
    rerender(<Probe handlers={{}} enabled={false} />);
    expect(FakeEventSource.last.closed).toBe(true);
  });
});

describe("payload parsing", () => {
  it("accepts what the server sends and nothing else", () => {
    expect(parseNodeEvent(nodeEvent())?.node.pharmacyCode).toBe("P001");
    expect(parseNodeEvent(nodeEvent({ syncLagMs: null, lastSyncedAt: null, processedCount: null }))).not.toBeNull(); // unknown is allowed
    expect(parseNodeEvent(nodeEvent({ syncLagMs: "12" }))).toBeNull();
    expect(parseNodeEvent(nodeEvent({ pharmacyCode: "X1" }))).toBeNull();
    expect(parseNodeEvent(nodeEvent({}, { generatedAt: "yesterday" }))).toBeNull();
    expect(parseStockEvent(stockEvent({ quantity: null, price: 12.5 }))).toMatchObject({ quantity: null, price: 12.5 });
    expect(parseStockEvent(stockEvent({ quantity: "5" }))).toBeNull();
    expect(parseStockEvent(stockEvent())).not.toHaveProperty("version");
  });
});
