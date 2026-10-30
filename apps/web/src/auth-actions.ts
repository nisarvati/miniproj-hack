"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { createCredentialUser, findCredentialUser, looksLikeEmail, signIn, signOut } from "./auth";
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

/** Signs in with the simple email/password account. */
export async function signInWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const to = safeRedirect(formData.get("callbackUrl"));
  if (!authReady()) redirect("/signin?error=NotConfigured");
  try {
    await signIn("credentials", { email, password, redirectTo: to });
  } catch (err) {
    if (err instanceof AuthError) redirect(`/signin?error=${encodeURIComponent(err.type)}`);
    throw err;
  }
}

/** Creates a local email/password account and then signs the visitor in. */
export async function signUpWithEmail(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const to = safeRedirect(formData.get("callbackUrl"));
  if (!authReady()) redirect("/signin?error=NotConfigured");
  const cleaned = email.toLowerCase();
  if (!looksLikeEmail(cleaned) || password.length < 8) redirect("/signin?error=InvalidCredentials");
  if (findCredentialUser(cleaned)) redirect("/signin?error=EmailTaken");
  try {
    await createCredentialUser(cleaned, password);
    await signIn("credentials", { email: cleaned, password, redirectTo: to });
  } catch (err) {
    if (err instanceof AuthError) redirect(`/signin?error=${encodeURIComponent(err.type)}`);
    if (err instanceof Error) redirect(`/signin?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
}

/** Ends the session, then shows the sign-in page. */
export async function signOutAction(): Promise<void> {
  if (!authReady()) redirect("/signin");
  await signOut({ redirectTo: "/signin" });
}
