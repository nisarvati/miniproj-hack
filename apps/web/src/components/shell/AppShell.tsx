"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AccountProvider } from "../providers/account";
import { AuthProvider } from "../providers/auth";
import { LocationProvider } from "../providers/location";
import { AppHeader } from "./AppHeader";
import { BottomNav } from "./nav";

/** `signOutAction` is the server's sign-out action (passed down by the root layout); without it the header simply has no sign-out button. */
export function AppShell({ children, signOutAction }: { children: ReactNode; signOutAction?: () => void | Promise<void> }) {
  // The homepage (/), the landing-page previews (/landing/...) and the sign-in page own their whole page, so they get the providers but none of the chrome.
  const pathname = usePathname();
  // The calendar is a full-window page: the very same header and navigation as every other page, the phone tab bar, and
  // no footer, margins or sidebar; the calendar fills what is left below the header.
  if (pathname === "/calendar") {
    return (
      <AuthProvider>
        <LocationProvider>
          <AccountProvider>
            <div className="app-theme app-shell-fill">
              <a href="#cal-main" className="sr-only z-50 rounded-lg bg-brand px-4 py-2 font-semibold text-on-brand focus:not-sr-only focus:fixed focus:left-4 focus:top-3">
                Skip to the calendar
              </a>
              <AppHeader signOutAction={signOutAction} />
              {children}
              <BottomNav />
            </div>
          </AccountProvider>
        </LocationProvider>
      </AuthProvider>
    );
  }
  const bare = pathname === "/" || pathname === "/signin" || pathname === "/landing" || pathname.startsWith("/landing/");
  if (bare) {
    return (
      <AuthProvider>
        <LocationProvider>
          <AccountProvider>{children}</AccountProvider>
        </LocationProvider>
      </AuthProvider>
    );
  }
  return (
    <AuthProvider>
      <LocationProvider>
        <AccountProvider>
          <div className="app-theme">
            <a href="#main" className="sr-only z-50 rounded-lg bg-brand px-4 py-2 font-semibold text-on-brand focus:not-sr-only focus:fixed focus:left-4 focus:top-3">
              Skip to content
            </a>
            <AppHeader signOutAction={signOutAction} />
            <main id="main" className="app-theme-main relative mx-auto min-h-[calc(100vh-4rem)] max-w-6xl px-4 pb-28 pt-6 md:pb-12 md:pt-8">
              {children}
            </main>
            <footer className="app-theme-footer mx-auto hidden max-w-6xl px-4 py-6 text-xs leading-relaxed text-muted md:block">
              Stock comes from each pharmacy&apos;s own system and can lag by a few seconds. Call ahead to confirm. MedLink does not give medical advice.{" "}
              <Link href="/portal" className="underline hover:text-ink">Pharmacy staff sign in</Link>
            </footer>
            <BottomNav />
          </div>
        </AccountProvider>
      </LocationProvider>
    </AuthProvider>
  );
}
