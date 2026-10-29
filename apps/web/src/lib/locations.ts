import type { Location } from "./api";

export interface Area extends Location {
  id: string;
  label: string;
}

/**
 * Manual location input without a geocoding service: a fixed list of Mumbai areas.
 * Coordinates are approximate area centres.
 */
export const AREAS: Area[] = [
  { id: "andheri-west", label: "Andheri West, Mumbai", latitude: 19.1364, longitude: 72.8296 },
  { id: "andheri-east", label: "Andheri East, Mumbai", latitude: 19.1197, longitude: 72.8468 },
  { id: "juhu", label: "Juhu, Mumbai", latitude: 19.1075, longitude: 72.8263 },
  { id: "bandra-west", label: "Bandra West, Mumbai", latitude: 19.0596, longitude: 72.8295 },
  { id: "powai", label: "Powai, Mumbai", latitude: 19.1176, longitude: 72.906 },
  { id: "dadar", label: "Dadar, Mumbai", latitude: 19.0178, longitude: 72.8478 },
  { id: "borivali", label: "Borivali West, Mumbai", latitude: 19.2307, longitude: 72.8567 },
];

export const DEFAULT_AREA = AREAS[0]!;

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Parses user-typed coordinates. Returns an error message instead of throwing. */
export function parseCoordinates(lat: string, lng: string): { ok: true; location: Location } | { ok: false; error: string } {
  const la = lat.trim();
  const lo = lng.trim();
  if (!DECIMAL.test(la) || !DECIMAL.test(lo)) return { ok: false, error: "Enter latitude and longitude as decimal numbers, e.g. 19.1364 and 72.8296." };
  const latitude = Number(la);
  const longitude = Number(lo);
  if (latitude < -90 || latitude > 90) return { ok: false, error: "Latitude must be between -90 and 90." };
  if (longitude < -180 || longitude > 180) return { ok: false, error: "Longitude must be between -180 and 180." };
  return { ok: true, location: { latitude, longitude } };
}
