"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "./auth";
import { authConfigured, safeRedirect } from "./lib/auth-config";

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

/** Ends the session, then shows the sign-in page. */
export async function signOutAction(): Promise<void> {
  if (!authConfigured()) redirect("/signin");
  await signOut({ redirectTo: "/signin" });
}
