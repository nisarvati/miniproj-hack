import type { Options } from "./api";

/** The pharmacy portal API: a separate service from the patient-facing search API, with its own sign-in. */
export const PORTAL_URL = (process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:4200").replace(/\/$/, "");

export interface PortalPharmacy {
  code: string;
  name: string;
  /** Where it is, when MedLink has an address for it. */
  address?: string | null;
  /** MedLink's own label for the account, present only when it differs from `name`. */
  registeredName?: string | null;
}
export interface PortalSession {
  email: string;
  pharmacy: PortalPharmacy;
}
export interface MedicineInfo {
  medicineCode: string;
  brandName: string;
  genericName: string;
  dosage: string;
  form: string;
}
export interface PortalStockItem extends MedicineInfo {
  quantity: number;
  price: number;
  updatedAt: string;
}
export interface StockChange {
  medicineCode: string;
  before: { quantity: number; price: number } | null;
  after: { quantity: number; price: number } | null;
  /** What the pharmacy's system recorded for the pipeline: SALE, RESTOCK, PRICE_UPDATED, MEDICINE_ADDED, ... */
  events: string[];
}

/** One entry of the pharmacy's movement history, or the result of a sale or restock. */
export interface PortalMovement {
  movementId: string;
  pharmacyCode: string;
  medicineCode: string;
  medicineName: string;
  /** A decrease is a SALE, an increase a RESTOCK. */
  operation: "SALE" | "RESTOCK";
  /** TRANSACTION: an explicit sale or restock. STOCK_COUNT: the quantity was corrected after counting the shelf. */
  source: "TRANSACTION" | "STOCK_COUNT";
  /** Units sold or received, always positive. `quantityDelta` has the sign. */
  quantity: number;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  occurredAt: string;
  /** Whether the signed-in staff member made it. No other staff identity is shown. */
  byYou: boolean;
}
export interface MovementPage {
  items: PortalMovement[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}
export interface TransactionResult {
  movement: PortalMovement;
  /** true: this exact request had already been recorded (a retry); nothing was changed again. */
  replayed: boolean;
}

/** An error whose message is safe to show to pharmacy staff. */
export class PortalError extends Error {
  constructor(
    message: string,
    public readonly kind: "unauthenticated" | "forbidden" | "invalid" | "notFound" | "conflict" | "tooMany" | "unavailable" | "network" | "unknown",
  ) {
    super(message);
  }
}

async function failure(res: Response): Promise<PortalError> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; details?: { message: string }[] } };
  // The portal's 4xx messages are written for staff ("only 3 of Crocin on the shelf"), so they are shown as they are.
  const message = body.error?.details?.map((d) => d.message).join(". ") || body.error?.message;
  if (res.status === 401) return new PortalError(message ?? "Please sign in.", "unauthenticated");
  if (res.status === 400) return new PortalError(message ?? "Please check what you entered.", "invalid");
  if (res.status === 403) return new PortalError(message ?? "You don't have access yet.", "forbidden");
  if (res.status === 404) return new PortalError(message ?? "We couldn't find that.", "notFound");
  if (res.status === 409) return new PortalError(message ?? "That conflicts with the current stock.", "conflict");
  if (res.status === 429) return new PortalError(message ?? "Too many requests. Please try again later.", "tooMany");
  if (res.status === 503) return new PortalError("The portal is temporarily unavailable. Please try again in a moment.", "unavailable");
  return new PortalError("Something went wrong on our side. Please try again.", "unknown");
}

async function requestRaw<T>(method: string, path: string, body: unknown, opts: Options, headers: Record<string, string> = {}): Promise<{ data: T; meta: Record<string, unknown> }> {
  const { signal, fetchImpl = fetch, baseUrl = PORTAL_URL } = opts;
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      signal,
      credentials: "include", // the session cookie is set by another origin (the portal), so it must be sent explicitly
      ...((body !== undefined || Object.keys(headers).length > 0) && { headers: { ...(body !== undefined && { "content-type": "application/json" }), ...headers } }),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new PortalError("Can't reach the pharmacy portal. Check your connection and try again.", "network");
  }
  if (!res.ok) throw await failure(res);
  if (res.status === 204) return { data: undefined as T, meta: {} };
  const json = (await res.json()) as { data?: T; meta?: Record<string, unknown> };
  if (json.data === undefined) throw new PortalError("Unexpected response from the portal.", "unknown");
  return { data: json.data, meta: json.meta ?? {} };
}
const request = async <T>(method: string, path: string, body: unknown, opts: Options): Promise<T> => (await requestRaw<T>(method, path, body, opts)).data;

export const getSession = (opts: Options = {}) => request<PortalSession>("GET", "/portal/me", undefined, opts);
export const signIn = (email: string, password: string, opts: Options = {}) => request<PortalSession>("POST", "/portal/login", { email, password }, opts);
/** Asks for staff access to one pharmacy. The account stays pending until MedLink approves it; it cannot sign in before then. */
export const signUp = (request_: { email: string; password: string; pharmacyCode: string }, opts: Options = {}) =>
  request<{ status: "pending" }>("POST", "/portal/signup", request_, opts);
export const signOut = (opts: Options = {}) => request<void>("POST", "/portal/logout", undefined, opts);
export const listStock = (opts: Options = {}) => request<PortalStockItem[]>("GET", "/portal/stock", undefined, opts);
export const listCatalogue = (opts: Options = {}) => request<MedicineInfo[]>("GET", "/portal/catalogue", undefined, opts);
export const updateStock = (medicineCode: string, patch: { quantity?: number; price?: number }, opts: Options = {}) =>
  request<StockChange>("PATCH", `/portal/stock/${encodeURIComponent(medicineCode)}`, patch, opts);
export const addMedicine = (item: { medicineCode: string; quantity: number; price: number }, opts: Options = {}) => request<StockChange>("POST", "/portal/stock", item, opts);
export const removeMedicine = (medicineCode: string, opts: Options = {}) => request<StockChange>("DELETE", `/portal/stock/${encodeURIComponent(medicineCode)}`, undefined, opts);

const transaction = async (path: string, item: { medicineCode: string; quantity: number }, idempotencyKey: string, opts: Options): Promise<TransactionResult> => {
  const { data, meta } = await requestRaw<PortalMovement>("POST", path, item, opts, { "Idempotency-Key": idempotencyKey });
  return { movement: data, replayed: meta.replayed === true };
};
/** Records a sale. The same `idempotencyKey` with the same request is applied once, however often it is sent. */
export const recordSale = (item: { medicineCode: string; quantity: number }, idempotencyKey: string, opts: Options = {}) => transaction("/portal/sales", item, idempotencyKey, opts);
export const recordRestock = (item: { medicineCode: string; quantity: number }, idempotencyKey: string, opts: Options = {}) => transaction("/portal/restocks", item, idempotencyKey, opts);
export async function listHistory(page: { limit: number; offset: number }, opts: Options = {}): Promise<MovementPage> {
  const { data, meta } = await requestRaw<PortalMovement[]>("GET", `/portal/history?limit=${page.limit}&offset=${page.offset}`, undefined, opts);
  const m = meta as Partial<MovementPage>;
  return { items: data, total: m.total ?? data.length, limit: m.limit ?? page.limit, offset: m.offset ?? page.offset, hasMore: m.hasMore ?? false };
}
