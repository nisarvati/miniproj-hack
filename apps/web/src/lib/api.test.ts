import { describe, expect, it, vi } from "vitest";
import { ApiError, cancelSubscription, getPharmacy, getPharmacyStock, getSubstitutes, listNotifications, listPharmacies, listSubscriptions, searchMedicines, subscribeToRestock } from "./api";

const loc = { latitude: 19.1364, longitude: 72.8296 };
const respond = (status: number, body: unknown) => vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe("searchMedicines", () => {
  it("calls /api/search with q, lat and lng and returns the data array", async () => {
    const fetchImpl = respond(200, { data: [{ rank: 1 }] });
    const out = await searchMedicines("Crocin 500mg", loc, { fetchImpl, baseUrl: "http://api.test" });
    expect(out).toEqual({ results: [{ rank: 1 }], matches: null, live: false, sortNote: null, unverifiedCount: 0, rejected: [], rejectionSummary: null });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe("http://api.test/api/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "Crocin 500mg", lat: "19.1364", lng: "72.8296" });
  });

  it("returns the catalogue matches when the API sends them, and null when it does not", async () => {
    const matches = [{ medicine: { id: 40, code: "M025", brandName: "Retaunch", genericName: "N-Acetylcysteine + Taurine", dosage: "150mg/500mg", form: "tablet" }, listed: false }];
    const withMatches = await searchMedicines("Retaunch", loc, { fetchImpl: respond(200, { data: [], meta: { live: true, matches } }), baseUrl: "http://api.test" });
    expect(withMatches).toEqual({ results: [], matches, live: true, sortNote: null, unverifiedCount: 0, rejected: [], rejectionSummary: null });
    const garbled = await searchMedicines("x", loc, { fetchImpl: respond(200, { data: [], meta: { matches: "nope" } }), baseUrl: "http://api.test" });
    expect(garbled.matches).toBeNull();
  });

  it("maps 400 to a validation error using the server's field messages", async () => {
    const fetchImpl = respond(400, { error: { code: "VALIDATION_ERROR", message: "Invalid request", details: [{ field: "lat", message: "lat is required" }] } });
    await expect(searchMedicines("x", loc, { fetchImpl })).rejects.toMatchObject({ kind: "validation", message: "lat is required" });
  });

  it("maps 503 to an unavailable error", async () => {
    await expect(searchMedicines("x", loc, { fetchImpl: respond(503, { error: {} }) })).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps 500 to a generic error without leaking server text", async () => {
    const err = await searchMedicines("x", loc, { fetchImpl: respond(500, { error: { message: "secret detail" } }) }).catch((e: ApiError) => e);
    expect(err).toMatchObject({ kind: "unknown" });
    expect((err as ApiError).message).not.toContain("secret");
  });

  it("maps network failures to a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(searchMedicines("x", loc, { fetchImpl })).rejects.toMatchObject({ kind: "network" });
  });

  it("re-throws aborts untouched so callers can ignore them", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(searchMedicines("x", loc, { fetchImpl })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects a malformed success body", async () => {
    await expect(searchMedicines("x", loc, { fetchImpl: respond(200, { nope: 1 }) })).rejects.toMatchObject({ kind: "unknown" });
  });
});

describe("subscribeToRestock", () => {
  const sub = { id: 7, status: "ACTIVE", medicine: { id: 1, brandName: "Crocin", dosage: "500mg" }, createdAt: "2026-10-05T12:00:00Z", notifiedAt: null };

  it("POSTs the email and medicine as JSON and reports a new subscription", async () => {
    const fetchImpl = respond(201, { data: sub, meta: { created: true } });
    const out = await subscribeToRestock("a@example.com", 1, { fetchImpl, baseUrl: "http://api.test" });
    expect(out).toEqual({ subscription: sub, alreadyWaiting: false });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://api.test/api/restock-subscriptions");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(String(init!.body))).toEqual({ email: "a@example.com", medicineId: 1 });
  });

  it("tells the caller when they were already waiting", async () => {
    const out = await subscribeToRestock("a@example.com", 1, { fetchImpl: respond(200, { data: sub, meta: { created: false } }) });
    expect(out.alreadyWaiting).toBe(true);
  });

  it("shows the server's field message for a bad email, a plain message for an unknown medicine", async () => {
    const bad = respond(400, { error: { details: [{ field: "email", message: "A valid email address is required" }] } });
    await expect(subscribeToRestock("x", 1, { fetchImpl: bad })).rejects.toMatchObject({ kind: "validation", message: "A valid email address is required" });
    await expect(subscribeToRestock("a@example.com", 99, { fetchImpl: respond(404, { error: { message: "Unknown medicineId" } }) })).rejects.toMatchObject({
      kind: "validation",
      message: "That medicine is no longer listed.",
    });
  });

  it("maps outages and network failures", async () => {
    await expect(subscribeToRestock("a@example.com", 1, { fetchImpl: respond(503, {}) })).rejects.toMatchObject({ kind: "unavailable" });
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(subscribeToRestock("a@example.com", 1, { fetchImpl: down })).rejects.toMatchObject({ kind: "network" });
  });
});

