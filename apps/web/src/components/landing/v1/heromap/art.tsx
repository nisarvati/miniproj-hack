import { useEffect, useRef, type ReactNode } from "react";
import { MAP_BOTTOM, NETWORK, TOKEN_END, TOKEN_PATH, type PharmacyId, type SamplePharmacy } from "./data";
import s from "./heromap.module.css";

/** Deterministic hand-drawn wobble: the same artwork every render, no randomness on the client. */
function wobble(seed: number, i: number): number {
  const x = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 3;
}

/** A rectangle whose corners are slightly off, like a pen line. */
function Sketch({ x, y, w, h, seed, className }: { x: number; y: number; w: number; h: number; seed: number; className: string }) {
  const p = (cx: number, cy: number, i: number) => `${(cx + wobble(seed, i)).toFixed(1)} ${(cy + wobble(seed, i + 9)).toFixed(1)}`;
  return <path className={className} d={`M${p(x, y, 1)} L${p(x + w, y, 2)} L${p(x + w, y + h, 3)} L${p(x, y + h, 4)} Z`} />;
}

function Arch({ x, y, w, h, seed }: { x: number; y: number; w: number; h: number; seed: number }) {
  const r = w / 2;
  return (
    <g>
      <path className={`${s.fGlass} ${s.line}`} d={`M${x} ${y + h} L${x + wobble(seed, 1)} ${y + r} A${r} ${r} 0 0 1 ${x + w} ${y + r} L${x + w} ${y + h} Z`} />
      <path className={s.thin} d={`M${x + r} ${y + r * 0.35} L${x + r + wobble(seed, 3)} ${y + h}`} />
      <Sketch x={x - 10} y={y + h} w={w + 20} h={12} seed={seed + 4} className={`${s.fPaper} ${s.line}`} />
    </g>
  );
}

function Awning({ x, y, w, n, h = 64, a, b }: { x: number; y: number; w: number; n: number; h?: number; a: string | undefined; b: string | undefined }) {
  const step = w / n;
  return (
    <g>
      {Array.from({ length: n }, (_, i) => {
        const x0 = x + i * step;
        const x1 = x0 + step;
        return <path key={i} className={`${i % 2 ? b : a} ${s.line}`} d={`M${x0} ${y} L${x1} ${y} L${x1 + 4} ${y + h} Q${(x0 + x1) / 2 + 2} ${y + h + 22} ${x0 - 2} ${y + h} Z`} />;
      })}
      <path className={s.hatch} d={`M${x} ${y + h + 18} H${x + w}`} />
    </g>
  );
}

/** A window with a shelf of tiny bottles: each shop keeps its own stock, arranged its own way. */
function Window({ x, y, w, h, seed, pane = true }: { x: number; y: number; w: number; h: number; seed: number; pane?: boolean }) {
  const shelfY = y + h * 0.62;
  const bottles = [0.12, 0.27, 0.4, 0.58, 0.72, 0.86].filter((_, i) => (i + seed) % 3 !== 0);
  return (
    <g>
      <Sketch x={x} y={y} w={w} h={h} seed={seed} className={`${s.fGlass} ${s.line}`} />
      <path className={s.glint} d={`M${x + 30} ${y + h} L${x + 80} ${y}`} />
      {bottles.map((t, i) => {
        const bh = 18 + ((i * 7 + seed * 3) % 5) * 5;
        return <rect key={t} className={`${i % 2 ? s.fForest : s.fSage} ${s.lineThin}`} x={x + w * t} y={shelfY - bh} width="13" height={bh} rx="3" />;
      })}
      <path className={s.line} d={`M${x + 6} ${shelfY} H${x + w - 6}`} />
      {pane && <path className={s.thin} d={`M${x + w / 2} ${y} V${y + h}`} />}
      <Sketch x={x - 8} y={y + h} w={w + 16} h={11} seed={seed + 2} className={`${s.fPaper} ${s.line}`} />
    </g>
  );
}

