import type { Location } from "./api";
import { DEFAULT_AREA } from "./locations";
import { readStorage, writeStorage } from "./storage";

export interface PickedLocation {
  /** What to show: "Andheri West, Mumbai", "Your location", "19.1364, 72.8296". */
  label: string;
  location: Location;
  /** true when the browser reported it (as opposed to an area or typed coordinates). Only the coarse position of such a location is remembered. */
  detected?: boolean;
}

/** About 1 km, the same precision the search API logs. A detected position is not a home address to keep to the metre. */
const coarse = (n: number) => Math.round(n * 100) / 100;

export const DEFAULT_LOCATION: PickedLocation = {
  label: DEFAULT_AREA.label,
  location: { latitude: DEFAULT_AREA.latitude, longitude: DEFAULT_AREA.longitude },
};

const KEY = "medlink:location";

export function loadLocation(): PickedLocation | null {
  const raw = readStorage(KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PickedLocation>;
    const { latitude, longitude } = v.location ?? {};
    if (typeof v.label === "string" && v.label && typeof latitude === "number" && typeof longitude === "number" && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { label: v.label, location: { latitude, longitude }, ...(v.detected === true && { detected: true }) };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export const saveLocation = (p: PickedLocation) =>
  writeStorage(KEY, JSON.stringify(p.detected ? { ...p, location: { latitude: coarse(p.location.latitude), longitude: coarse(p.location.longitude) } } : p));