describe("listNotifications", () => {
  it("GETs the user's notifications with the email url-encoded", async () => {
    const fetchImpl = respond(200, { data: [{ id: 1, message: "back", createdAt: "x", deliveredAt: null }] });
    const out = await listNotifications("a+b@example.com", { fetchImpl, baseUrl: "http://api.test" });
    expect(out).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://api.test/api/notifications?email=a%2Bb%40example.com");
  });

  it("rejects an unexpected body and maps errors", async () => {
    await expect(listNotifications("a@example.com", { fetchImpl: respond(200, {}) })).rejects.toMatchObject({ kind: "unknown" });
    await expect(listNotifications("a@example.com", { fetchImpl: respond(500, {}) })).rejects.toMatchObject({ kind: "unknown" });
  });
});

describe("search filters", () => {
  it("sends only the filters that are set, and leaves the default sort out", async () => {
    const fetchImpl = respond(200, { data: [], meta: { live: true } });
    const out = await searchMedicines("croc", loc, { fetchImpl, baseUrl: "http://api.test", filters: { inStock: true, maxDistanceKm: 5, sort: "best" } });
    expect(out).toEqual({ results: [], matches: null, live: true, sortNote: null, unverifiedCount: 0, rejected: [], rejectionSummary: null });
    const params = new URL(String(fetchImpl.mock.calls[0]![0])).searchParams;
    expect(Object.fromEntries(params)).toEqual({ q: "croc", lat: "19.1364", lng: "72.8296", inStock: "true", maxDistanceKm: "5" });
  });

  it("sends a non-default sort and a price cap", async () => {
    const fetchImpl = respond(200, { data: [] });
    await searchMedicines("croc", loc, { fetchImpl, filters: { maxPrice: 50, sort: "distance" } });
    const params = new URL(String(fetchImpl.mock.calls[0]![0])).searchParams;
    expect(params.get("sort")).toBe("distance");
    expect(params.get("maxPrice")).toBe("50");
    expect(params.has("inStock")).toBe(false);
  });
});

describe("getSubstitutes", () => {
  it("returns the suggestions with the API's notice", async () => {
    const fetchImpl = respond(200, { data: [{ medicine: { id: 2 } }], meta: { notice: "Ask your pharmacist." } });
    const out = await getSubstitutes(1, loc, { fetchImpl, baseUrl: "http://api.test" });
    expect(out).toEqual({ substitutes: [{ medicine: { id: 2 } }], notice: "Ask your pharmacist." });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://api.test/api/medicines/1/substitutes?lat=19.1364&lng=72.8296");
  });

  it("supplies a safe notice if the server sent none", async () => {
    const out = await getSubstitutes(1, loc, { fetchImpl: respond(200, { data: [] }) });
    expect(out.notice).toMatch(/pharmacist or your doctor/);
  });
});

