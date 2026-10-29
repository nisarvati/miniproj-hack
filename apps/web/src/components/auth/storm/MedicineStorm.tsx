"use client";

import { useEffect, useRef } from "react";
import { CURRENTS, MEDICINES, PASSERS, SPECKS, TONES, TRAILS, type Medicine, type Passer } from "./medicines";
import { MedicineShape, StormDefs, vars } from "./Shapes";
import s from "./storm.module.css";

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

function Pill({ m }: { m: Medicine }) {
  const [a, b] = TONES[m.tone];
  const style = vars({
    "--x": m.x, "--y": m.y, "--w": m.w, "--rot": `${m.rot}deg`, "--depth": m.depth, "--z": m.z,
    "--ax": m.ax, "--ay": m.ay, "--dxd": m.dxd, "--dyd": m.dyd, "--dxp": m.dxp, "--dyp": m.dyp,
    "--sw": m.sw, "--sd": m.sd, "--sp": m.sp, "--ex": m.ex, "--ey": m.ey, "--ed": m.ed,
    "--shd": m.shd || 9, "--shp": m.shp, "--ca": a, "--cb": b, "--blur": m.blur ?? 0,
  });
  return (
    <div className={`${s.slot} ${m.desktopOnly ? s.desktop : ""}`} style={style} data-medicine={m.id}>
      <div className={s.enter}>
        <div className={s.dx}>
          <div className={s.dy}>
            <div className={`${s.par} ${m.hero ? s.tilt : ""}`}>
              <div className={`${s.spin} ${m.tumble ? s.tumble : ""}`}>
                <div className={s.body}>
                  <MedicineShape shape={m.shape} n={m.id} sync={m.hero} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Passing({ p }: { p: Passer }) {
  const [a, b] = TONES[p.tone];
  const style = vars({ "--y": p.y, "--w": p.w, "--rot": `${p.rot}deg`, "--rise": p.rise, "--pd": p.pd, "--pdl": p.pdl, "--z": p.z, "--ca": a, "--cb": b, "--shd": 8, "--shp": 0 });
  return (
    <div className={`${s.slotPass} ${p.rtl ? s.rtl : ""}`} style={style} data-passing={p.id}>
      <div className={s.passer}>
        <div className={s.streak} />
        <div className={s.spin} style={vars({ "--sw": 6, "--sd": 9, "--sp": 0 })}>
          <MedicineShape shape={p.shape} n={p.id} />
        </div>
      </div>
    </div>
  );
}

/**
 * The sign-in page's hero: a choreographed storm of capsules and tablets over drifting currents and particle trails.
 * Decorative only (hidden from assistive technology, no pointer events, clipped to its own box under the sign-in panel).
 *
 * Motion is CSS. The only script is the pointer follow, which writes two CSS variables (--px, --py) straight to the stage
 * from a requestAnimationFrame loop that runs only while the value is still settling, so React never re-renders for it.
 * It is attached only for a mouse-like pointer and never under reduced motion, and everything is removed on unmount. The
 * stage also pauses its animations while it is scrolled out of view or the tab is hidden.
 */
export function MedicineStorm() {
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const win = window;
    const media = typeof win.matchMedia === "function" ? { reduce: win.matchMedia("(prefers-reduced-motion: reduce)"), fine: win.matchMedia("(hover: hover) and (pointer: fine)") } : null;

    // --- pointer follow ---
    let detach: (() => void) | null = null;
    const attach = () => {
      let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0;
      let rect: DOMRect | null = null;
      const tick = () => {
        raf = 0;
        cx += (tx - cx) * 0.09;
        cy += (ty - cy) * 0.09;
        el.style.setProperty("--px", cx.toFixed(3));
        el.style.setProperty("--py", cy.toFixed(3));
        if (Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002) raf = win.requestAnimationFrame(tick);
      };
      const kick = () => {
        if (!raf) raf = win.requestAnimationFrame(tick);
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerType === "touch") return;
        rect ??= el.getBoundingClientRect();
        tx = clamp((e.clientX - (rect.left + rect.width / 2)) / (win.innerWidth / 2));
        ty = clamp((e.clientY - (rect.top + rect.height / 2)) / (win.innerHeight / 2));
        kick();
      };
      const onLeave = () => {
        tx = 0;
        ty = 0;
        kick();
      };
      const stale = () => {
        rect = null;
      };
      win.addEventListener("pointermove", onMove, { passive: true });
      win.addEventListener("resize", stale);
      win.addEventListener("scroll", stale, { passive: true });
      win.addEventListener("blur", onLeave);
      document.documentElement.addEventListener("pointerleave", onLeave);
      detach = () => {
        win.removeEventListener("pointermove", onMove);
        win.removeEventListener("resize", stale);
        win.removeEventListener("scroll", stale);
        win.removeEventListener("blur", onLeave);
        document.documentElement.removeEventListener("pointerleave", onLeave);
        if (raf) win.cancelAnimationFrame(raf);
        el.style.removeProperty("--px");
        el.style.removeProperty("--py");
        detach = null;
      };
    };
    const sync = () => {
      detach?.();
      if (media && !media.reduce.matches && media.fine.matches) attach();
    };
    sync();
    media?.reduce.addEventListener("change", sync);
    media?.fine.addEventListener("change", sync);

    // --- pause while out of view or in a background tab ---
    let offscreen = false;
    const paused = () => {
      el.dataset.paused = offscreen || document.hidden ? "true" : "false";
    };
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(([entry]) => {
      offscreen = entry ? !entry.isIntersecting : false;
      paused();
    }) : null;
    observer?.observe(el);
    document.addEventListener("visibilitychange", paused);

    return () => {
      detach?.();
      media?.reduce.removeEventListener("change", sync);
      media?.fine.removeEventListener("change", sync);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", paused);
    };
  }, []);

  return (
    <div ref={stage} className={s.stage} aria-hidden="true" data-testid="medicine-storm">
      <StormDefs />
      <div className={s.atmos} />
      <div className={s.ring} />
      <div className={s.ring} />

      <svg className={s.currents} viewBox="0 0 600 372" preserveAspectRatio="xMidYMid slice" focusable="false">
        {CURRENTS.map((c) => (
          <path key={c.d} d={c.d} pathLength={1} strokeWidth={c.width} className={`${s.cur} ${s[c.className]}`} />
        ))}
      </svg>

      <svg className={s.trails} viewBox="0 0 600 372" preserveAspectRatio="xMidYMid slice" focusable="false">
        {TRAILS.map((t) => (
          <g key={t.d} className={t.mobile ? undefined : s.trailDesktop}>
            <path d={t.d} className={s.trailBase} />
            <path d={t.d} className={`${s.dots} ${s.dotsFine}`} />
            <path d={t.d} className={`${s.dots} ${s.dotsBold}`} style={vars({ animationDelay: `-${(t.d.length % 9) + 1}s` })} />
            {t.streak && <path d={t.d} className={s.streakLine} style={vars({ "--sdur": `${t.streak.dur}s`, "--sdel": `${t.streak.delay}s` })} />}
          </g>
        ))}
      </svg>

      <div className={s.specks}>
        {SPECKS.map(([x, y, size, dx, dy, dur, phase, warm], i) => (
          <span key={i} className={`${s.speck} ${i % 2 ? s.desktop : ""}`} style={vars({ "--x": `${x}%`, "--y": `${y}%`, "--ss": size, "--dx": dx, "--dy": dy, "--sd": `${dur}s`, "--sp": `${phase}s`, "--sg": warm ? "#a8c0a6" : "#2b6a50" })} />
        ))}
      </div>

      <div className={s.objects}>
        {MEDICINES.map((m) => (
          <Pill key={m.id} m={m} />
        ))}
        {PASSERS.map((p) => (
          <Passing key={p.id} p={p} />
        ))}
      </div>
    </div>
  );
}