function Door({ x, y, h, seed, className = s.fForest, transom = false }: { x: number; y: number; h: number; seed: number; className?: string | undefined; transom?: boolean }) {
  return (
    <g>
      <Sketch x={x} y={y} w={96} h={h} seed={seed} className={`${className} ${s.line}`} />
      <Sketch x={x + 16} y={y + 14} w={64} h={transom ? 38 : 66} seed={seed + 1} className={`${s.fGlass} ${s.lineThin}`} />
      <circle className={s.fPaper} cx={x + 80} cy={y + h * 0.58} r="4.5" />
    </g>
  );
}

/** Faint topographic contours and tiny architectural marks: the hint, before the click, that a neighbourhood is hidden in the paper. */
export function Contours({ gone }: { gone: boolean }) {
  const rings = [
    "M250 560 C 260 380 470 300 700 330 C 960 360 1180 300 1340 470 C 1470 620 1380 840 1190 930 C 960 1040 700 1010 520 920 C 340 840 240 720 250 560 Z",
    "M330 580 C 345 440 500 380 700 405 C 930 430 1120 385 1245 515 C 1350 625 1285 800 1130 870 C 950 950 730 925 580 855 C 440 790 320 700 330 580 Z",
    "M420 600 C 440 500 560 455 710 475 C 880 495 1020 465 1110 555 C 1190 635 1150 750 1040 800 C 910 855 750 840 650 790 C 530 735 410 690 420 600 Z",
    "M520 630 C 540 560 620 530 720 545 C 830 560 920 540 985 600 C 1040 655 1010 730 935 760 C 850 795 760 785 695 750 C 610 710 510 690 520 630 Z",
  ];
  return (
    <g className={`${s.contours} ${gone ? s.contoursGone : ""}`}>
      {rings.map((d, i) => (
        <path key={i} className={s.contour} style={{ ["--c" as string]: i }} d={d} />
      ))}
      {/* tiny shopfronts, pins and survey marks, drawn like marginalia */}
      <g className={s.marginalia}>
        <path className={s.tick} d="M330 330 h38 v34 h-38 Z M341 342 h16 M341 352 h16" />
        <path className={s.tick} d="M1240 1190 q22 -34 44 0 M1232 1190 h60 M1244 1190 v26 h36 v-26" />
        <path className={s.tick} d="M1330 360 c0 -20 28 -20 28 0 c0 14 -14 28 -14 28 c0 0 -14 -14 -14 -28 Z" />
        <path className={s.tick} d="M300 1050 h90 M300 1042 v16 M390 1042 v16 M345 1046 v8" />
        <path className={s.tick} d="M1180 1130 h44 M1202 1108 v44" />
        <circle className={s.speck} cx="480" cy="1180" r="4" />
        <circle className={s.speck} cx="1380" cy="1000" r="3.4" />
        <circle className={s.speck} cx="760" cy="250" r="3" />
      </g>
    </g>
  );
}

/**
 * The neighbourhood sheet. Its lines are drawn in thin forest green first (a pen drawing the plan), then the cream roads and the
 * sage ground fade in beneath. `drawn` starts the drawing; before it everything is invisible.
 */
