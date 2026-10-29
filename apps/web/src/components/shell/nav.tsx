"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount } from "../providers/account";
import { useAuth } from "../providers/auth";
import { BellIcon, CalendarIcon, PulseIcon, SearchIcon, StoreIcon } from "../ui/icons";
import { cx } from "../ui/primitives";

export const NAV = [
  { href: "/search", label: "Search", Icon: SearchIcon },
  { href: "/pharmacies", label: "Pharmacies", Icon: StoreIcon },
  { href: "/notifications", label: "Notifications", Icon: BellIcon },
  // Read-only sync status: counts, times and public pharmacy names only. A role-gated version is the admin milestone.
  { href: "/dashboard", label: "Dashboard", Icon: PulseIcon },
] as const;

/** Shown only to a signed-in patient. Hiding the link is a courtesy: the page and its API check the session themselves. */
const CALENDAR = { href: "/calendar", label: "Calendar", Icon: CalendarIcon } as const;
const useNavItems = () => {
  const { status } = useAuth();
  return status === "authenticated" ? [...NAV, CALENDAR] : [...NAV];
};

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span aria-label={`${count} unread`} className="absolute -right-3 -top-2.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold leading-none text-white">
      {count > 9 ? "9+" : count}
    </span>
  );
}

/** Top navigation (tablet and up). */
export function TopNav() {
  const pathname = usePathname();
  const { unread } = useAccount();
  const items = useNavItems();
  return (
    <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
      {items.map(({ href, label, Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cx("ui-mono relative inline-flex h-10 items-center gap-2 px-3 max-lg:px-2.5 text-[0.75rem] font-medium uppercase tracking-[0.06em] underline-offset-[0.55em] transition-colors", active ? "text-ink underline decoration-2 decoration-brand" : "text-muted hover:text-ink hover:underline")}>
            <span className="relative">
              <Icon size={18} />
              {href === "/notifications" && <UnreadBadge count={unread} />}
            </span>
            {/* Tablet widths: icons only (the names stay for screen readers), so four links and the account controls fit one row. */}
            <span className="max-lg:sr-only">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** Bottom tab bar (phones): the three places, within thumb reach. */
export function BottomNav() {
  const pathname = usePathname();
  const { unread } = useAccount();
  const items = useNavItems();
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-ink bg-canvas safe-area-bottom md:hidden">
      <ul className="mx-auto grid max-w-md" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map(({ href, label, Icon }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link href={href} aria-current={active ? "page" : undefined} className={cx("ui-mono -mt-px flex h-16 flex-col items-center justify-center gap-1 border-t-2 text-[0.65rem] font-medium uppercase tracking-[0.06em]", active ? "border-brand text-brand" : "border-transparent text-muted")}>
                <span className="relative">
                  <Icon size={22} />
                  {href === "/notifications" && <UnreadBadge count={unread} />}
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
