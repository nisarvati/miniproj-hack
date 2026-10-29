"use client";

import Link from "next/link";
import { useAuth } from "../../providers/auth";
import s from "./v1.module.css";

/** The homepage nav's account entry: "Sign in" when signed out, "Account" when signed in. Nothing while loading or when sign-in is not set up. */
export function LandingAuthLink() {
  const { status, user, configured } = useAuth();
  if (status === "loading" || !configured) return null;
  if (status === "authenticated" && user) {
    return (
      <Link href="/account" className={s.authLink} aria-label={`Your account: ${user.name ?? user.email ?? "signed in"}`}>
        Account
      </Link>
    );
  }
  return (
    <Link href="/signin" className={s.authLink}>
      Sign in
    </Link>
  );
}
