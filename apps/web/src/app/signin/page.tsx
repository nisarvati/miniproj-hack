import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "../../auth";
import { signInWithEmail, signInWithGoogle, signUpWithEmail } from "../../auth-actions";
import { SignInPage } from "../../components/auth/SignInPage";
import { authConfigured, safeRedirect, signInErrorMessage } from "../../lib/auth-config";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string; callbackUrl?: string }> }) {
  const { error, callbackUrl } = await searchParams;
  const to = safeRedirect(callbackUrl);
  if (await getSession()) redirect(to); // already signed in
  return <SignInPage action={signInWithGoogle} emailAction={signInWithEmail} signUpAction={signUpWithEmail} error={signInErrorMessage(error)} callbackUrl={to} configured={authConfigured()} />;
}
