"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface AuthUser {
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface AuthState {
  /** "loading" until the first answer. "unavailable": the session endpoint could not be reached; treated as signed out. */
  status: "loading" | "anonymous" | "authenticated" | "unavailable";
  user: AuthUser | null;
  /** False when the server has no Google sign-in set up, so the UI can leave "Sign in" out instead of offering a dead end. */
  configured: boolean;
}

const SIGNED_OUT: AuthState = { status: "anonymous", user: null, configured: false };
const AuthContext = createContext<AuthState>(SIGNED_OUT);
export const useAuth = () => useContext(AuthContext);

/**
 * Reads Auth.js's own session route. It only reports who is signed in (for the header); it never decides what anyone may do.
 * It asks again whenever the page changes (so signing out, which navigates without reloading, cannot leave a signed-in header
 * behind) and when the browser restores a page from its back/forward cache.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [state, setState] = useState<AuthState>({ status: "loading", user: null, configured: true });
  const [restored, setRestored] = useState(0);

  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setRestored((n) => n + 1);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { accept: "application/json" } });
        const body = (await res.json()) as { configured?: boolean; user?: { name?: string | null; email?: string | null; image?: string | null } } | null;
        if (controller.signal.aborted) return;
        if (body && body.configured === false) setState({ status: "anonymous", user: null, configured: false });
        else if (res.ok && body?.user) setState({ status: "authenticated", configured: true, user: { name: body.user.name ?? null, email: body.user.email ?? null, image: body.user.image ?? null } });
        else setState({ status: res.ok ? "anonymous" : "unavailable", user: null, configured: true });
      } catch {
        if (!controller.signal.aborted) setState({ status: "unavailable", user: null, configured: true });
      }
    })();
    return () => controller.abort();
  }, [pathname, restored]);

  const value = useMemo(() => state, [state]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
