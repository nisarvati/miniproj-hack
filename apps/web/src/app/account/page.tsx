import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "../../auth";
import { signOutAction } from "../../auth-actions";
import { AccountPage } from "../../components/auth/AccountPage";

// Per-request, always: a prerendered copy would be a frozen redirect (or a frozen account), not a session check.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your account", robots: { index: false } };

/** The one page that needs a session. The check is on the server, on every request; the browser's say-so is never enough. */
export default async function Page() {
  const session = await getSession();
  if (!session) redirect(`/signin?callbackUrl=${encodeURIComponent("/account")}`);
  return <AccountPage user={session.user} signOutAction={signOutAction} />;
}
