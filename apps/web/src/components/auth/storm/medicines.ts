/**
 * The Medicine Particle Storm, as data. Positions are percentages of the stage; sizes and drifts are in `cqw` (1% of the
 * stage's width), so the whole scene scales with its container. Nothing here is random: the same scene renders on the
 * server and in the browser. Every object has its own durations and phases so no two move in step.
 */

export type Shape = "capsule" | "round" | "oblong";

/** Physical colours of the medicines themselves (they do not change with the theme): forest, sage, ivory, charcoal. */
const C = { forest: "#2b6a50", deep: "#1f4d3a", sage: "#a8c0a6", ivory: "#f5f0df", ink: "#2d312b" } as const;
export const TONES = {
  forestIvory: [C.forest, C.ivory],
  sageIvory: [C.sage, C.ivory],
  forestSage: [C.forest, C.sage],
  inkIvory: [C.ink, C.ivory],
  ivory: [C.ivory, C.ivory],
  sage: [C.sage, C.sage],
  forest: [C.forest, C.forest],
  deep: [C.deep, C.deep],
} as const;
export type Tone = keyof typeof TONES;

export interface Medicine {
  id: string;
  shape: Shape;
  tone: Tone;
  /** Centre, % of the stage. */
  x: number;
  y: number;
  /** Width in cqw. */
  w: number;
  /** Resting angle, degrees. */
  rot: number;
  /** 0 (far) to 1 (near): how strongly it follows the pointer, and which layer it sits on. */
  depth: number;
  z: 1 | 2 | 3 | 4;
  /** Gaussian blur in px for out-of-focus objects. */
  blur?: number;
  /** Left out on narrow screens, to keep the scene light. */
  desktopOnly?: boolean;
  /** The main capsule: tilts towards the pointer and is struck by passing light. */
  hero?: boolean;
  /** A tablet that slowly tumbles end over end instead of swaying. */
  tumble?: number;
  /** Drift (cqw amplitude, seconds, phase) on each axis: two unequal periods trace a slow, non-repeating loop. */
  ax: number;
  ay: number;
  dxd: number;
  dyd: number;
  dxp: number;
  dyp: number;
  /** Sway (degrees, seconds, phase) for objects that do not tumble. */
  sw: number;
  sd: number;
  sp: number;
  /** Entrance: where it flies in from (cqw offset) and when (seconds). */
  ex: number;
  ey: number;
  ed: number;
  /** Seconds the light takes to cross its body, and its phase. */
  shd: number;
  shp: number;
}

export const MEDICINES: readonly Medicine[] = [
  { id: "hero", shape: "capsule", tone: "forestIvory", x: 58, y: 46, w: 44, rot: -24, depth: 1, z: 3, hero: true, ax: 2.2, ay: 3, dxd: 11, dyd: 14, dxp: -3, dyp: -6, sw: 7, sd: 19, sp: -4, ex: -38, ey: 22, ed: 0.25, shd: 7, shp: -2 },
  { id: "sage-capsule", shape: "capsule", tone: "sageIvory", x: 17, y: 26, w: 15, rot: 36, depth: 0.55, z: 2, ax: 3, ay: 2.5, dxd: 17, dyd: 12, dxp: -7, dyp: -2, sw: 12, sd: 15, sp: -9, ex: -25, ey: -12, ed: 0.6, shd: 11, shp: -5 },
  { id: "ivory-tablet", shape: "round", tone: "ivory", x: 84, y: 24, w: 13, rot: 10, depth: 0.75, z: 3, tumble: 15, ax: 2, ay: 3.5, dxd: 13, dyd: 16, dxp: -1, dyp: -11, sw: 0, sd: 15, sp: -3, ex: 30, ey: -14, ed: 0.75, shd: 0, shp: 0 },
  { id: "sage-oblong", shape: "oblong", tone: "sage", x: 13, y: 76, w: 18, rot: -14, depth: 0.6, z: 2, ax: 3, ay: 2, dxd: 15, dyd: 18, dxp: -5, dyp: -13, sw: 9, sd: 21, sp: -8, ex: -28, ey: 20, ed: 0.9, shd: 0, shp: 0 },
  { id: "duo-capsule", shape: "capsule", tone: "forestSage", x: 87, y: 74, w: 19, rot: 58, depth: 0.85, z: 3, ax: 4, ay: 3.5, dxd: 9, dyd: 11, dxp: -2, dyp: -7, sw: 14, sd: 11, sp: -1, ex: 34, ey: 18, ed: 1, shd: 9, shp: -4 },
  { id: "far-tablet", shape: "round", tone: "forest", x: 40, y: 11, w: 8, rot: 0, depth: 0.25, z: 1, blur: 1.5, tumble: 20, ax: 2, ay: 2, dxd: 21, dyd: 23, dxp: -12, dyp: -4, sw: 0, sd: 20, sp: -6, ex: -6, ey: -20, ed: 1.15, shd: 0, shp: 0 },
  { id: "far-capsule", shape: "capsule", tone: "inkIvory", x: 71, y: 90, w: 11, rot: -40, depth: 0.2, z: 1, blur: 2, desktopOnly: true, ax: 2, ay: 1.5, dxd: 25, dyd: 19, dxp: -14, dyp: -9, sw: 10, sd: 27, sp: -15, ex: 10, ey: 20, ed: 1.2, shd: 13, shp: -7 },
  { id: "ink-capsule", shape: "capsule", tone: "inkIvory", x: 30, y: 59, w: 13, rot: 70, depth: 0.4, z: 2, desktopOnly: true, ax: 2.5, ay: 3, dxd: 19, dyd: 14, dxp: -4, dyp: -10, sw: 11, sd: 18, sp: -2, ex: -20, ey: 8, ed: 1, shd: 12, shp: -9 },
  { id: "front-tablet", shape: "round", tone: "ivory", x: 42, y: 87, w: 16, rot: -8, depth: 1, z: 4, blur: 1.5, ax: 3, ay: 2, dxd: 10, dyd: 13, dxp: -5, dyp: -1, sw: 6, sd: 23, sp: -11, ex: -10, ey: 30, ed: 1.1, shd: 0, shp: 0 },
  { id: "edge-oblong", shape: "oblong", tone: "ivory", x: 93, y: 47, w: 10, rot: 80, depth: 0.35, z: 2, desktopOnly: true, ax: 1.5, ay: 3, dxd: 22, dyd: 17, dxp: -9, dyp: -3, sw: 8, sd: 24, sp: -13, ex: 20, ey: 6, ed: 1.25, shd: 0, shp: 0 },
  { id: "edge-capsule", shape: "capsule", tone: "sageIvory", x: 6, y: 47, w: 9, rot: 20, depth: 0.3, z: 1, blur: 1, desktopOnly: true, ax: 1.5, ay: 2.5, dxd: 23, dyd: 20, dxp: -2, dyp: -16, sw: 9, sd: 22, sp: -7, ex: -14, ey: 4, ed: 1.3, shd: 14, shp: -10 },
  { id: "top-tablet", shape: "round", tone: "sage", x: 66, y: 10, w: 7, rot: 0, depth: 0.3, z: 1, desktopOnly: true, tumble: 26, ax: 1.5, ay: 2, dxd: 27, dyd: 21, dxp: -17, dyp: -5, sw: 0, sd: 26, sp: -9, ex: 6, ey: -18, ed: 1.35, shd: 0, shp: 0 },
  { id: "near-capsule", shape: "capsule", tone: "forestIvory", x: 50, y: 69, w: 8, rot: 118, depth: 0.8, z: 4, ax: 2, ay: 2.5, dxd: 12, dyd: 15, dxp: -8, dyp: -3, sw: 16, sd: 13, sp: -5, ex: 0, ey: 24, ed: 1.4, shd: 8, shp: -3 },
];

