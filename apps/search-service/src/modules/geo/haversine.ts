const EARTH_RADIUS_KM = 6371.0088; // IUGG mean Earth radius

export interface Coordinates {
  latitude: number;
  longitude: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres between two points (Haversine formula). */
export function haversineKm(a: Coordinates, b: Coordinates): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  // min() guards against h creeping just above 1 through floating point error for antipodal points.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
