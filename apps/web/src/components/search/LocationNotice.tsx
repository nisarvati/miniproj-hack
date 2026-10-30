"use client";

import { useDetectLocation } from "../providers/use-detect-location";
import { useLocation } from "../providers/location";
import { CrosshairIcon } from "../ui/icons";
import { Button, Spinner } from "../ui/primitives";

/**
 * Says where distances are measured from, and gives a visible way to use the real location. Shown while no location has been chosen (distances
 * then come from the default area, not from the person), and for the outcome of an attempt to detect one.
 */
export function LocationNotice() {
  const { picked, explicit } = useLocation();
  const { state, detect } = useDetectLocation();
  if (explicit && state.status === "idle") return null;
  if (explicit && state.status === "detected") return <p className="text-sm text-muted" aria-live="polite">Location detected. Distances are measured from where you are.</p>;
  const area = picked.label.replace(/, Mumbai$/, "");
  const busy = state.status === "detecting";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted" aria-live="polite">
      <p>
        {busy
          ? "Detecting location…"
          : state.status === "error"
            ? state.message
            : state.status === "detected"
              ? "Location detected. Distances are measured from where you are."
              : `Your location isn't set, so distances are measured from ${area}, not from where you are.`}
      </p>
      {state.status !== "detected" && (
        <Button size="sm" variant="secondary" onClick={detect} disabled={busy}>
          {busy ? <Spinner /> : <CrosshairIcon size={16} />}
          {state.status === "error" ? "Try again" : "Use my location"}
        </Button>
      )}
    </div>
  );
}