export function NeighborhoodMap({ drawn }: { drawn: boolean }) {
  const roads: [string, string][] = [
    ["M250 210 L1600 170", "h1"],
    ["M250 880 L1600 806", "h2"],
    ["M463 0 L441 1130", "v1"],
    ["M876 0 L907 1130", "v2"],
    ["M1250 0 L1268 1130", "v3"],
    ["M250 990 L980 0", "d1"],
  ];
  return (
    <g className={`${s.mapSheet} ${drawn ? s.mapDrawn : ""}`}>
      <g className={s.mapGround}>
        <rect className={`${s.fPale} ${s.line}`} x="250" y="0" width="1350" height={MAP_BOTTOM} />
        <path className={s.fSage} d="M1330 90 C 1330 50 1380 38 1430 48 C 1490 62 1510 110 1490 150 C 1450 190 1360 184 1330 90 Z" />
        <path className={s.fSage} d="M1300 880 C 1300 810 1370 790 1440 800 C 1520 812 1548 880 1530 960 C 1505 1030 1420 1038 1300 1030 Z" />
        <path className={s.river} d="M250 330 C 440 292 560 330 700 340 C 840 350 940 380 1080 340 C 1250 290 1420 270 1600 305" />
        <path className={s.grid} d="M250 650 L1100 620 M1100 0 L1108 1130 M690 0 V1130 M250 1010 L1600 985" />
        {[[560, 110], [740, 260], [1020, 470], [610, 740], [980, 1000], [1400, 470], [330, 400], [770, 1080], [1180, 90], [1500, 700]].map(([cx, cy], i) => (
          <circle key={i} className={s.speck} cx={cx} cy={cy} r={i % 3 ? 2.4 : 3.4} />
        ))}
      </g>
      {roads.map(([d, k], i) => (
        <g key={k}>
          <path className={s.roadEdge} d={d} />
          <path className={s.road} d={d} />
          <path className={s.roadInk} style={{ ["--i" as string]: i }} d={d} pathLength={100} />
        </g>
      ))}
      <path className={s.tick} d="M1480 1080 v34 M1463 1097 h34" />
    </g>
  );
}

/** The ground the shops stand on; it draws in just before the first shop rises. */
export function Pavement({ on }: { on: boolean }) {
  return (
    <g className={`${s.emerge} ${on ? s.emergeOn : ""}`} style={{ ["--i" as string]: 0 }}>
      <Sketch x={70} y={1775} w={1470} h={56} seed={7} className={`${s.fPale} ${s.line}`} />
      {[250, 400, 560, 740, 950, 1160, 1330, 1500].map((tx) => (
        <path key={tx} className={s.thin} d={`M${tx} 1775 V1831`} />
      ))}
      <path className={s.line} d="M1518 1775 V1450 q0 -34 28 -34" />
      <circle className={`${s.fPaper} ${s.line}`} cx="1550" cy="1418" r="9" />
    </g>
  );
}

export function ShopA({ on, order }: { on: boolean; order: number }) {
  return (
    <g className={`${s.emerge} ${on ? s.emergeOn : ""}`} style={{ ["--i" as string]: order }} data-shop="a">
        <Sketch x={100} y={1260} w={300} h={515} seed={11} className={`${s.fPale} ${s.line}`} />
        <Sketch x={92} y={1258} w={316} h={28} seed={12} className={`${s.fSage} ${s.line}`} />
        <Arch x={135} y={1330} w={70} h={130} seed={13} />
        <Arch x={295} y={1330} w={70} h={130} seed={14} />
        <Sketch x={118} y={1482} w={264} h={40} seed={15} className={`${s.fPaper} ${s.line}`} />
        <circle className={s.fForest} cx="140" cy="1502" r="8" />
        <Awning x={100} y={1530} w={300} n={4} a={s.fForest} b={s.fPaper} />
        <Window x={120} y={1625} w={150} h={115} seed={16} />
        <Door x={290} y={1610} h={165} seed={17} />
        <Sketch x={125} y={1744} w={140} h={31} seed={18} className={`${s.fDeep} ${s.line}`} />
    </g>
  );
}

