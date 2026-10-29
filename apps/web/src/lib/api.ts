export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
/** "live": synced from the pharmacy's own events. "catalogue": the central database's last known value. */
export type StockSource = "live" | "catalogue";
export type SortKey = "best" | "distance" | "price" | "stock";

export interface MedicineRef {
  id: number;
  code: string;
  brandName: string;
  genericName: string;
  dosage: string;
  form: string;
}

export interface PharmacyRef {
  id: number;
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  /** A demo listing: its stock, prices and availability are synthetic. Missing from an older API. */
  demo?: boolean;
  /** A real independent pharmacy used as a demo listing; never a confirmed MedLink partner. Missing from an older API. */
  independent?: boolean;
  /** false when the map point is not verified: directions then use the address. Missing from an older API. */
  locationVerified?: boolean;
  /** true: stock shown for this pharmacy is synthetic demo data that the named pharmacy has not confirmed. Missing from an older API. */
  inventorySimulated?: boolean;
}

export interface SearchResult {
  rank: number;
  score: number;
  medicine: MedicineRef;
  pharmacy: PharmacyRef;
  quantity: number;
  price: number;
  stockStatus: StockStatus;
  /** null: no distance can be claimed (the pharmacy's map point is not verified, or the origin is unknown). */
  distanceKm: number | null;
  /** true only when the distance was measured to a verified pharmacy point. Missing from an older API. */
  distanceVerified?: boolean;
  updatedAt: string;
  source: StockSource;
}

export interface Location {
  latitude: number;
  longitude: number;
}

export interface SearchFilters {
  /** Only offers with stock (low stock counts). */
  inStock?: boolean;
  maxDistanceKm?: number;
  maxPrice?: number;
  sort?: SortKey;
}

/** A catalogue medicine the query matched. `listed`: at least one pharmacy lists it (not that it is in stock). */
export interface CatalogueMatch {
  medicine: MedicineRef;
  listed: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Every catalogue medicine matched, listed or not. null: the API did not say (an older server). */
  matches: CatalogueMatch[] | null;
  /** False: live stock did not answer, so everything shown is the catalogue's last known value. */
  live: boolean;
  /** Said when the requested ordering could not be honoured (e.g. nearest first with no verified location). */
  sortNote: string | null;
  /** Results shown without a distance because their location is not verified. */
  unverifiedCount: number;
}

export interface Substitute {
  medicine: MedicineRef;
  sameStrength: boolean;
  sameForm: boolean;
  best: SearchResult;
  pharmaciesInStock: number;
}

export interface Pharmacy extends PharmacyRef {
  distanceKm: number | null;
}

export interface PharmacyStockItem {
  medicine: MedicineRef;
  quantity: number;
  price: number;
  stockStatus: StockStatus;
  updatedAt: string;
  source: StockSource;
}

export interface PharmacyStock {
  items: PharmacyStockItem[];
  /** Everything the pharmacy lists, before the name / availability filter. */
  total: number;
  live: boolean;
  summary: { inStock: number; lowStock: number; outOfStock: number };
}

export interface RestockSubscription {
  id: number;
  status: "ACTIVE" | "NOTIFIED" | "CANCELLED";
  medicine: { id: number; brandName: string; dosage: string };
  createdAt: string;
  notifiedAt: string | null;
}

export interface UserNotification {
  id: number;
  message: string;
  createdAt: string;
  deliveredAt: string | null;
}

/** An error whose message is safe and useful to show to the patient. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "validation" | "unavailable" | "network" | "notFound" | "unknown",
  ) {
    super(message);
  }
}

/** How far a pharmacy's synchronization can be trusted right now. "unknown": MedLink has no reliable evidence either way. */
export type NodeStatus = "healthy" | "degraded" | "down" | "unknown";

/** One pharmacy's synchronization status. A null metric is UNKNOWN or unavailable, never zero. */
export interface NodeStatusEntry {
  pharmacyCode: string;
  name: string;
  status: NodeStatus;
  /** One line saying what evidence decided `status`. Missing from an older API. */
  statusReason?: string;
  /** When MedLink last processed an event for the pharmacy. Not a heartbeat: a quiet pharmacy has an old value. */
  lastSyncedAt: string | null;
  /** Milliseconds from lastSyncedAt to the time of the response. */
  syncLagMs: number | null;
  /** Events still waiting in the pharmacy's own outbox. null: not available. */
  unpublishedOutbox: number | null;
  staleCount: number | null;
  duplicateCount: number | null;
  processedCount: number | null;
}

