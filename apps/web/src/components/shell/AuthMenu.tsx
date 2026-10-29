"use client";

import Link from "next/link";
import { useFormStatus } from "react-dom";
import { useAuth } from "../providers/auth";
import { LogOutIcon } from "../ui/icons";

function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" title="Sign out" disabled={pending} aria-busy={pending || undefined} className="inline-flex h-11 items-center gap-2 rounded-xl px-2.5 text-sm font-medium text-muted transition-colors hover:bg-control-hover hover:text-ink disabled:opacity-60">
      <LogOutIcon size={17} />
      <span className="whitespace-nowrap max-xl:sr-only">{pending ? "Signing out…" : "Sign out"}</span>
    </button>
  );
}

/**
 * Header entry for patient sign-in: "Sign in" when signed out; when signed in, the person's picture or initial linking to /account, and
 * "Sign out" (the existing sign-out action, passed in by the server) when there is one. Nothing while loading or when sign-in is not set up.
 */
export function AuthMenu({ signOutAction }: { signOutAction?: () => void | Promise<void> }) {
  const { status, user, configured } = useAuth();
  if (status === "loading" || !configured) return null;
  if (status !== "authenticated" || !user) {
    return (
      <Link href="/signin" className="ui-mono inline-flex h-11 items-center rounded-xl border border-control-border bg-surface px-3 text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted shadow-control transition-colors hover:border-control-hover-border hover:bg-control-hover hover:text-ink">
        Sign in
      </Link>
    );
  }
  const label = user.name ?? user.email ?? "Account";
  return (
    <div className="flex items-center gap-1">
      <Link href="/account" aria-label={`Your account: ${label}`} className="inline-flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl border border-control-border bg-surface shadow-control transition-colors hover:border-control-hover-border hover:bg-control-hover">
        {user.image ? (
          <img src={user.image} alt="" width={44} height={44} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        ) : (
          <span aria-hidden="true" className="text-sm font-bold uppercase text-brand-ink">{label.slice(0, 1)}</span>
        )}
      </Link>
      {signOutAction && (
        <form action={signOutAction}>
          <SignOutButton />
        </form>
      )}
    </div>
  );
}
