"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { XIcon } from "../ui/icons";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog that works from the keyboard: focus moves into it when it opens and returns to what opened it when it closes, Tab
 * stays inside, and Escape (or a click on the backdrop) closes it, unless `locked` (a save is in flight and must not be abandoned).
 * The page behind does not scroll while it is open. It eases in and out (about 150 ms, the card system's easing); when the browser
 * has no `matchMedia`, or the person asks for reduced motion, it closes at once.
 */
const EXIT_MS = 140;
export function Modal({ title, onClose, locked = false, children }: { title: string; onClose: () => void; locked?: boolean; children: ReactNode }) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  /** Close: after the exit animation, or straight away when motion is off. */
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    const animate = typeof window !== "undefined" && typeof window.matchMedia === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate) return closeRef.current();
    closingRef.current = true;
    setClosing(true);
    timer.current = window.setTimeout(() => closeRef.current(), EXIT_MS);
  }, []);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = box.current?.querySelector<HTMLElement>("input, select, textarea");
    (first ?? box.current)?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(timer.current);
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (!lockedRef.current) requestClose();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return e.preventDefault();
    const firstItem = items[0]!;
    const lastItem = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === firstItem || document.activeElement === box.current)) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  };

  return (
    <div
      className="mx-scrim fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !lockedRef.current) requestClose();
      }}
      style={{ animation: closing ? `mx-scrim-out ${EXIT_MS}ms ease forwards` : "mx-scrim-in 180ms ease backwards" }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ animation: closing ? `mx-panel-out ${EXIT_MS}ms var(--card-ease) forwards` : "mx-panel-in 200ms var(--card-ease) backwards" }}
        className="mx-card mx-card--overlay max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[var(--card-radius)] p-5 outline-none sm:rounded-[var(--card-radius)] sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="editorial-title text-2xl leading-tight">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            disabled={locked}
            onClick={requestClose}
            className="-mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors hover:bg-control-hover hover:text-ink disabled:opacity-50"
          >
            <XIcon size={18} />
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
