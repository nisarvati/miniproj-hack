"use client";

import Link from "next/link";
import { LogoMark } from "../ui/icons";
import { AuthMenu } from "./AuthMenu";
import { LocationMenu } from "./LocationMenu";
import { TopNav } from "./nav";

/**
 * The one MedLink header: brand, the main destinations (the current one underlined), the location, and the account (with sign-out when
 * the server gave the shell a sign-out action). Every page that shows the app's chrome uses it, with one container (same width, same
 * margins, same height), so the brand, the destinations and the account sit in the same place on every page. The calendar's month
 * below it is full width; the header is not.
 */
export function AppHeader({ signOutAction }: { signOutAction?: () => void | Promise<void> }) {
  return (
    <header className="app-theme-header sticky top-0 z-40 flex-none">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
        <Link href="/" className="flex items-center gap-2.5 rounded-xl pr-1" aria-label="MedLink home">
          <LogoMark />
          <span className="text-xl font-bold tracking-[-0.04em]">MedLink<sup aria-hidden="true" className="ml-0.5 align-super text-[0.5em] font-normal">®</sup></span>
          <span aria-hidden="true" className="ml-1 hidden border-l border-line pl-3 text-[0.68rem] font-medium uppercase tracking-[0.1em] text-muted 2xl:inline whitespace-nowrap">Medicine, nearby</span>
        </Link>
        <div className="ml-2 hidden md:block">
          <TopNav />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <LocationMenu />
          <AuthMenu signOutAction={signOutAction} />
        </div>
      </div>
    </header>
  );
}
