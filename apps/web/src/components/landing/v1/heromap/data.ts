/**
 * The homepage illustration "The Living Pharmacy Network". Everything here is ILLUSTRATIVE and is not read from the API:
 * the pharmacies are unnamed "Example" shops, the availability is fixed sample data, and nothing is a real pharmacy, stock
 * level, price, distance or live synchronisation event. The only text that comes from the visitor is the medicine name
 * they typed or hovered, echoed on the search bubble; sample availability is shown under a medicine name only when it
 * matches one of the site's own suggestions, otherwise under "Example medicine".
 */
import { SUGGESTIONS } from "../../../search/SearchForm";

export const VIEW = { width: 1600, height: 2000 } as const;
export const SAMPLE_MEDICINE = "Crocin 500mg";
export const MAP_BOTTOM = 1130;

export type SampleStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK" | "NOT_LISTED";
export type PharmacyId = "a" | "b" | "c" | "d";

/** Text and glyph, never colour alone. NOT_LISTED is the catalogue-versus-listing distinction: this shop does not list it. */
export const STATUS: Record<SampleStatus, { glyph: string; label: string; short: string }> = {
  IN_STOCK: { glyph: "●", label: "In stock", short: "In stock" },
  LOW_STOCK: { glyph: "◐", label: "Low stock", short: "Low" },
  OUT_OF_STOCK: { glyph: "○", label: "Sold out", short: "Sold out" },
  NOT_LISTED: { glyph: "–", label: "Not listed here", short: "Not listed" },
};

export interface SamplePharmacy {
  id: PharmacyId;
  name: string;
  status: SampleStatus;
  /** Tip of the pin, in the 1600 x 2000 artwork. */
  pin: { x: number; y: number };
  scale: number;
  /** Where the dotted link meets the shop's roof. */
  roof: { x: number; y: number };
  chip: "left" | "right";
}

export const SAMPLE_PHARMACIES: readonly SamplePharmacy[] = [
  { id: "a", name: "Example Pharmacy A", status: "IN_STOCK", pin: { x: 560, y: 800 }, scale: 1, roof: { x: 250, y: 1245 }, chip: "left" },
  { id: "b", name: "Example Pharmacy B", status: "NOT_LISTED", pin: { x: 900, y: 650 }, scale: 1, roof: { x: 570, y: 1375 }, chip: "left" },
  { id: "c", name: "Example Pharmacy C", status: "LOW_STOCK", pin: { x: 1180, y: 790 }, scale: 1.2, roof: { x: 950, y: 1185 }, chip: "left" },
  { id: "d", name: "Example Pharmacy D", status: "OUT_OF_STOCK", pin: { x: 1410, y: 570 }, scale: 1, roof: { x: 1330, y: 1315 }, chip: "left" },
];

/** The dotted connections between the independent pharmacies, and the pharmacies each one joins. */
export const NETWORK: readonly { key: string; d: string; ends: readonly PharmacyId[] }[] = [
  { key: "ab", d: "M560 804 C 680 740 790 690 900 654", ends: ["a", "b"] },
  { key: "bc", d: "M900 654 C 990 700 1080 760 1180 794", ends: ["b", "c"] },
  { key: "cd", d: "M1180 794 C 1260 740 1340 640 1410 574", ends: ["c", "d"] },
  { key: "bd", d: "M900 654 C 1050 560 1230 520 1410 574", ends: ["b", "d"] },
];

/** The path the example capsule travels: from pharmacy D, across B, to A. */
export const TOKEN_PATH = "M1410 470 C 1250 430 1060 500 900 520 S 560 560 360 600";
export const TOKEN_END = { x: 360, y: 600 } as const;

/** The pharmacy the reveal ends on. */
export const LEAD_PHARMACY: PharmacyId = "a";

export const byId = (id: PharmacyId) => SAMPLE_PHARMACIES.find((p) => p.id === id)!;
export const isListed = (p: SamplePharmacy) => p.status !== "NOT_LISTED";
/** The pharmacies the sample search finds relevant: those that list the medicine. */
export const RELEVANT: readonly PharmacyId[] = SAMPLE_PHARMACIES.filter(isListed).map((p) => p.id);

/** A typed or hovered name counts as a medicine only when it is one of the site's own suggestions. */
export function matchSuggestion(text: string): string | null {
  const t = text.trim().toLowerCase();
  return t ? (SUGGESTIONS.find((s) => s.toLowerCase() === t) ?? null) : null;
}

export const markerLabel = (p: SamplePharmacy, medicine: string) => `${p.name}: ${STATUS[p.status].label} for ${medicine}. Illustrative sample, not live stock.`;