export function ShopB({ on, order }: { on: boolean; order: number }) {
  return (
    <g className={`${s.emerge} ${on ? s.emergeOn : ""}`} style={{ ["--i" as string]: order }} data-shop="b">
        <Sketch x={400} y={1390} w={340} h={385} seed={21} className={`${s.fPaper} ${s.line}`} />
        <Sketch x={392} y={1388} w={356} h={26} seed={22} className={`${s.fSage} ${s.line}`} />
        <circle className={`${s.fPale} ${s.line}`} cx="570" cy="1447" r="30" />
        <circle className={s.thin} cx="570" cy="1447" r="19" />
        <Sketch x={520} y={1482} w={100} h={18} seed={23} className={`${s.fForest} ${s.line}`} />
        {[532, 552, 572, 592, 608].map((px, i) => (
          <circle key={px} className={`${i % 2 ? s.fSage : s.fPale} ${s.lineThin}`} cx={px} cy={1474 - (i % 2) * 5} r="9" />
        ))}
        <Awning x={400} y={1512} w={340} n={5} a={s.fSage} b={s.fDeep} h={56} />
        <Window x={425} y={1608} w={170} h={128} seed={24} />
        <Door x={628} y={1595} h={180} seed={25} className={s.fDeep} />
        <Sketch x={430} y={1745} w={160} h={30} seed={26} className={`${s.fForest} ${s.line}`} />
    </g>
  );
}

export function ShopC({ on, order }: { on: boolean; order: number }) {
  return (
    <g className={`${s.emerge} ${on ? s.emergeOn : ""}`} style={{ ["--i" as string]: order }} data-shop="c">
        <Sketch x={740} y={1230} w={420} h={545} seed={31} className={`${s.fPaper} ${s.line}`} />
        <Sketch x={740} y={1185} w={420} h={48} seed={32} className={`${s.fPaper} ${s.line}`} />
        <Sketch x={850} y={1190} w={200} h={28} seed={33} className={`${s.fPale} ${s.line}`} />
        <Sketch x={730} y={1226} w={440} h={24} seed={34} className={`${s.fSage} ${s.line}`} />
        <Arch x={775} y={1290} w={84} h={150} seed={35} />
        <Arch x={1050} y={1290} w={84} h={150} seed={36} />
        <circle className={`${s.fPaper} ${s.line}`} cx="950" cy="1362" r="62" />
        <circle className={s.thinForest} cx="950" cy="1362" r="52" />
        <g transform="translate(950 1362) rotate(-38)">
          <rect className={`${s.fForest} ${s.line}`} x="-34" y="-14" width="68" height="28" rx="14" />
          <path className={`${s.fPale} ${s.line}`} d="M0 -14 H20 A14 14 0 0 1 20 14 H0 Z" />
        </g>
        <Awning x={740} y={1480} w={420} n={7} a={s.fForest} b={s.fPaper} h={66} />
        <Window x={770} y={1615} w={225} h={122} seed={37} />
        <Door x={1015} y={1600} h={175} seed={38} />
        <Sketch x={775} y={1745} w={215} h={30} seed={39} className={`${s.fDeep} ${s.line}`} />
    </g>
  );
}

export function ShopD({ on, order }: { on: boolean; order: number }) {
  return (
    <g className={`${s.emerge} ${on ? s.emergeOn : ""}`} style={{ ["--i" as string]: order }} data-shop="d">
        <Sketch x={1160} y={1330} w={340} h={445} seed={41} className={`${s.fSoft} ${s.line}`} />
        <Sketch x={1152} y={1328} w={356} h={26} seed={42} className={`${s.fDeep} ${s.line}`} />
        <Window x={1195} y={1385} w={125} h={105} seed={43} pane />
        <Window x={1345} y={1385} w={96} h={105} seed={44} pane={false} />
        <path className={s.line} d="M1500 1395 H1540" />
        <circle className={`${s.fPaper} ${s.line}`} cx="1540" cy="1428" r="24" />
        <path className={`${s.fForest} ${s.lineThin}`} d="M1530 1438 C 1528 1420 1545 1412 1552 1418 C 1553 1432 1543 1440 1530 1438 Z" />
        <Awning x={1160} y={1525} w={340} n={6} a={s.fSage} b={s.fForest} h={54} />
        <Window x={1185} y={1618} w={140} h={118} seed={45} />
        <Door x={1345} y={1604} h={171} seed={46} className={s.fForest} transom />
        <Sketch x={1190} y={1745} w={130} h={30} seed={47} className={`${s.fDeep} ${s.line}`} />
    </g>
  );
}

