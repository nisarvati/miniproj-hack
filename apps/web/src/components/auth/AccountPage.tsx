"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import type { SessionUser } from "../../auth";
import { Button, Card } from "../ui/primitives";

/** Sign out, with a visible "Signing out…" while the session is being ended and the sign-in page is on its way. */
function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <>
      <Button type="submit" variant="secondary" loading={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? "Signing out" : ""}
      </span>
    </>
  );
}

/** The signed-in visitor's account page. The server has already checked the session before this renders. */
export function AccountPage({ user, signOutAction }: { user: SessionUser; signOutAction: () => void | Promise<void> }) {
  const label = user.name ?? user.email ?? "Your account";
  return (
    <div className="mx-auto max-w-md space-y-5 py-6">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">Your account</p>
        <h1 className="editorial-title mt-2 text-4xl leading-tight">{label}</h1>
      </header>
      <Card variant="solid" className="flex items-center gap-4 p-5">
        {user.image ? (
          <img src={user.image} alt="" width={56} height={56} referrerPolicy="no-referrer" className="h-14 w-14 rounded-full object-cover" />
        ) : (
          <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-soft text-xl font-bold uppercase text-brand-ink">{label.slice(0, 1)}</span>
        )}
        <div className="min-w-0">
          {user.name && <p className="truncate font-semibold">{user.name}</p>}
          {user.email && <p className="truncate text-sm text-muted">{user.email}</p>}
          <p className="mt-1 text-xs text-muted">Signed in with Google</p>
        </div>
      </Card>
      <p className="text-sm">
        <Link href="/calendar" className="font-medium text-brand underline underline-offset-2 hover:text-brand-strong">Open your medicine calendar</Link>
      </p>
      <p className="text-sm text-muted">Restock alerts still use the email address you give when you ask for one. Signing in does not change them.</p>
      <form action={signOutAction}>
        <SignOutButton />
      </form>
    </div>
  );
}
