import type { CSSProperties } from "react";
import s from "./storm.module.css";
import type { Shape } from "./medicines";

/** Gradients shared by every medicine (one set of definitions, referenced by id). Zero-size, so it takes no room. */
export function StormDefs() {
  return (
    <svg width="0" height="0" className={s.defs} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ms-cyl" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".4" />
          <stop offset=".28" stopColor="#fff" stopOpacity="0" />
          <stop offset=".68" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".36" />
        </linearGradient>
        <linearGradient id="ms-seam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset=".5" stopColor="#000" stopOpacity=".3" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="ms-spec" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".18" stopColor="#fff" stopOpacity=".85" />
          <stop offset=".8" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="ms-shine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".6" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="ms-shadow">
          <stop offset="0" stopColor="#1a1c17" stopOpacity=".34" />
          <stop offset="1" stopColor="#1a1c17" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ms-dome" cx=".35" cy=".28" r=".85">
          <stop offset="0" stopColor="#fff" stopOpacity=".6" />
          <stop offset=".45" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".3" />
        </radialGradient>
      </defs>
    </svg>
  );
}

const EDGE = "rgba(26,28,23,.42)";

/** A two-colour capsule lying along x: cylinder shading, a specular line, a seam, a rim light, and light rolling across it. */
function Capsule({ n, sync }: { n: string; sync?: boolean }) {
  const clip = `ms-cap-${n}`;
  return (
    <svg viewBox="0 0 240 118" className={s.shape} aria-hidden="true" focusable="false">
      <ellipse cx="124" cy="110" rx="98" ry="7" fill="url(#ms-shadow)" />
      <clipPath id={clip}>
        <rect width="240" height="100" rx="50" />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect width="122" height="100" className={s.pa} />
        <rect x="122" width="118" height="100" className={s.pb} />
        <rect width="240" height="100" fill="url(#ms-cyl)" />
        <rect x="113" width="18" height="100" fill="url(#ms-seam)" />
        <rect x="24" y="12" width="192" height="9" rx="4.5" fill="url(#ms-spec)" />
        <rect x="34" y="81" width="168" height="5" rx="2.5" fill="#fff" opacity=".2" />
        <rect y="0" width="46" height="100" fill="url(#ms-shine)" className={s.shine} />
        {sync && <rect y="0" width="64" height="100" fill="url(#ms-shine)" className={s.shineSync} />}
      </g>
      <rect width="240" height="100" rx="50" fill="none" stroke={EDGE} strokeWidth="1.4" />
      <rect x="2.5" y="2.5" width="235" height="95" rx="47.5" fill="none" stroke="#fff" strokeOpacity=".28" strokeWidth="1" />
    </svg>
  );
}

/** A round tablet with real thickness, a dome of light and a score line. */
function RoundTablet() {
  return (
    <svg viewBox="0 0 100 100" className={s.shape} aria-hidden="true" focusable="false">
      <ellipse cx="52" cy="91" rx="40" ry="6" fill="url(#ms-shadow)" />
      <path d="M4 48v9a46 31 0 0 0 92 0v-9z" className={s.pa} />
      <path d="M4 48v9a46 31 0 0 0 92 0v-9z" fill="#000" opacity=".34" />
      <ellipse cx="50" cy="48" rx="46" ry="31" className={s.pa} />
      <ellipse cx="50" cy="48" rx="46" ry="31" fill="url(#ms-dome)" />
      <path d="M9 51C34 62 66 62 91 51" fill="none" stroke={EDGE} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10 53.5C34 64.5 66 64.5 90 53.5" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M4 48v9a46 31 0 0 0 92 0v-9" fill="none" stroke={EDGE} strokeWidth="1.2" />
      <ellipse cx="50" cy="48" rx="46" ry="31" fill="none" stroke={EDGE} strokeWidth="1.2" />
    </svg>
  );
}

/** An oblong (caplet-shaped) tablet with thickness and a score line. */
function OblongTablet() {
  return (
    <svg viewBox="0 0 140 82" className={s.shape} aria-hidden="true" focusable="false">
      <ellipse cx="72" cy="77" rx="58" ry="5" fill="url(#ms-shadow)" />
      <rect x="2" y="13" width="136" height="58" rx="29" className={s.pa} />
      <rect x="2" y="13" width="136" height="58" rx="29" fill="#000" opacity=".36" />
      <rect x="2" y="4" width="136" height="58" rx="29" className={s.pa} />
      <rect x="2" y="4" width="136" height="58" rx="29" fill="url(#ms-cyl)" />
      <path d="M70 8C66 26 66 40 70 58" fill="none" stroke={EDGE} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M72 8C68 26 68 40 72 58" fill="none" stroke="#fff" strokeOpacity=".5" strokeWidth="1.1" strokeLinecap="round" />
      <rect x="14" y="10" width="112" height="6" rx="3" fill="url(#ms-spec)" opacity=".75" />
      <rect x="2" y="4" width="136" height="58" rx="29" fill="none" stroke={EDGE} strokeWidth="1.2" />
    </svg>
  );
}

export function MedicineShape({ shape, n, sync }: { shape: Shape; n: string; sync?: boolean }) {
  if (shape === "capsule") return <Capsule n={n} sync={sync} />;
  return shape === "round" ? <RoundTablet /> : <OblongTablet />;
}

export const vars = (v: Record<string, string | number>) => v as unknown as CSSProperties;