/**
 * The dotted connections between the independent pharmacies, revealed along their length by a mask, with a slow pulse of
 * "information" travelling each one now and then. `lit` lists the connections of the selected pharmacy.
 */
export function Network({ drawn, pulses, lit, uid }: { drawn: boolean; pulses: boolean; lit: PharmacyId | null; uid: string }) {
  return (
    <g className={`${s.network} ${drawn ? s.networkOn : ""}`}>
      <defs>
        {NETWORK.map((e, i) => (
          <mask key={e.key} id={`${uid}-n-${e.key}`} maskUnits="userSpaceOnUse" x="0" y="0" width="1600" height="1200">
            <path className={s.netReveal} style={{ ["--i" as string]: i }} d={e.d} pathLength={100} />
          </mask>
        ))}
      </defs>
      {NETWORK.map((e, i) => {
        const on = lit !== null && e.ends.includes(lit);
        return (
          <g key={e.key} className={`${on ? s.netLit : ""} ${lit !== null && !on ? s.netQuiet : ""}`}>
            <path className={s.netDots} d={e.d} mask={`url(#${uid}-n-${e.key})`} />
            {pulses && <path className={s.netPulse} style={{ ["--i" as string]: i }} d={e.d} pathLength={100} />}
          </g>
        );
      })}
    </g>
  );
}

/** A small capsule tagged with an example medicine, travelling the network to a pharmacy. SMIL moves it, so it starts the moment it is drawn. */
export function Token({ label, still }: { label: string; still: boolean }) {
  const motion = useRef<SVGAnimationElement>(null);
  // SMIL times are relative to the SVG's own clock, so a "0s" start would already be in the past: start it explicitly when it is drawn.
  useEffect(() => {
    if (!still) motion.current?.beginElement?.();
  }, [still]);
  const body = (
    <g>
      <g transform="rotate(-24)">
        <rect className={`${s.fForest} ${s.line}`} x="-40" y="-17" width="80" height="34" rx="17" />
        <path className={`${s.fPale} ${s.line}`} d="M0 -17 H23 A17 17 0 0 1 23 17 H0 Z" />
      </g>
      <rect className={`${s.fPaper} ${s.lineThin}`} x="-96" y="-76" width="192" height="36" />
      <text className={s.tokenText} x="0" y="-51" textAnchor="middle">
        {label}
      </text>
    </g>
  );
  return still ? (
    <g transform={`translate(${TOKEN_END.x} ${TOKEN_END.y})`}>{body}</g>
  ) : (
    <g className={s.token}>
      <g>
        {body}
        <animateMotion ref={motion} dur="2.4s" begin="indefinite" fill="freeze" path={TOKEN_PATH} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.25 1" />
      </g>
    </g>
  );
}

/**
 * The capsule: two halves that rotate upright and split. The halves sit in groups with no transform attribute, so CSS can move
 * them without displacing the artwork; the position is an attribute on the outer group.
 */