export interface NodesResponse {
  data: NodeStatusEntry[];
  meta: {
    generatedAt: string;
    /** Anything but "up": no pharmacy can be assessed. */
    redis: "up" | "down" | "not-configured";
    connector: "up" | "unreachable" | "not-configured";
    /** Whether the sync service confirmed it is running. Missing from an older API. */
    syncService?: "ready" | "not-ready" | "unreachable" | "not-configured";
    thresholds?: { degradedAfterMs: number; downAfterMs: number };
  };
}

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

interface ErrorBody {
  error?: { code?: string; message?: string; details?: { field: string; message: string }[] };
}

export type Options = { signal?: AbortSignal; fetchImpl?: typeof fetch; baseUrl?: string };

/** Maps an error response to a message that is safe and useful to show. Never exposes server text. */
async function failure(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  if (res.status === 400) {
    const detail = body.error?.details?.map((d) => d.message).join(". ");
    return new ApiError(detail || body.error?.message || "Please check your search and location.", "validation");
  }
  if (res.status === 404) return new ApiError("We couldn't find that.", "notFound");
  if (res.status === 503) return new ApiError("MedLink is temporarily unavailable. Please try again in a moment.", "unavailable");
  return new ApiError("Something went wrong on our side. Please try again.", "unknown");
}

