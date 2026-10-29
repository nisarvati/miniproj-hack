import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { AlertIcon, CheckIcon, InfoIcon } from "./icons";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

type Tone = "neutral" | "brand" | "ok" | "warn" | "bad" | "info";

const TONE: Record<Tone, string> = {
  neutral: "border border-control-border bg-surface text-muted shadow-control",
  brand: "border border-brand bg-brand text-on-brand",
  ok: "border border-ok-border bg-ok-soft text-ok",
  warn: "border border-warn-border bg-warn-soft text-warn",
  bad: "border border-bad-border bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
};

/* ------------------------------------------------------------------ Button */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "directions";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand text-on-brand hover:bg-brand-strong hover:text-on-brand",
  secondary: "border border-control-border bg-surface text-ink shadow-control hover:border-control-hover-border hover:bg-control-hover",
  ghost: "text-ink hover:bg-control-hover",
  danger: "border border-line bg-surface text-bad hover:bg-bad-soft",
  directions: "border border-action-border bg-action-soft text-brand hover:border-brand hover:bg-brand hover:text-on-brand",
};
const SIZE: Record<Size, string> = {
  sm: "min-h-11 gap-1.5 rounded-lg px-3 text-[0.72rem] md:h-9 md:min-h-0",
  md: "h-10 gap-2 rounded-xl px-4 text-[0.76rem]",
  lg: "h-12 gap-2 rounded-xl px-6 text-[0.82rem]",
};
const buttonClass = (variant: Variant, size: Size, extra?: string) =>
  cx(
    "ui-mono inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium uppercase tracking-[0.05em] transition-colors disabled:cursor-not-allowed disabled:opacity-55",
    VARIANT[variant],
    SIZE[size],
    extra,
  );

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button {...rest} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className,
  external,
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string; variant?: Variant; size?: Size; external?: boolean }) {
  const cls = buttonClass(variant, size, className);
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls} {...rest}>
      {children}
    </a>
  ) : (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------- Display bits */

export function Badge({ tone = "neutral", className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span {...rest} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2.5 py-1 text-xs font-semibold", TONE[tone], className)}>
      {children}
    </span>
  );
}

export type CardVariant = "glass" | "solid" | "quiet" | "overlay";

/**
 * The one card. `glass` (default): a lightly tinted, slightly translucent paper surface with a fine green-tinted rule. `solid`: nearly
 * opaque, for forms and dense information. `quiet`: flat, for explanatory panels. `overlay`: for dialogs and popovers (the only one that
 * blurs what is behind it). `interactive` adds hover and focus feedback (a 2px lift and a firmer rule); `selected` marks the chosen one
 * with a solid green rule. The look is defined once, by the `.mx-card` rules and tokens in app-theme.css.
 */
export function Card({ className, children, variant = "glass", interactive, selected, ...rest }: HTMLAttributes<HTMLDivElement> & { variant?: CardVariant; interactive?: boolean; selected?: boolean }) {
  return (
    <div {...rest} className={cx("mx-card", variant !== "glass" && `mx-card--${variant}`, interactive && "mx-card--interactive", selected && "mx-card--selected", className)}>
      {children}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("h-4 w-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity=".25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("animate-pulse rounded-[var(--card-radius-sm)] bg-line/60", className)} />;
}

export function Alert({ id, tone = "info", title, children, className, action }: { id?: string; tone?: "info" | "ok" | "warn" | "bad"; title?: string; children?: ReactNode; className?: string; action?: ReactNode }) {
  const Icon = tone === "ok" ? CheckIcon : tone === "info" ? InfoIcon : AlertIcon;
  return (
    <div id={id} role={tone === "bad" ? "alert" : "status"} className={cx("flex gap-3 rounded-[var(--card-radius-sm)] p-3.5 text-sm", TONE[tone], className)}>
      <Icon className={cx("mt-0.5 shrink-0", tone === "warn" && "text-warn-icon")} />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cx(title && "mt-0.5")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, children, action, level = 3 }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; level?: 1 | 2 | 3 }) {
  const Heading = `h${level}` as "h1" | "h2" | "h3";
  return (
    <div className="mx-card mx-card--quiet flex flex-col items-center border-dashed px-6 py-10 text-center">
      {icon && <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface text-muted">{icon}</div>}
      <Heading className="text-base font-semibold">{title}</Heading>
      {children && <p className="mt-1 max-w-md text-sm text-muted">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------- Forms */

const FIELD = "w-full rounded-xl border border-control-border bg-surface px-3.5 text-sm text-ink placeholder:text-placeholder transition-colors hover:border-muted/60 focus:border-focus";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(FIELD, "h-11", className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(FIELD, "min-h-11 cursor-pointer border-control-border bg-surface pr-8 shadow-control transition-colors hover:border-control-hover-border hover:bg-control-hover md:h-10 md:min-h-0", className)}>
      {children}
    </select>
  );
}

/** A toggle that looks like a pill. Pressed state is announced, not only coloured. */
export function Chip({ pressed, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      aria-pressed={pressed}
      className={cx(
        "inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-sm border px-3.5 text-sm font-medium transition-colors md:h-9 md:min-h-0",
        pressed ? "border-brand bg-brand-soft text-brand-ink" : "border-control-border bg-surface text-ink shadow-control hover:border-control-hover-border hover:bg-control-hover",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: ReactNode }[];
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-xl border border-line bg-surface-2 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors md:h-8 md:min-h-0",
            value === o.value ? "bg-surface text-ink shadow-sm" : "text-muted hover:bg-control-hover hover:text-ink",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The green pulse that says "this is live". */
export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("live-dot inline-block h-2 w-2 rounded-full bg-live", className)} />;
}
