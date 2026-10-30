"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detectPosition, FAILURE_MESSAGE, type GeolocationFailure } from "../../lib/geolocation";
import { useLocation } from "./location";

export type DetectState = { status: "idle" } | { status: "detecting" } | { status: "detected" } | { status: "error"; reason: GeolocationFailure; message: string };

/**
 * "Use my location" for any component. `detect` is the only thing that asks the browser, so permission is requested from a click and never
 * on render or on a search. A detected position becomes the picked location (full precision in memory, coarse when remembered); a failure
 * leaves the current location alone, so searching keeps working.
 */
export function useDetectLocation(onDetected?: () => void) {
  const { setPicked } = useLocation();
  const [state, setState] = useState<DetectState>({ status: "idle" });
  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const detect = useCallback(async () => {
    if (busy.current) return; // a second click while the browser is still working
    busy.current = true;
    setState({ status: "detecting" });
    const result = await detectPosition();
    busy.current = false;
    if (result.ok) {
      setPicked({ label: "Your location", location: result.location, detected: true });
      if (alive.current) setState({ status: "detected" });
      onDetected?.();
    } else if (alive.current) {
      setState({ status: "error", reason: result.reason, message: FAILURE_MESSAGE[result.reason] });
    }
  }, [setPicked, onDetected]);

  return { state, detect };
}
