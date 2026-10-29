"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, type NodeStatus, type NodeStatusEntry, type NodesResponse } from "./api";

/** The live stream (GET /api/stream). Payload versions this client understands; anything else is ignored. */
const SUPPORTED_VERSION = 1;

export interface StockEvent {
  eventId: string;
  pharmacyCode: string;
  medicineCode: string;
  eventType: string;
  /** null: this change carries no quantity (a price update). */
  quantity: number | null;
  price: number | null;
  occurredAt: string;
}

export interface NodeEvent {
  node: NodeStatusEntry;
  meta: Pick<NodesResponse["meta"], "generatedAt" | "redis" | "connector"> & { syncService?: NodesResponse["meta"]["syncService"] };
}

/**
 * connecting    the first connection is being made
 * connected     the stream is open
 * reconnecting  it dropped and is being retried (the browser, or this hook, retries on its own)
 * disconnected  not available: this browser has no EventSource, or the retries were given up. Refresh still works.
 */
export type LiveState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface LiveHandlers {
  onNode?: (event: NodeEvent) => void;
  onStock?: (event: StockEvent) => void;
  /** After a reconnect, or when the server says events may have been missed: reload from the API, which is the truth. */
  onResync?: () => void;
}

const STATUSES: readonly NodeStatus[] = ["healthy", "degraded", "down", "unknown"];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nullableNumber = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));
const nullableString = (v: unknown) => v === null || typeof v === "string";

/** A `node` payload, or null when it is not one this client understands. Never throws. */
export function parseNodeEvent(data: unknown): NodeEvent | null {
  if (!isObject(data) || data.version !== SUPPORTED_VERSION || !isObject(data.node) || !isObject(data.meta)) return null;
  const n = data.node;
  const ok =
    typeof n.pharmacyCode === "string" && /^P\d{3,}$/.test(n.pharmacyCode) &&
    typeof n.name === "string" &&
    STATUSES.includes(n.status as NodeStatus) &&
    nullableString(n.lastSyncedAt) && nullableNumber(n.syncLagMs) && nullableNumber(n.unpublishedOutbox) &&
    nullableNumber(n.staleCount) && nullableNumber(n.duplicateCount) && nullableNumber(n.processedCount) &&
    typeof data.meta.generatedAt === "string" && Number.isFinite(Date.parse(data.meta.generatedAt));
  return ok ? (data as unknown as NodeEvent) : null;
}

/** A `stock` payload, or null. Never throws. */
export function parseStockEvent(data: unknown): StockEvent | null {
  if (!isObject(data) || data.version !== SUPPORTED_VERSION) return null;
  const ok =
    typeof data.eventId === "string" &&
    typeof data.pharmacyCode === "string" && /^P\d{3,}$/.test(data.pharmacyCode) &&
    typeof data.medicineCode === "string" && /^M\d{3,}$/.test(data.medicineCode) &&
    typeof data.eventType === "string" &&
    nullableNumber(data.quantity) && nullableNumber(data.price) &&
    typeof data.occurredAt === "string";
  if (!ok) return null;
  const { version: _version, ...event } = data;
  return event as unknown as StockEvent;
}

const parseJson = (text: unknown): unknown => {
  try {
    return typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

export interface LiveOptions {
  /** Where the stream is. Default: the API's /api/stream. */
  url?: string;
  /** Replaces the browser's EventSource (tests). */
  createSource?: (url: string) => EventSource;
  /** Consecutive failed attempts after which the hook stops trying ("disconnected"). */
  maxAttempts?: number;
  /** First retry delay when the browser has given up on its own; doubles each time, up to 30 s. */
  retryMs?: number;
}

/**
 * One EventSource for as long as the component is mounted and `enabled`. Never opens a second one, ignores malformed or unknown events,
 * ignores an event id it has already seen (a replay after a reconnect), and closes everything when it unmounts.
 *
 * Handlers are read through a ref, so changing them does not reconnect.
 */
export function useLiveStream(handlers: LiveHandlers, enabled = true, options: LiveOptions = {}): { state: LiveState; lastEventAt: Date | null; reconnect: () => void } {
  const [state, setState] = useState<LiveState>("connecting");
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const [attempt, setAttempt] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const url = options.url ?? `${API_URL}/api/stream`;
  const { maxAttempts = 6, retryMs = 3_000 } = options;
  // Read through a ref so an inline function from the caller cannot cause a reconnect on every render.
  const createRef = useRef(options.createSource);
  createRef.current = options.createSource;
  const custom = options.createSource !== undefined;

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setState("disconnected");
      return;
    }
    if (!custom && typeof EventSource === "undefined") {
      setState("disconnected");
      return;
    }

    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let everConnected = false;
    const seen = new Set<string>();
    setState("connecting");

    const remember = (id: string): boolean => {
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > 500) seen.delete(seen.values().next().value as string);
      return true;
    };
    const stamp = () => setLastEventAt(new Date());

    const open = () => {
      if (disposed) return;
      const es = createRef.current ? createRef.current(url) : new EventSource(url);
      source = es;

      es.addEventListener("connected", (e) => {
        if (disposed || source !== es) return;
        failures = 0;
        setState("connected");
        const data = parseJson((e as MessageEvent).data);
        const resync = isObject(data) && data.version === SUPPORTED_VERSION && data.resync === true;
        // Anything after the very first connection may have missed events while it was down: reload from the API.
        if (everConnected || resync) handlersRef.current.onResync?.();
        everConnected = true;
      });
      es.addEventListener("node", (e) => {
        if (disposed || source !== es) return;
        const event = parseNodeEvent(parseJson((e as MessageEvent).data));
        if (!event || !remember((e as MessageEvent).lastEventId)) return;
        stamp();
        handlersRef.current.onNode?.(event);
      });
      es.addEventListener("stock", (e) => {
        if (disposed || source !== es) return;
        const event = parseStockEvent(parseJson((e as MessageEvent).data));
        if (!event || !remember((e as MessageEvent).lastEventId)) return;
        stamp();
        handlersRef.current.onStock?.(event);
      });
      es.onerror = () => {
        if (disposed || source !== es) return;
        if (es.readyState !== 2 /* CLOSED */) {
          setState("reconnecting"); // the browser is retrying by itself, and sends Last-Event-ID
          return;
        }
        // The browser gave up (for example the server answered with an error status). Retry ourselves, with a growing delay.
        es.close();
        failures++;
        if (failures >= maxAttempts) {
          setState("disconnected");
          return;
        }
        setState("reconnecting");
        retryTimer = setTimeout(open, Math.min(retryMs * 2 ** (failures - 1), 30_000));
      };
    };

    open();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
      source = null;
    };
  }, [enabled, url, custom, maxAttempts, retryMs, attempt]);

  return { state, lastEventAt, reconnect };
}
