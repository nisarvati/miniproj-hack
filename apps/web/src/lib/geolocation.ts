import type { Location } from "./api";

/** Why a browser location request did not give a position. */
export type GeolocationFailure = "unsupported" | "insecure" | "denied" | "unavailable" | "timeout" | "invalid";

export type DetectResult = { ok: true; location: Location } | { ok: false; reason: GeolocationFailure };

export const isValidCoordinate = (l: Location | null | undefined): l is Location =>
  !!l && Number.isFinite(l.latitude) && Number.isFinite(l.longitude) && Math.abs(l.latitude) <= 90 && Math.abs(l.longitude) <= 180;

/** Plain wording for each failure. None of them stops searching: the page keeps using the area the person picked (or the default one). */
export const FAILURE_MESSAGE: Record<GeolocationFailure, string> = {
  unsupported: "This browser can't detect your location. Pick an area or enter coordinates instead.",
  insecure: "Browsers only share location on secure (https) pages. Pick an area or enter coordinates instead.",
  denied: "Location permission was denied. Search still works: pick an area, or allow location for this site in your browser settings and try again.",
  unavailable: "Unable to detect your location right now (location services may be off). Pick an area or try again.",
  timeout: "Detecting your location took too long. Try again, or pick an area instead.",
  invalid: "The browser returned a location that doesn't look valid. Try again, or pick an area instead.",
};

/**
 * Asks the browser for the current position, once. Call it only from a person's click: it is what shows the permission prompt, so it must
 * never run on render or on every search. The result is checked before it is trusted; nothing is stored or logged here.
 */
export function detectPosition(): Promise<DetectResult> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve({ ok: false, reason: "unsupported" });
  // localhost counts as secure; a plain-http page on another host does not, and the browser refuses to share location there.
  if (typeof window !== "undefined" && window.isSecureContext === false) return Promise.resolve({ ok: false, reason: "insecure" });
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const location = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
        resolve(isValidCoordinate(location) ? { ok: true, location } : { ok: false, reason: "invalid" });
      },
      (err) => resolve({ ok: false, reason: err.code === err.PERMISSION_DENIED ? "denied" : err.code === err.TIMEOUT ? "timeout" : "unavailable" }),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}
