import { createHash } from "node:crypto";
import { getCalendarDb } from "../db";
import { hashPassword, passwordAcceptable, verifyAgainstDummy, verifyPassword } from "./password";
import { MemoryCredentialStore, PgCredentialStore, type CredentialAccount, type CredentialStore, type Window } from "./store";

/**
 * Email-and-password accounts for patients. Accounts and attempt counters live in the central PostgreSQL; passwords are salted scrypt hashes; sign-in and
 * sign-up are rate limited per address and per address-and-email, in the database so the limit holds across server instances.
 *
 * These accounts are not verified: the email is whatever the person typed. It is shown back to them and nothing else; it is never used to find, link or merge
 * anything, and the patient calendar still requires a Google identity (see getPatientIdentity in auth.ts).
 */

export const normaliseEmail = (value: string): string => value.trim().toLowerCase();
export const looksLikeEmail = (value: string): boolean => value.trim().length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export const SIGN_IN_LIMITS: { perAccount: Window; perAddress: Window } = {
  perAccount: { limit: 8, windowMs: 15 * 60_000 },
  perAddress: { limit: 40, windowMs: 15 * 60_000 },
};
export const SIGN_UP_LIMIT: Window = { limit: 10, windowMs: 60 * 60_000 };

let override: CredentialStore | null | undefined;
/** Tests only: replaces the store (null: none available). undefined: back to the default. */
export function setCredentialStoreForTesting(store: CredentialStore | null | undefined): void {
  override = store;
}

let memory: MemoryCredentialStore | undefined;
let warned = false;

/**
 * The store to use, or null when email sign-in is not available. With a database configured (DATABASE_URL, the same one the calendar uses) it is that database.
 * Without one it is NOT available in production, and outside production a throwaway in-memory store is used for a quick local run (with a warning).
 */
export function getCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore | null {
  if (override !== undefined) return override;
  const db = getCalendarDb();
  if (db) return new PgCredentialStore(db);
  if (env.NODE_ENV === "production") return null;
  if (!warned) {
    warned = true;
    console.warn("[auth] DATABASE_URL is not set: email-and-password accounts are kept in memory and disappear on restart (development only)");
  }
  return (memory ??= new MemoryCredentialStore());
}

export const credentialsAvailable = (): boolean => getCredentialStore() !== null;

const need = (): CredentialStore => {
  const store = getCredentialStore();
  if (!store) throw new Error("Unavailable");
  return store;
};

/** The address to count attempts against. Vercel and most hosts put the real visitor first in X-Forwarded-For. A guess at worst weakens the per-address limit only. */
export function clientAddress(headers: { get(name: string): string | null } | undefined): string {
  const forwarded = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers?.get("x-real-ip")?.trim() || "unknown";
}

/** A fixed-length key that does not contain the address or the email. */
const keyOf = (kind: string, value: string): string => `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 40)}`;
export const signInKeys = (email: string, address: string) => ({ account: keyOf("signin-acct", `${address}|${normaliseEmail(email)}`), address: keyOf("signin-ip", address) });

/** Creates an account. Throws Error("InvalidCredentials" | "EmailTaken" | "Unavailable"): codes, never a database message. */
export async function createCredentialUser(email: string, password: string): Promise<CredentialAccount> {
  const cleaned = normaliseEmail(email);
  if (!looksLikeEmail(cleaned) || !passwordAcceptable(password)) throw new Error("InvalidCredentials");
  const store = need();
  let result: CredentialAccount | "EMAIL_TAKEN";
  try {
    result = await store.create({ email: cleaned, name: (cleaned.split("@")[0] || "MedLink user").slice(0, 100), passwordHash: await hashPassword(password) });
  } catch {
    throw new Error("Unavailable");
  }
  if (result === "EMAIL_TAKEN") throw new Error("EmailTaken");
  return result;
}

/** Whether an account exists for this email. Public fields only. */
export async function findCredentialUser(email: string): Promise<CredentialAccount | null> {
  const found = await need().find(normaliseEmail(email));
  return found ? { id: found.id, email: found.email, name: found.name } : null;
}

/** The right password for an existing account gives that account; anything else gives null, after the same amount of work. No throttling here (see authenticateCredentials). */
export async function verifyCredentialUser(email: string, password: string): Promise<CredentialAccount | null> {
  const found = await need().find(normaliseEmail(email));
  if (!found) return verifyAgainstDummy(password).then(() => null);
  return (await verifyPassword(password, found.passwordHash)) ? { id: found.id, email: found.email, name: found.name } : null;
}

/**
 * The one door a sign-in goes through (Auth.js calls it, so a request sent straight to the Auth.js endpoint cannot skip the limit): counts the attempt against the
 * address and the address-and-email, refuses when either limit is passed, otherwise checks the password. A correct password clears that account's counter.
 * Never throws: a store that fails means "no".
 */
export async function authenticateCredentials(email: string, password: string, address: string): Promise<CredentialAccount | null> {
  try {
    const store = getCredentialStore();
    if (!store) return null;
    const keys = signInKeys(email, address);
    const [byAddress, byAccount] = [await store.consume(keys.address, SIGN_IN_LIMITS.perAddress), await store.consume(keys.account, SIGN_IN_LIMITS.perAccount)];
    if (!byAddress.allowed || !byAccount.allowed) return null;
    const user = await verifyCredentialUser(email, password);
    if (user) await store.clear(keys.account);
    return user;
  } catch {
    return null;
  }
}

/** Whether a sign-in attempt from this address for this email would be refused right now. Counts nothing: it only lets the form say "too many attempts". */
export async function signInThrottled(email: string, address: string): Promise<boolean> {
  try {
    const store = getCredentialStore();
    if (!store) return false;
    const keys = signInKeys(email, address);
    const [a, b] = await Promise.all([store.peek(keys.address, SIGN_IN_LIMITS.perAddress), store.peek(keys.account, SIGN_IN_LIMITS.perAccount)]);
    return !a.allowed || !b.allowed;
  } catch {
    return false;
  }
}

/** Counts a sign-up attempt from this address. false: over the limit. A store that fails does not block sign-up here (creating the account will report it). */
export async function signUpAllowed(address: string): Promise<boolean> {
  try {
    const store = getCredentialStore();
    if (!store) return true;
    return (await store.consume(keyOf("signup-ip", address), SIGN_UP_LIMIT)).allowed;
  } catch {
    return true;
  }
}
