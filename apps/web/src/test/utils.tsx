import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";
import { AccountProvider } from "../components/providers/account";
import { LocationProvider } from "../components/providers/location";

type Handler = (url: URL, init?: RequestInit) => { status?: number; body?: unknown };

/**
 * A fake backend: routes "METHOD /path" to a handler returning { status, body }. Anything unrouted answers 500 and is
 * recorded, so a test cannot pass by accident through a request it did not know about.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; search: URLSearchParams; body: unknown }[] = [];
  const unrouted: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, path: url.pathname, search: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(" ") as [string, string];
      return m === method && (p.includes("*") ? new RegExp(`^${p.replace(/\*/g, "[^/]+")}$`).test(url.pathname) : p === url.pathname);
    });
    if (!key) {
      unrouted.push(`${method} ${url.pathname}`);
      return new Response(JSON.stringify({}), { status: 500 });
    }
    const { status = 200, body = {} } = routes[key]!(url, init);
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, unrouted, fetchMock, count: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length };
}

/** The pieces every page expects above it: the saved location and the account (email, notifications). */
export const renderWithProviders = (ui: ReactElement) =>
  render(
    <LocationProvider>
      <AccountProvider>{ui}</AccountProvider>
    </LocationProvider>,
  );

export const medicine = (over: Record<string, unknown> = {}) => ({ id: 1, code: "M001", brandName: "Crocin", genericName: "Paracetamol", dosage: "500mg", form: "tablet", ...over });
export const pharmacy = (over: Record<string, unknown> = {}) => ({ id: 1, code: "P001", name: "Pharmacy A - Andheri West", address: "Lokhandwala Complex, Andheri West, Mumbai", latitude: 19.1364, longitude: 72.8296, ...over });
export const offer = (over: Record<string, unknown> = {}) => ({
  rank: 1,
  score: 0.9,
  medicine: medicine(),
  pharmacy: pharmacy(),
  quantity: 12,
  price: 25,
  stockStatus: "IN_STOCK",
  distanceKm: 0.4,
  updatedAt: new Date().toISOString(),
  source: "live",
  ...over,
});