export function BigCapsule({ step }: { step: number }) {
  return (
    <g transform="translate(800 930)" className={`${s.capsule} ${step >= 3 ? s.capsuleGone : ""}`}>
      <g className={`${s.capsuleFloat}`}>
        <g className={`${s.capsuleSpin} ${step >= 1 ? s.capsuleUpright : ""}`}>
          <g className={`${s.halfL} ${step >= 2 ? s.halfSplit : ""}`}>
            <path className={`${s.fForest} ${s.lineHeavy}`} d="M0 -150 H-230 A150 150 0 0 0 -230 150 H0 Z" />
            <path className={s.glintSoft} d="M-300 -100 H-120" />
            <path className={s.hatchInk} d="M-60 -130 V130 M-100 -130 V130 M-140 -130 V130" />
          </g>
          <g className={`${s.halfR} ${step >= 2 ? s.halfSplit : ""}`}>
            <path className={`${s.fPaper} ${s.lineHeavy}`} d="M0 -150 H230 A150 150 0 0 1 230 150 H0 Z" />
            <path className={s.fSage} d="M0 -150 H110 V150 H0 Z" />
            <path className={s.glintSoft} d="M160 -110 H300" />
            <path className={s.hatchInk} d="M150 -130 V130 M190 -130 V130" />
          </g>
          <ellipse className={`${s.seam} ${step >= 2 ? s.seamOn : ""}`} cx="0" cy="0" rx="40" ry="150" />
        </g>
      </g>
    </g>
  );
}
/** The outline a shop gets when its pharmacy is highlighted or selected. */
const RINGS: Record<PharmacyId, [number, number, number, number]> = {
  a: [90, 1250, 320, 535],
  b: [384, 1380, 372, 405],
  c: [722, 1178, 456, 605],
  d: [1144, 1320, 372, 465],
};
export function ShopRing({ id, on }: { id: PharmacyId; on: boolean }) {
  const [x, y, w, h] = RINGS[id];
  return <rect className={`${s.ring} ${on ? s.ringOn : ""}`} x={x} y={y} width={w} height={h} rx="6" />;
}

/** The dotted line from a pin down to its shop. `lit` firms it up for the highlighted pharmacy. */
export function ShopLink({ p, lit, pulse }: { p: SamplePharmacy; lit: boolean; pulse: boolean }) {
  const d = `M${p.pin.x} ${p.pin.y + 14} L${p.roof.x} ${p.roof.y - 8}`;
  return (
    <g className={`${s.link} ${lit ? s.linkLit : ""}`}>
      <path className={s.linkLine} d={d} />
      <path className={s.linkGlow} d={d} pathLength={100} />
      {pulse && <path className={s.linkPulse} d={d} pathLength={100} />}
      <circle className={`${s.fPaper} ${s.anchor}`} cx={p.roof.x} cy={p.roof.y} r="9" />
    </g>
  );
}

/** A pin. `children` is the symbol in its head. It drops in from above (`shown`, staggered by `order`); scale grows around the tip so the tip stays on its map point. */
export function MedicineMarker({ p, active, dim, relevant, shown, order, children }: { p: SamplePharmacy; active: boolean; dim: boolean; relevant: boolean; shown: boolean; order: number; children?: ReactNode }) {
  return (
    <g transform={`translate(${p.pin.x} ${p.pin.y})`} className={`${s.pinOuter} ${active ? s.pinActive : ""} ${dim ? s.pinDim : ""} ${relevant ? s.pinRelevant : ""}`} data-marker={p.id}>
      <g className={`${s.drop} ${shown ? s.dropOn : ""}`} style={{ ["--i" as string]: order }}>
        <ellipse className={s.pinShadow} cx="0" cy="4" rx={34 * p.scale} ry={7 * p.scale} />
        <g transform={`scale(${p.scale})`}>
          <g className={`${s.pinFloat} ${s[`float${p.id.toUpperCase()}` as "floatA"]}`}>
            <circle className={s.halo} cx="0" cy="-84" r="52" />
            <path className={`${s.fForest} ${s.line}`} d="M0 0 C -8 -30 -37 -50 -37 -84 a37 37 0 1 1 74 0 C 37 -50 8 -30 0 0 Z" />
            {children ?? <circle className={s.fPaper} cx="0" cy="-84" r="12" />}
          </g>
        </g>
      </g>
    </g>
  );
}

export function Capsule() {
  return (
    <g transform="translate(0 -84) rotate(-38)">
      <rect className={`${s.fPaper} ${s.lineThin}`} x="-19" y="-9" width="38" height="18" rx="9" />
      <path className={s.fSage} d="M0 -9 H10 A9 9 0 0 1 10 9 H0 Z" />
    </g>
  );
}
