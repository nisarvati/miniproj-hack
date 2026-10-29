import type { Location } from "./api";

/** What is needed to point Google Maps at a pharmacy. */
export interface MapsTarget {
  name?: string;
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
  /** false: the map point is not verified, so only the address may be used. Missing means the API did not say (use the point). */
  locationVerified?: boolean;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * Where Google Maps should go: "lat,lng" of the pharmacy's verified point, else the percent-encoded full address, else
 * null (no honest destination). Never the coordinates of another pharmacy, and never an unverified point.
 */
export function mapsDestination(t: MapsTarget): string | null {
  if (t.locationVerified !== false && finite(t.latitude) && finite(t.longitude) && Math.abs(t.latitude) <= 90 && Math.abs(t.longitude) <= 180) {
    return `${t.latitude},${t.longitude}`;
  }
  const address = t.address?.trim();
  return address ? encodeURIComponent(address) : null;
}

/** Google Maps directions deep link (a plain URL; no API key or SDK needed). Without an origin Google Maps starts from the user's current location. */
export function buildDirectionsUrl(from: Location | null, to: Location): string {
  return directionsUrlFor(from, { latitude: to.latitude, longitude: to.longitude }) as string;
}

/** `https://www.google.com/maps/dir/?api=1&destination=...`, plus `origin=` only when the user has specified one. Null if the pharmacy has no destination. */
export function directionsUrlFor(from: Location | null, t: MapsTarget): string | null {
  const destination = mapsDestination(t);
  if (!destination) return null;
  const origin = from && finite(from.latitude) && finite(from.longitude) ? `&origin=${from.latitude},${from.longitude}` : "";
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}${origin}`;
}

/** `https://www.google.com/maps/search/?api=1&query=...` to inspect the pharmacy on a map. */
export function mapsViewUrl(t: MapsTarget): string | null {
  const destination = mapsDestination(t);
  return destination ? `https://www.google.com/maps/search/?api=1&query=${destination}` : null;
}
