"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import { Button, Input } from "../ui/primitives";
import { GoogleIcon, LogoMark } from "../ui/icons";
import { isNotSetUpNotice } from "../../lib/auth-config";
import { Alert } from "../ui/primitives";
import s from "./signin.module.css";
import { MedicineStorm } from "./storm/MedicineStorm";

const step = (i: number) => ({ "--i": i }) as CSSProperties;

function Spinner() {
  return (
    <svg className={s.spinner} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity=".25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The Google button and its status line. While the sign-in action is running the button stays in place (same size, same label)
 * but ignores further clicks; `aria-disabled` rather than `disabled` so keyboard focus is not thrown away. The status line is
 * always on the page, so assistive technology announces the text when it appears and the layout never moves.
 */
function GoogleButton() {
  const { pending } = useFormStatus();
  const block = (e: MouseEvent) => {
    if (pending) e.preventDefault();
  };
  return (
    <>
      <button type="submit" className={s.google} aria-disabled={pending || undefined} aria-busy={pending || undefined} onClick={block}>
        <span className={s.glyph}>{pending ? <Spinner /> : <GoogleIcon size={20} />}</span>
        Continue with Google
      </button>
      <p role="status" aria-live="polite" className={s.status}>
        {pending ? "Connecting to Google…" : ""}
      </p>
    </>
  );
}

/**
 * The patient sign-in page. `action` is the server action that starts the Google flow (passed in, so this component has no
 * server dependency); `error` is already-worded text, never a raw error code; `callbackUrl` has already been checked by the server.
 * It draws the whole page (the shell gives /signin no header), in the app theme.
 */
export function SignInPage({
  action,
  emailAction,
  signUpAction,
  error,
  callbackUrl,
  configured,
  emailEnabled = true,
}: {
  action?: (formData: FormData) => void | Promise<void>;
  emailAction?: (formData: FormData) => void | Promise<void>;
  signUpAction?: (formData: FormData) => void | Promise<void>;
  error: string | null;
  callbackUrl: string;
  /** Google sign-in is set up. */
  configured: boolean;
  /** Email-and-password sign-in can actually work here (it needs the auth secret and a database). When false the form is not offered. */
  emailEnabled?: boolean;
}) {
  const [formKey, setFormKey] = useState(0);
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setFormKey((k) => k + 1);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  return (
    <div className={`app-theme ${s.page}`}>
      <a href="#main" className="sr-only z-50 rounded-lg bg-brand px-4 py-2 font-semibold text-on-brand focus:not-sr-only focus:fixed focus:left-4 focus:top-3">
        Skip to content
      </a>

      <header className={`${s.top} ${s.rise}`}>
        <Link href="/" className="flex items-center gap-2.5 rounded-xl py-1 pr-1" aria-label="MedLink home">
          <LogoMark />
          <span className="text-xl font-bold tracking-[-0.04em]">
            MedLink<sup aria-hidden="true" className="ml-0.5 align-super text-[0.5em] font-normal">®</sup>
          </span>
        </Link>
        <span aria-hidden="true" className="ui-mono hidden text-[0.68rem] font-medium uppercase tracking-[0.12em] text-muted sm:inline">Medicine, nearby</span>
      </header>

      <main id="main" className={s.grid}>
        <section className={s.intro} aria-labelledby="signin-headline">
          <p className={`${s.rise} ui-mono text-[0.72rem] font-medium uppercase tracking-[0.14em] text-brand`} style={step(1)}>Independent pharmacies, one search</p>
          <h1 id="signin-headline" className={`${s.rise} ${s.headline} editorial-title`} style={step(2)}>
            Find the medicines you need, with greater clarity.
          </h1>
          <p className={`${s.rise} ${s.lede} hidden sm:block`} style={step(3)}>
            MedLink helps you discover which nearby independent pharmacies list a medicine, so you know where to look before you travel.
          </p>
        </section>

        <div className={s.panelWrap}>
          <section className={`${s.rise} ${s.panel}`} style={step(3)} aria-labelledby="signin-title">
            <p className="ui-mono text-[0.72rem] font-medium uppercase tracking-[0.14em] text-brand">Patient access</p>
            <h2 id="signin-title" className="editorial-title mt-2 text-3xl leading-tight">Welcome to MedLink</h2>
            <p className="mt-2 text-muted">{emailEnabled ? "Sign in with Google or use an email and password." : "Sign in with Google."} You never need an account to search for medicines.</p>

            {/* "Not set up" describes the server, not a sign-in that went wrong: it is explained below, not shown as a failure. */}
            {error && !isNotSetUpNotice(error) && (
              <Alert tone="bad" title="Sign-in did not finish" className="mt-5">
                {error}
              </Alert>
            )}

            <div className="mt-5 space-y-5">
              {configured ? (
                <form key={formKey} action={action}>
                  <input type="hidden" name="callbackUrl" value={callbackUrl} />
                  <GoogleButton />
                </form>
              ) : (
                <Alert tone="info" title="Google sign-in is not set up yet">
                  {emailEnabled
                    ? "This server has no Google sign-in configured, so that option is unavailable right now. You can still use email and password below."
                    : "This server has no sign-in configured yet, so signing in is unavailable right now. You can still search for medicines without an account."}
                </Alert>
              )}

              {emailEnabled && (
                <div className="border-t border-line pt-5">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">Email and password</p>
                  <div className="mb-3 flex gap-2 rounded-xl border border-line bg-surface-2 p-1" aria-label="Email sign-in mode">
                    <button type="button" onClick={() => setMode("signin")} aria-pressed={mode === "signin"} className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${mode === "signin" ? "bg-surface text-ink shadow-sm" : "text-muted"}`}>
                      Sign in
                    </button>
                    <button type="button" onClick={() => setMode("signup")} aria-pressed={mode === "signup"} className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${mode === "signup" ? "bg-surface text-ink shadow-sm" : "text-muted"}`}>
                      Create account
                    </button>
                  </div>

                  <form action={mode === "signup" ? signUpAction ?? emailAction : emailAction ?? signUpAction} className="space-y-3">
                    <input type="hidden" name="callbackUrl" value={callbackUrl} />
                    <div>
                      <label htmlFor="signin-email" className="mb-1 block text-sm font-medium">Email</label>
                      <Input id="signin-email" name="email" type="email" autoComplete="username" required />
                    </div>
                    <div>
                      <label htmlFor="signin-password" className="mb-1 block text-sm font-medium">Password</label>
                      <Input id="signin-password" name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={8} maxLength={128} />
                    </div>
                    <Button type="submit" variant="primary" size="lg" className="w-full">{mode === "signup" ? "Create account" : "Sign in with email"}</Button>
                  </form>
                </div>
              )}
            </div>

            <p className="mt-4 border-t border-line pt-4 text-xs leading-relaxed text-muted">
              MedLink asks Google only for your name, email address and profile picture. It does not see your Google password or other Google data.
            </p>
            <p className="mt-4 text-sm">
              <Link href="/search" className="font-medium text-brand underline underline-offset-2 hover:text-brand-strong">Keep searching without signing in</Link>
            </p>
          </section>
        </div>

        <figure className={s.art}>
          <div className={s.artBox}>
            <MedicineStorm />
          </div>
          <figcaption className="ui-mono mt-2 text-[0.68rem] uppercase tracking-[0.08em] text-muted">
            Illustration: decorative medicines, not live stock or an inventory
          </figcaption>
        </figure>
      </main>

      <footer className={`${s.foot} ${s.rise}`} style={step(5)}>
        <p className="border-t border-line">
          Stock comes from each pharmacy&apos;s own system and can lag by a few seconds; the pharmacies shown are demonstration listings. Call ahead to confirm. MedLink does not give medical advice.{" "}
          <Link href="/portal" className="underline underline-offset-2 hover:text-ink">Pharmacy staff sign in</Link>
        </p>
      </footer>
    </div>
  );
}
