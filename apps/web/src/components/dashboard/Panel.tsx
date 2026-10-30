import Link from "next/link";
import type { ReactNode } from "react";
import { Card, cx } from "../ui/primitives";
import { Reveal } from "./Reveal";

/**
 * A dashboard section. On a window with room it is one screen: a compact heading, then a body that takes the rest of the height, so the cards inside share it.
 * (`.dash-section` in app-theme.css.) On a small window it is just a heading and its cards, and the page scrolls. `id` is what the navigation links to.
 */
export function Section({ id, title, intro, action, children }: { id: string; title: string; intro: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="dash-section flex flex-col gap-3">
      <Reveal className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 lg:flex-nowrap">
        <div className="min-w-0 lg:flex-1">
          <h2 id={`${id}-h`} className="editorial-title text-xl leading-tight md:text-2xl">{title}</h2>
          <p className="dash-intro max-w-3xl text-xs text-muted sm:text-sm">{intro}</p>
        </div>
        {action && <div className="min-w-0 max-w-full lg:shrink-0">{action}</div>}
      </Reveal>
      <div className="flex min-h-min flex-1 flex-col gap-3">{children}</div>
    </section>
  );
}

/** A chart or table card: a title, a line of description, and a body that takes the height the grid gives it. Drops into place (see Reveal). */
export function Panel({ title, description, action, index = 0, base = 0, className, children, ...rest }: { title: string; description?: ReactNode; action?: ReactNode; index?: number; base?: number; className?: string; children: ReactNode } & Record<string, unknown>) {
  return (
    <Reveal index={index} base={base} className={cx("min-h-min min-w-0", className)}>
      <Card variant="solid" className="dash-panel flex h-full flex-col gap-2 p-3.5" {...rest}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-[0.95rem] font-semibold leading-snug">{title}</h3>
            {description && <p className="dash-desc text-xs leading-snug text-muted" title={typeof description === "string" ? description : undefined}>{description}</p>}
          </div>
          {action}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5">{children}</div>
      </Card>
    </Reveal>
  );
}

/** A compact statistic. `value` is a real reading or an honest "Unavailable"; `caption` says what it is and what it is not. */
export function KpiCard({ title, value, caption, icon, index, base, tone = "neutral", note }: { title: string; value: ReactNode; caption: ReactNode; icon: ReactNode; index: number; base?: number; tone?: "neutral" | "ok" | "warn" | "bad"; note?: ReactNode }) {
  return (
    <Reveal as="li" index={index} base={base} className="min-w-0">
      <Card variant="solid" role="group" aria-label={title} className="dash-kpi flex h-full flex-col gap-1.5 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">{title}</p>
          <span aria-hidden="true" className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-lg", tone === "ok" ? "bg-ok-soft text-ok" : tone === "warn" ? "bg-warn-soft text-warn" : tone === "bad" ? "bg-bad-soft text-bad" : "bg-brand-soft text-brand")}>{icon}</span>
        </div>
        <p className="text-2xl font-bold leading-none tabular-nums text-ink">{value}</p>
        <p className="text-xs leading-snug text-muted">{caption}</p>
        {note && <p className="text-xs leading-snug text-warn">{note}</p>}
      </Card>
    </Reveal>
  );
}

/** For what only one pharmacy's staff may see: says so, instead of showing a number that is not theirs or a zero. */
export function PrivateNote({ title, children, index = 0, base = 0, className }: { title: string; children: ReactNode; index?: number; base?: number; className?: string }) {
  return (
    <Reveal index={index} base={base} className={cx("min-h-min", className)}>
      <Card variant="quiet" className="flex h-full flex-col justify-center gap-1.5 p-4">
        <h3 className="text-[0.95rem] font-semibold">{title}</h3>
        <p className="text-sm text-muted">{children}</p>
        <p className="text-sm"><Link href="/portal" className="font-semibold text-brand underline underline-offset-2">Sign in to the pharmacy portal</Link></p>
      </Card>
    </Reveal>
  );
}
