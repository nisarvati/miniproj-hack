"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCATION, loadLocation, saveLocation, type PickedLocation } from "../../lib/location-store";

interface LocationContextValue {
  picked: PickedLocation;
  /** False until the saved choice has been read; pages wait for it so the first search uses the right place. */
  ready: boolean;
  /** True once the user has chosen or saved a location. The built-in default area is not a choice, so it is never sent to Google Maps as a route origin. */
  explicit: boolean;
  setPicked: (p: PickedLocation) => void;
}

const LocationContext = createContext<LocationContextValue>({ picked: DEFAULT_LOCATION, ready: false, explicit: false, setPicked: () => undefined });
export const useLocation = () => useContext(LocationContext);

export function LocationProvider({ children }: { children: ReactNode }) {
  const [picked, setPickedState] = useState<PickedLocation>(DEFAULT_LOCATION);
  const [ready, setReady] = useState(false);
  const [explicit, setExplicit] = useState(false);
  useEffect(() => {
    const saved = loadLocation();
    if (saved) {
      setPickedState(saved);
      setExplicit(true);
    }
    setReady(true);
  }, []);
  const setPicked = useCallback((p: PickedLocation) => {
    setPickedState(p);
    setExplicit(true);
    saveLocation(p);
  }, []);
  const value = useMemo(() => ({ picked, ready, explicit, setPicked }), [picked, ready, explicit, setPicked]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}
