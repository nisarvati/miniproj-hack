"use client";

import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { cx } from "../ui/primitives";

/** Delay between consecutive cards of a group, in ms. */
export const DROP_STEP_MS = 110;

/**
 * Lets a card drop gently into place the first time it is on screen (see `.dash-drop` in app-theme.css): it starts slightly above its place, fades in and
 * settles. It only moves with `transform` and `opacity`, so nothing around it shifts. It plays once per element: a re-render caused by live data keeps the
 * same element and never replays it. `index` staggers a group; `base` offsets the group (ms). With reduced motion the card is simply there.
 */
export function Reveal({ index = 0, base = 0, as, className, children, ...rest }: { index?: number; base?: number; as?: ElementType; className?: string; children: ReactNode } & Record<string, unknown>) {
  const ref = useRef<HTMLElement | null>(null);
  const [phase, setPhase] = useState<"pending" | "in">("pending");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setPhase("in"); // no way to know when it is visible: show it
      return;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setPhase("in");
        io.disconnect();
      }
    }, { rootMargin: "0px 0px -8% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const Tag = (as ?? "div") as ElementType;
  const style = { "--drop-delay": `${base + index * DROP_STEP_MS}ms` } as CSSProperties;
  return (
    <Tag {...rest} ref={ref} data-drop={phase} style={style} className={cx("dash-drop", className)}>
      {children}
    </Tag>
  );
}
