import type { PharmacyId } from "./data";

/**
 * The reveal, as numbered steps from the click. Each step switches a set of drawn things on; the timeline says when.
 * Step 0 is the resting capsule, step 11 the explorable scene.
 */
export const STEP = { rest: 0, rotate: 1, split: 2, map: 3, shopA: 4, shopB: 5, shopC: 6, shopD: 7, markers: 8, network: 9, token: 10, reveal: 11 } as const;

/** [step, milliseconds after the click]. Unhurried, with a beat of calm between the larger moves. */
export const TIMELINE: readonly (readonly [number, number])[] = [
  [STEP.rotate, 0],
  [STEP.split, 750],
  [STEP.map, 1600],
  [STEP.shopA, 2600],
  [STEP.shopB, 3000],
  [STEP.shopC, 3400],
  [STEP.shopD, 3800],
  [STEP.markers, 4500],
  [STEP.network, 5400],
  [STEP.token, 6100],
  [STEP.reveal, 8700],
];

/** The technical caption under the frame follows the reveal. */
export function captionFor(step: number, selected: PharmacyId | null): string {
  if (selected) return "Pharmacy details";
  if (step >= STEP.reveal) return "The Medicineverse";
  if (step >= STEP.token) return "Medicine selected";
  if (step >= STEP.network) return "Network update";
  if (step >= STEP.shopA) return "Independent pharmacies";
  if (step >= STEP.map) return "Neighbourhood";
  if (step >= STEP.rotate) return "Opening";
  return "A capsule";
}

export const INVITATION = "A world of medicine, waiting to be found.";
