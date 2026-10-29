"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { BigCapsule, Capsule, Contours, MedicineMarker, NeighborhoodMap, Network, Pavement, ShopA, ShopB, ShopC, ShopD, ShopLink, ShopRing, Token } from "./art";
import { byId, isListed, LEAD_PHARMACY, markerLabel, SAMPLE_MEDICINE, SAMPLE_PHARMACIES, STATUS, VIEW, type PharmacyId } from "./data";
import s from "./heromap.module.css";
import { captionFor, INVITATION, STEP, TIMELINE } from "./story";

const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(2)}%`;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/** The card's width as a share of the frame; its left edge is kept inside the frame. */
const CARD_W = 46;

/**
 * "The Medicineverse": the illustration begins as one large capsule floating over faint contours, with an invitation. One
 * click (Explore) opens it: the capsule turns and splits, a neighbourhood is drawn, four independent example pharmacies rise,
 * markers drop, dotted connections draw and pulse, an example capsule travels to one pharmacy, and a paper annotation appears.
 * From then on it is explorable: hover, focus, click or tap a marker or a shop; Replay plays it again.
 *
 * Everything is illustrative (./data.ts): it makes no query, reads no API, and shows no real pharmacy, stock, price, distance or
 * live event. It neither blocks nor touches the search form; the visitor can ignore it. Selecting a marker before the reveal
 * has finished skips straight to the finished scene. With `prefers-reduced-motion` Explore shows the finished scene at once,
 * with no loop or continuous movement.
 */
export function HeroMap({ className, captionClassName }: { className?: string; captionClassName?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [step, setStep] = useState<number>(STEP.rest);
  const [selected, setSelected] = useState<PharmacyId | null>(null);
  const [hovered, setHovered] = useState<PharmacyId | null>(null);
  const [focused, setFocused] = useState<PharmacyId | null>(null);
  const [motion, setMotion] = useState(false);
  const [cardId, setCardId] = useState<PharmacyId | null>(null);

  const started = step > STEP.rest;
  const revealed = step >= STEP.reveal;
  const playable = step >= STEP.markers; // markers can be used from the moment they exist

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotion(!q.matches);
    update();
    q.addEventListener?.("change", update);
    return () => q.removeEventListener?.("change", update);
  }, []);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const play = useCallback(() => {
    clearTimers();
    setSelected(null);
    setHovered(null);
    setFocused(null);
    if (!motion) {
      setStep(STEP.reveal);
      return;
    }
    for (const [st, ms] of TIMELINE) timers.current.push(setTimeout(() => setStep(st), ms));
    setStep(STEP.rest); // first frame of a replay: the capsule at rest; the timeline starts it turning at once
  }, [clearTimers, motion]);

  const replay = useCallback(() => {
    clearTimers();
    setSelected(null);
    setHovered(null);
    setFocused(null);
    setStep(STEP.rest);
    if (!motion) return;
    timers.current.push(setTimeout(play, 350));
  }, [clearTimers, motion, play]);

  /** Using a marker or shop before the reveal ends simply skips the rest of it. */
  const choose = useCallback(
    (id: PharmacyId) => {
      if (!playable) return;
      if (step < STEP.reveal) {
        clearTimers();
        setStep(STEP.reveal);
        setSelected(id);
        return;
      }
      setSelected((cur) => (cur === id ? null : id));
    },
    [clearTimers, playable, step],
  );

  const shownId: PharmacyId | null = selected ?? (playable ? (hovered ?? focused) : null) ?? (revealed ? LEAD_PHARMACY : null);
  useEffect(() => {
    if (shownId) setCardId(shownId);
  }, [shownId]);

  const hit = (target: EventTarget): PharmacyId | null => {
    const d = ((target as Element).closest?.("[data-shop],[data-marker]") as HTMLElement | null)?.dataset;
    return (d?.shop ?? d?.marker ?? null) as PharmacyId | null;
  };

  const card = cardId ? byId(cardId) : null;
  const ringed = selected ?? (playable ? (hovered ?? focused) : null) ?? (revealed ? LEAD_PHARMACY : null);
  const dimOthers = selected !== null;
  const cardLeft = card ? clamp((card.pin.x - (CARD_W / 100) * VIEW.width * 0.5) / (VIEW.width / 100), 2.5, 100 - CARD_W - 2.5) : 2.5;
  const cardTop = card ? (card.pin.y + 70) / (VIEW.height / 100) : 0;

  return (
    <>
      <div
        className={[s.root, className].filter(Boolean).join(" ")}
        style={{ aspectRatio: `${VIEW.width} / ${VIEW.height}` } as CSSProperties}
        data-hero-map
        data-step={step}
        data-motion={motion ? "on" : "off"}
        data-selected={selected ?? ""}
        role="group"
        aria-label="Illustration: a medicine capsule that opens into a neighbourhood of four example pharmacies. Sample data for illustration, not live stock."
        onPointerLeave={() => setHovered(null)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setSelected(null);
        }}
      >
        <svg
          className={s.svg}
          viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
          aria-hidden="true"
          focusable="false"
          onPointerOver={(e) => e.pointerType === "mouse" && playable && setHovered(hit(e.target))}
          onClick={(e) => {
            const id = hit(e.target);
            if (id) choose(id);
          }}
        >
          <Contours gone={started} />
          <NeighborhoodMap drawn={step >= STEP.map} />
          <Pavement on={step >= STEP.shopA} />
          <ShopA on={step >= STEP.shopA} order={0} />
          <ShopB on={step >= STEP.shopB} order={0} />
          <ShopC on={step >= STEP.shopC} order={0} />
          <ShopD on={step >= STEP.shopD} order={0} />
          {SAMPLE_PHARMACIES.map((p) => (
            <ShopRing key={p.id} id={p.id} on={playable && ringed === p.id} />
          ))}
          {SAMPLE_PHARMACIES.map((p) => (
            <g key={p.id} className={`${s.linkWrap} ${playable ? s.linkWrapOn : ""}`}>
              <ShopLink p={p} lit={ringed === p.id} pulse={false} />
            </g>
          ))}
          <Network drawn={step >= STEP.network} pulses={motion && step >= STEP.network} lit={playable ? ringed : null} uid={uid} />
          {SAMPLE_PHARMACIES.map((p, i) => (
            <MedicineMarker key={p.id} p={p} shown={step >= STEP.markers} order={i} active={playable && ringed === p.id} dim={dimOthers && ringed !== p.id} relevant={revealed && isListed(p)}>
              {isListed(p) ? <Capsule /> : undefined}
            </MedicineMarker>
          ))}
          {step >= STEP.token && <Token key={`${step >= STEP.token}`} label={SAMPLE_MEDICINE} still={!motion || step >= STEP.reveal} />}
          <BigCapsule step={step} />
        </svg>

        <div className={`${s.invite} ${started ? s.inviteGone : ""}`}>
          <p className={s.inviteText}>{INVITATION}</p>
          <button type="button" className={s.explore} onClick={play} tabIndex={started ? -1 : 0}>
            Explore <span aria-hidden="true">↗</span>
          </button>
        </div>

        {playable &&
          SAMPLE_PHARMACIES.map((p) => {
            const st = STATUS[p.status];
            return (
              <button
                key={p.id}
                type="button"
                className={`${s.chip} ${ringed === p.id ? s.chipActive : ""} ${dimOthers && ringed !== p.id ? s.chipDim : ""} ${revealed ? s.chipFull : ""}`}
                style={{ top: pct(p.pin.y - 84 * p.scale, VIEW.height), right: pct(VIEW.width - (p.pin.x - 46 * p.scale - 10), VIEW.width) }}
                aria-pressed={selected === p.id}
                aria-label={markerLabel(p, SAMPLE_MEDICINE)}
                data-chip={p.id}
                onClick={() => choose(p.id)}
                onPointerEnter={(e) => e.pointerType === "mouse" && setHovered(p.id)}
                onPointerLeave={() => setHovered((h) => (h === p.id ? null : h))}
                onFocus={() => setFocused(p.id)}
                onBlur={() => setFocused((f) => (f === p.id ? null : f))}
              >
                <span aria-hidden="true">
                  {p.id.toUpperCase()}
                  <span className={s.chipWord}>
                    {" "}
                    {st.glyph} {st.short}
                  </span>
                </span>
              </button>
            );
          })}

        <div
          className={s.card}
          style={{ left: `min(${cardLeft}%, calc(100% - var(--cw) - 2.5%))`, top: `${cardTop}%` }}
          data-visible={shownId && playable ? "true" : "false"}
          data-card
          aria-hidden={selected || hovered || focused ? undefined : true}
          aria-live={selected ? "polite" : "off"}
        >
          <p className={s.cardEyebrow}>Illustration · sample availability, not live stock</p>
          <p className={s.cardTitle}>{SAMPLE_MEDICINE}</p>
          {card && (
            <p className={s.cardRow}>
              <span>{card.name}</span>
              {revealed ? (
                <strong>
                  <span aria-hidden="true">{STATUS[card.status].glyph} </span>
                  {STATUS[card.status].label}
                </strong>
              ) : (
                <strong>Independent example shop</strong>
              )}
            </p>
          )}
          <p className={s.cardFoot}>Each pharmacy keeps its own stock records.</p>
          {selected && (
            <button type="button" className={s.cardClose} onClick={() => setSelected(null)} aria-label="Clear the selected pharmacy">
              <span aria-hidden="true">×</span>
            </button>
          )}
        </div>

        <button type="button" className={`${s.replay} ${playable ? s.replayOn : ""}`} onClick={replay} tabIndex={playable ? 0 : -1} aria-label="Replay the animation">
          <span aria-hidden="true">↺ Replay</span>
        </button>
      </div>
      <p className={captionClassName} aria-hidden="true">
        <span key={captionFor(step, selected)} className={s.caption} data-caption>
          Fig. 01 · {captionFor(step, selected)}
        </span>
        <span>Example pharmacies · sample data</span>
      </p>
    </>
  );
}
