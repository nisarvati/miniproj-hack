import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "../../auth";
import { CalendarPage } from "../../components/calendar/CalendarPage";

// Per-request, always: a prerendered copy would be a frozen redirect (or someone's page), not a session check.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Medicine calendar", robots: { index: false } };

/** A page that needs a session. The check is on the server, on every request; the calendar API checks it again on every call. */
export default async function Page() {
  const session = await getSession();
  if (!session) redirect(`/signin?callbackUrl=${encodeURIComponent("/calendar")}`);
  // Keyed by the person, so one person's page state can never carry over to another's.
  return <CalendarPage key={session.user.email ?? "patient"} />;
}