/** A medicine that sweeps across the whole scene and out of sight, then waits: objects entering and leaving the picture. */
export interface Passer {
  id: string;
  shape: Shape;
  tone: Tone;
  /** Starting height, % of the stage. */
  y: number;
  w: number;
  /** cqw it rises (negative) or falls over the crossing; `rot` follows the slope. */
  rise: number;
  rot: number;
  /** Cycle length and phase (seconds), travelling right to left when `rtl`. */
  pd: number;
  pdl: number;
  rtl?: boolean;
  z: 2 | 3;
}

export const PASSERS: readonly Passer[] = [
  { id: "pass-capsule", shape: "capsule", tone: "sageIvory", y: 78, w: 10, rise: -30, rot: -13, pd: 18, pdl: 4, z: 2 },
  { id: "pass-oblong", shape: "oblong", tone: "ivory", y: 16, w: 8, rise: 22, rot: 10, pd: 23, pdl: 11, rtl: true, z: 3 },
];

/** Slow luminous specks: [x %, y %, size cqw, dx, dy cqw, seconds, phase, warm?]. */
export const SPECKS: ReadonlyArray<readonly [number, number, number, number, number, number, number, boolean]> = [
  [8, 14, 1.1, 2, 3, 9, -2, false],
  [24, 44, 0.7, -2, 3, 11, -5, true],
  [33, 20, 1.4, 3, -2, 8, -1, false],
  [47, 30, 0.8, -3, -2, 12, -7, true],
  [52, 8, 1.0, 2, 2, 10, -4, false],
  [74, 34, 0.7, 3, 3, 9, -6, true],
  [79, 58, 1.3, -3, 2, 13, -3, false],
  [90, 12, 0.8, -2, 3, 10, -8, true],
  [95, 62, 1.0, -2, -3, 11, -1, false],
  [64, 78, 0.8, 3, -2, 9, -5, true],
  [22, 84, 1.2, 2, -3, 12, -9, false],
  [4, 66, 0.7, 3, 2, 10, -2, true],
  [58, 22, 0.6, -2, 2, 8, -6, false],
  [36, 72, 0.9, 2, 2, 11, -4, true],
];

/** Flowing paths in a 600 x 372 space (the stage's proportions). Each carries a stream of dots; some also a brief streak. */
export const TRAILS: ReadonlyArray<{ d: string; streak?: { dur: number; delay: number }; mobile?: boolean }> = [
  { d: "M-20 300 C120 200 220 330 330 220 S520 90 640 130", streak: { dur: 11, delay: 2.5 }, mobile: true },
  { d: "M-20 120 C100 60 200 180 310 120 S500 230 640 190", streak: { dur: 14, delay: 6 } },
  { d: "M80 400 C150 300 300 330 380 250 S520 200 640 40", mobile: true },
  { d: "M-20 220 C160 260 260 120 420 160 S560 300 640 330", streak: { dur: 17, delay: 9 } },
];

/** Large soft ribbons behind everything. */
export const CURRENTS: ReadonlyArray<{ d: string; width: number; className: "curA" | "curB" | "curC"; dur: number }> = [
  { d: "M-40 330 C120 250 260 330 380 210 S560 120 660 60", width: 96, className: "curA", dur: 37 },
  { d: "M-40 80 C140 160 280 40 420 130 S580 250 660 220", width: 70, className: "curB", dur: 43 },
  { d: "M-20 200 C150 120 300 250 450 160 S600 140 680 170", width: 40, className: "curC", dur: 31 },
];