async function call(path: string, init: RequestInit, opts: Options): Promise<Response> {
  const { signal, fetchImpl = fetch, baseUrl = API_URL } = opts;
  try {
    return await fetchImpl(`${baseUrl}${path}`, { ...init, signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError("Can't reach MedLink. Check your connection and try again.", "network");
  }
}

async function getJson<T extends { data?: unknown }>(path: string, opts: Options, expect: "array" | "object" = "array"): Promise<T> {
  const res = await call(path, {}, opts);
  if (!res.ok) throw await failure(res);
  const body = (await res.json()) as T;
  const ok = expect === "array" ? Array.isArray(body.data) : typeof body.data === "object" && body.data !== null;
  if (!ok) throw new ApiError("Unexpected response from MedLink.", "unknown");
  return body;
}

const query = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  return p.toString();
};

export async function searchMedicines(
  q: string,
  location: Location,
  opts: Options & { filters?: SearchFilters } = {},
): Promise<SearchResponse> {
  const f = opts.filters ?? {};
  const params = query({
    q,
    lat: location.latitude,
    lng: location.longitude,
    inStock: f.inStock ? "true" : undefined,
    maxDistanceKm: f.maxDistanceKm,
    maxPrice: f.maxPrice,
    sort: f.sort && f.sort !== "best" ? f.sort : undefined,
  });
  const body = await getJson<{ data: SearchResult[]; meta?: { live?: boolean; matches?: CatalogueMatch[]; sortNote?: string | null; unverifiedCount?: number } }>(`/api/search?${params}`, opts);
  const matches = Array.isArray(body.meta?.matches) ? body.meta.matches : null;
  return { results: body.data, matches, live: body.meta?.live === true, sortNote: body.meta?.sortNote ?? null, unverifiedCount: body.meta?.unverifiedCount ?? 0 };
}

/** Same-ingredient medicines that can be bought nearby, for one that is out of stock. */
export async function getSubstitutes(medicineId: number, location: Location, opts: Options = {}): Promise<{ substitutes: Substitute[]; notice: string }> {
  const body = await getJson<{ data: Substitute[]; meta?: { notice?: string } }>(
    `/api/medicines/${medicineId}/substitutes?${query({ lat: location.latitude, lng: location.longitude })}`,
    opts,
  );
  return { substitutes: body.data, notice: body.meta?.notice ?? "Strength or form may differ. Check with a pharmacist or your doctor before switching." };
}

/** Catalogue medicines matching a name, for choosing one (no stock, no location). */
export async function findMedicines(q: string, opts: Options = {}): Promise<MedicineRef[]> {
  return (await getJson<{ data: MedicineRef[] }>(`/api/medicines/search?${query({ q: q.trim(), limit: 8 })}`, opts)).data;
}

/** A directory listing that is not an inventory provider: no stock, no coordinates, no distance. */
export interface DirectoryEntry {
  code: string;
  name: string;
  area: string;
  /** As supplied or listed; may be unconfirmed (see `listingStatus`). */
  address: string;
  listingStatus: "accepted" | "provisional" | "needs-review" | "excluded";
  reason: string;
  /** How far the address can be trusted for Google Maps: "address", "approximate" (an unconfirmed lead) or "unavailable". */
  directions: "address" | "approximate" | "unavailable";
  demo: true;
  label: string;
  inventory: "none";
  locationVerified: false;
}

export async function listDirectory(opts: Options = {}): Promise<DirectoryEntry[]> {
  return (await getJson<{ data: DirectoryEntry[] }>("/api/directory", opts)).data;
}

export async function getNodes(opts: Options = {}): Promise<NodesResponse> {
  const body = await getJson<NodesResponse>("/api/nodes", opts);
  if (typeof body.meta?.generatedAt !== "string") throw new ApiError("Unexpected response from MedLink.", "unknown");
  return body;
}

export async function listPharmacies(opts: Options = {}): Promise<PharmacyRef[]> {
  return (await getJson<{ data: PharmacyRef[] }>("/api/pharmacies", opts)).data;
}

export async function getPharmacy(id: number, location: Location | null, opts: Options = {}): Promise<Pharmacy> {
  const params = location ? `?${query({ lat: location.latitude, lng: location.longitude })}` : "";
  return (await getJson<{ data: Pharmacy }>(`/api/pharmacies/${id}${params}`, opts, "object")).data;
}

export async function getPharmacyStock(id: number, filter: { q?: string; inStock?: boolean } = {}, opts: Options = {}): Promise<PharmacyStock> {
  const params = query({ q: filter.q?.trim(), inStock: filter.inStock ? "true" : undefined });
  const body = await getJson<{ data: PharmacyStockItem[]; meta?: { total?: number; live?: boolean; summary?: PharmacyStock["summary"] } }>(
    `/api/pharmacies/${id}/stock${params ? `?${params}` : ""}`,
    opts,
  );
  return {
    items: body.data,
    total: body.meta?.total ?? body.data.length,
    live: body.meta?.live === true,
    summary: body.meta?.summary ?? { inStock: 0, lowStock: 0, outOfStock: 0 },
  };
}

/** Asks to be notified when a medicine is back in stock. Asking again while still waiting is fine. */
export async function subscribeToRestock(email: string, medicineId: number, opts: Options = {}): Promise<{ subscription: RestockSubscription; alreadyWaiting: boolean }> {
  const res = await call("/api/restock-subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, medicineId }) }, opts);
  if (res.ok) {
    const body = (await res.json()) as { data?: RestockSubscription; meta?: { created?: boolean } };
    if (!body.data) throw new ApiError("Unexpected response from MedLink.", "unknown");
    return { subscription: body.data, alreadyWaiting: body.meta?.created === false };
  }
  if (res.status === 404) throw new ApiError("That medicine is no longer listed.", "validation");
  throw await failure(res);
}

export async function listSubscriptions(email: string, opts: Options = {}): Promise<RestockSubscription[]> {
  return (await getJson<{ data: RestockSubscription[] }>(`/api/restock-subscriptions?${query({ email })}`, opts)).data;
}

export async function cancelSubscription(id: number, email: string, opts: Options = {}): Promise<void> {
  const res = await call(`/api/restock-subscriptions/${id}?${query({ email })}`, { method: "DELETE" }, opts);
  if (res.ok) return;
  if (res.status === 404) throw new ApiError("That subscription was already fulfilled or cancelled.", "notFound");
  throw await failure(res);
}

export async function listNotifications(email: string, opts: Options = {}): Promise<UserNotification[]> {
  return (await getJson<{ data: UserNotification[] }>(`/api/notifications?${query({ email })}`, opts)).data;
}
