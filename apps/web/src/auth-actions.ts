"use server";

import { AuthError } from "next-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createCredentialUser, looksLikeEmail, signIn, signOut } from "./auth";
import { passwordAcceptable } from "./server/credentials/password";
import { clientAddress, credentialsAvailable, normaliseEmail, signInThrottled, signUpAllowed } from "./server/credentials/service";
import { authConfigured, authReady, safeRedirect } from "./lib/auth-config";

/** Starts the Google flow. The destination after sign-in is checked here, on the server, whatever the form said. */
export async function signInWithGoogle(formData: FormData): Promise<void> {
  const to = safeRedirect(formData.get("callbackUrl"));
  if (!authConfigured()) redirect("/signin?error=NotConfigured");
  try {
    await signIn("google", { redirectTo: to });
  } catch (err) {
    // signIn redirects to Google by throwing; only a real Auth.js error is turned into a message.
    if (err instanceof AuthError) redirect(`/signin?error=${encodeURIComponent(err.type)}`);
    throw err;
  }
}

/** The visitor's address as the request carried it, or "unknown" (no request in scope, as in a test). */
async function requestAddress(): Promise<string> {
  try {
    return clientAddress(await headers());
  } catch {
    return "unknown";
  }
}

/** Signs in with an email-and-password account. The attempt limit itself is enforced where the password is checked (auth.ts); this only tells the person. */
export async function signInWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const to = safeRedirect(formData.get("callbackUrl"));
  if (!authReady() || !credentialsAvailable()) redirect("/signin?error=NotConfigured");
  if (await signInThrottled(email, await requestAddress())) redirect("/signin?error=TooManyAttempts");
  try {
    await signIn("credentials", { email, password, redirectTo: to });
  } catch (err) {
    if (err instanceof AuthError) redirect(`/signin?error=${encodeURIComponent(err.type)}`);
    throw err; // a successful sign-in redirects by throwing: that must pass through untouched
  }
}

/** Creates an email-and-password account and then signs the visitor in. */
export async function signUpWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const to = safeRedirect(formData.get("callbackUrl"));
  if (!authReady() || !credentialsAvailable()) redirect("/signin?error=NotConfigured");
  const cleaned = normaliseEmail(email);
  if (!looksLikeEmail(cleaned) || !passwordAcceptable(password)) redirect("/signin?error=InvalidCredentials");
  if (!(await signUpAllowed(await requestAddress()))) redirect("/signin?error=TooManyAttempts");
  let failure: string | null = null;
  try {
    await createCredentialUser(cleaned, password);
  } catch (err) {
    // Only the known codes reach the URL, never a database or library message.
    failure = err instanceof Error && ["EmailTaken", "InvalidCredentials", "Unavailable"].includes(err.message) ? err.message : "Unavailable";
  }
  if (failure) redirect(`/signin?error=${failure}`);
  try {
    await signIn("credentials", { email: cleaned, password, redirectTo: to });
  } catch (err) {
    if (err instanceof AuthError) redirect(`/signin?error=${encodeURIComponent(err.type)}`);
    throw err;
  }
}

/** Ends the session, then shows the sign-in page. */
export async function signOutAction(): Promise<void> {
  if (!authReady()) redirect("/signin");
  await signOut({ redirectTo: "/signin" });
}
