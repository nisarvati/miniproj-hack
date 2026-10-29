import type { Location } from "./api";
import { DEFAULT_AREA } from "./locations";
import { readStorage, writeStorage } from "./storage";

export interface PickedLocation {
  /** What to show: "Andheri West, Mumbai", "Your location", "19.1364, 72.8296". */
  label: string;
  location: Location;
}

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
      return { label: v.label, location: { latitude, longitude } };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export const saveLocation = (p: PickedLocation) => writeStorage(KEY, JSON.stringify(p));
