/**
 * A stand-in for the browser's EventSource that tests drive by hand. Only what the live stream hook uses:
 * addEventListener, onerror, readyState, close. `emit` delivers a named event the way the browser would.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static reset() {
    FakeEventSource.instances = [];
  }
  static get last(): FakeEventSource {
    return FakeEventSource.instances.at(-1)!;
  }

  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {
    this.readyState = 2;
    this.closed = true;
  }

  get listenerCount() {
    return [...this.listeners.values()].reduce((n, l) => n + l.length, 0);
  }

  /** The server sent an event. `data` is JSON-encoded unless it is already a string (to send garbage). */
  emit(type: string, data: unknown, lastEventId = "") {
    this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? []) fn({ data: typeof data === "string" ? data : JSON.stringify(data), lastEventId } as MessageEvent);
  }
  /** The connection dropped. `closed`: the browser gave up (it will not retry by itself). */
  fail(closed = false) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}

export const nodeEvent = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  version: 1,
  node: { pharmacyCode: "P001", name: "Alpha Chemist", status: "healthy", statusReason: "caught up", lastSyncedAt: "2026-10-29T12:00:00.000Z", syncLagMs: 1000, unpublishedOutbox: 0, staleCount: 0, duplicateCount: 0, processedCount: 1, ...over },
  meta: { generatedAt: "2026-10-29T12:00:05.000Z", redis: "up", connector: "up", syncService: "ready", ...meta },
});
export const stockEvent = (over: Record<string, unknown> = {}) => ({
  version: 1,
  eventId: "11111111-1111-4111-8111-111111111111",
  pharmacyCode: "P001",
  medicineCode: "M001",
  eventType: "SALE",
  quantity: 5,
  price: null,
  occurredAt: "2026-10-29T12:00:00.000Z",
  ...over,
});
