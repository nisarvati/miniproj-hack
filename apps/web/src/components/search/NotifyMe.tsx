"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, cancelSubscription, subscribeToRestock, type MedicineRef } from "../../lib/api";
import { looksLikeEmail } from "../../lib/restock";
import { useAccount } from "../providers/account";
import { BellIcon, CheckIcon } from "../ui/icons";
import { Button, Input } from "../ui/primitives";

type State = { status: "idle" } | { status: "sending" } | { status: "error"; message: string } | { status: "done"; email: string; alreadyWaiting: boolean; subscriptionId: number };

/** Asks for an email and subscribes to a restock of this medicine. The email is remembered on this device. */
export function NotifyMe({ medicine }: { medicine: Pick<MedicineRef, "id" | "brandName" | "dosage"> }) {
  const { email: saved, setEmail: remember } = useAccount();
  const [email, setEmail] = useState(saved ?? "");
  const [state, setState] = useState<State>({ status: "idle" });
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [pendingCancel, setPendingCancel] = useState(false);
  const [cancelledMessage, setCancelledMessage] = useState("");
  const typed = useRef(false);
  // The remembered email is read from storage just after the page mounts: fill it in when it arrives, unless the
  // person has already started typing something else.
  useEffect(() => {
    if (saved && !typed.current) setEmail(saved);
  }, [saved]);
  const inputId = useId();
  const name = `${medicine.brandName} ${medicine.dosage}`;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (state.status === "sending" || pendingCancel) return;
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setState({ status: "error", message: "Enter a valid email address, e.g. name@example.com." });
      return;
    }
    setState({ status: "sending" });
    setCancelledMessage("");
    try {
      const { alreadyWaiting, subscription } = await subscribeToRestock(address, medicine.id);
      remember(address);
      setState({ status: "done", email: address.toLowerCase(), alreadyWaiting, subscriptionId: subscription.id });
    } catch (err) {
      setState({ status: "error", message: err instanceof ApiError ? err.message : "Something went wrong. Please try again." });
    }
  }

  async function undo() {
    if (state.status !== "done" || state.alreadyWaiting) return;
    const previous = state;
    setState({ status: "idle" });
    setPendingCancel(true);
    setCancelError(null);
    try {
      await cancelSubscription(previous.subscriptionId, previous.email);
      setCancelledMessage("The restock alert was cancelled.");
    } catch (err) {
      setState(previous);
      setCancelError(err instanceof ApiError ? err.message : "Couldn't cancel the alert. Please try again.");
    } finally {
      setPendingCancel(false);
    }
  }

  if (state.status === "done") {
    return (
      <>
        <div role="status" className="flex items-start gap-3 rounded-[var(--card-radius-sm)] border border-ok-border bg-ok-soft p-4 text-ok">
          <CheckIcon className="mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-semibold">{state.alreadyWaiting ? "You're already on the list." : "You're on the list."}</p>
            <p className="mt-0.5">
              We&apos;ll add an alert to your MedLink notifications when {name} is restocked at any pharmacy, and email {state.email} if email alerts are switched on. Stock in this demo is simulated.{" "}
              <Link href="/notifications" className="font-semibold underline underline-offset-2">
                See my notifications
              </Link>
            </p>
            {!state.alreadyWaiting && <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={undo}>Undo subscription</Button>}
          </div>
        </div>
        {cancelError && <p role="alert" className="mt-2 text-sm text-bad">{cancelError}</p>}
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <label htmlFor={inputId} className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
        <BellIcon size={16} className="text-brand" />
        Notify me when it&apos;s back
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={inputId}
          type="email"
          autoComplete="email"
          maxLength={254}
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            typed.current = true;
            setEmail(e.target.value);
            if (state.status === "error") setState({ status: "idle" });
          }}
          onBlur={() => {
            if (email.trim() && !looksLikeEmail(email.trim())) setState({ status: "error", message: "Enter a valid email address, e.g. name@example.com." });
          }}
          aria-invalid={state.status === "error" || undefined}
          aria-describedby={state.status === "error" ? `${inputId}-hint ${inputId}-error` : `${inputId}-hint`}
        />
        <Button type="submit" variant="primary" size="md" loading={state.status === "sending" || pendingCancel} className="h-11">
          {pendingCancel ? "Cancelling…" : state.status === "sending" ? "Saving…" : "Notify me"}
        </Button>
      </div>
      <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-muted">We&apos;ll remember this email on this device so you can see your alerts later.</p>
      {cancelledMessage && <p role="status" className="mt-2 text-sm text-ok">{cancelledMessage}</p>}
      {state.status === "error" && (
        <p id={`${inputId}-error`} role="alert" className="mt-2 text-sm text-bad">
          {state.message}
        </p>
      )}
    </form>
  );
}