describe("pharmacies", () => {
  it("lists pharmacies and fetches one with the distance", async () => {
    expect(await listPharmacies({ fetchImpl: respond(200, { data: [{ id: 1 }] }) })).toEqual([{ id: 1 }]);
    const fetchImpl = respond(200, { data: { id: 3, distanceKm: 1.2 } });
    expect(await getPharmacy(3, loc, { fetchImpl, baseUrl: "http://api.test" })).toEqual({ id: 3, distanceKm: 1.2 });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://api.test/api/pharmacies/3?lat=19.1364&lng=72.8296");
  });

  it("asks without a location when there is none, and maps 404 to notFound", async () => {
    const fetchImpl = respond(404, { error: {} });
    await expect(getPharmacy(9, null, { fetchImpl, baseUrl: "http://api.test" })).rejects.toMatchObject({ kind: "notFound" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://api.test/api/pharmacies/9");
  });

  it("fetches stock with the name filter, and reads the summary", async () => {
    const fetchImpl = respond(200, { data: [{ quantity: 1 }], meta: { total: 14, live: true, summary: { inStock: 9, lowStock: 2, outOfStock: 3 } } });
    const out = await getPharmacyStock(2, { q: " croc ", inStock: true }, { fetchImpl, baseUrl: "http://api.test" });
    expect(out).toEqual({ items: [{ quantity: 1 }], total: 14, live: true, summary: { inStock: 9, lowStock: 2, outOfStock: 3 } });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://api.test/api/pharmacies/2/stock?q=croc&inStock=true");
  });
});

describe("subscriptions", () => {
  it("lists a user's subscriptions and cancels one", async () => {
    expect(await listSubscriptions("a@example.com", { fetchImpl: respond(200, { data: [{ id: 4 }] }) })).toEqual([{ id: 4 }]);
    const fetchImpl = respond(200, { data: {} });
    await cancelSubscription(4, "a@example.com", { fetchImpl, baseUrl: "http://api.test" });
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: "DELETE" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("http://api.test/api/restock-subscriptions/4?email=a%40example.com");
  });

  it("cancelling something already fulfilled is a notFound, which callers can treat as 'already done'", async () => {
    await expect(cancelSubscription(4, "a@example.com", { fetchImpl: respond(404, { error: {} }) })).rejects.toMatchObject({ kind: "notFound" });
    await expect(cancelSubscription(4, "a@example.com", { fetchImpl: respond(500, {}) })).rejects.toMatchObject({ kind: "unknown" });
  });
});

describe("searchMedicines: matching and rejected offers", () => {
  const fetchOf = (meta: unknown, data: unknown[] = []) => (async () => new Response(JSON.stringify({ data, meta }), { status: 200 })) as unknown as typeof fetch;
  const here = { latitude: 19.1, longitude: 72.8 };
  const offer = (code: string) => ({ medicine: { id: 1, code: "M001" }, pharmacy: { id: 2, code }, price: 20, stockStatus: "OUT_OF_STOCK", distanceKm: null, updatedAt: "x", source: "live", reasons: [{ code: "OUT_OF_STOCK", filter: "inStock", message: "Out of stock, and you chose in-stock pharmacies only.", limit: null, actual: 0 }] });

  it("passes on the rejected offers and their summary", async () => {
    const summary = { total: 1, byReason: { OUT_OF_STOCK: 1 }, shown: 1, truncated: false };
    const out = await searchMedicines("Crocin", here, { fetchImpl: fetchOf({ rejected: [offer("P004")], rejectionSummary: summary }) });
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reasons[0]!.code).toBe("OUT_OF_STOCK");
    expect(out.rejectionSummary).toEqual(summary);
  });

  it("is empty, not broken, for an older API or for rubbish in the response", async () => {
    expect((await searchMedicines("Crocin", here, { fetchImpl: fetchOf({}) })).rejected).toEqual([]);
    expect((await searchMedicines("Crocin", here, { fetchImpl: fetchOf({ rejected: "no", rejectionSummary: "no" }) }))).toMatchObject({ rejected: [], rejectionSummary: null });
    const mixed = await searchMedicines("Crocin", here, { fetchImpl: fetchOf({ rejected: [offer("P004"), { reasons: [] }, null, { medicine: {}, pharmacy: {}, reasons: [] }, 7] }) });
    expect(mixed.rejected.map((r) => r.pharmacy.code)).toEqual(["P004"]); // only an offer with a reason can be shown as rejected
    expect((await searchMedicines("Crocin", here, { fetchImpl: fetchOf({ rejectionSummary: { total: -1 } }) })).rejectionSummary).toBeNull();
  });

  it("keeps the match fields on a result as the API sent them", async () => {
    const out = await searchMedicines("Crocin", here, { fetchImpl: fetchOf({}, [{ rank: 1, matchPercent: 87, matchReasons: [{ code: "IN_STOCK", factor: "availability", points: 40, factorValue: 1, message: "In stock" }] }]) });
    expect(out.results[0]).toMatchObject({ matchPercent: 87 });
  });
});
