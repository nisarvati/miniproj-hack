"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AREAS, parseCoordinates } from "../../lib/locations";
import { useLocation } from "../providers/location";
import { CheckIcon, ChevronDownIcon, CrosshairIcon, MapPinIcon } from "../ui/icons";
import { Button, cx, Input, Spinner } from "../ui/primitives";

/** The header's location chip. One place to say where you are; every page uses it. */
export function LocationMenu({ className }: { className?: string }) {
  const { picked, setPicked } = useLocation();
  const [open, setOpen] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [locating, setLocating] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = (returnFocus = true) => {
    setOpen(false);
    setMessage(null);
    if (returnFocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setMessage({ kind: "error", text: "Your browser doesn't support location. Pick an area instead." });
      return;
    }
    setLocating(true);
    setMessage({ kind: "info", text: "Finding your location…" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setPicked({ label: "Your location", location: { latitude: pos.coords.latitude, longitude: pos.coords.longitude } });
        close();
      },
      (err) => {
        setLocating(false);
        setMessage({
          kind: "error",
          text: err.code === err.PERMISSION_DENIED ? "Location permission was denied. Pick an area or enter coordinates instead." : "Couldn't determine your location. Pick an area or enter coordinates instead.",
        });
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const applyCoordinates = () => {
    const parsed = parseCoordinates(lat, lng);
    if (!parsed.ok) {
      setMessage({ kind: "error", text: parsed.error });
      return;
    }
    setPicked({ label: `${parsed.location.latitude.toFixed(4)}, ${parsed.location.longitude.toFixed(4)}`, location: parsed.location });
    close();
  };

  return (
    <div ref={root} className={cx("relative", className)}>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Location: ${picked.label}. Change`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-11 min-w-0 max-w-[6.5rem] items-center gap-1.5 rounded-xl border border-control-border bg-surface px-2 text-sm font-medium shadow-control transition-colors hover:border-control-hover-border hover:bg-control-hover sm:max-w-[13rem] sm:px-3 md:h-10 lg:max-w-[16rem]"
      >
        <MapPinIcon size={16} className="shrink-0 text-brand" />
        <span className="truncate">{picked.label.replace(/, Mumbai$/, "")}</span>
        <ChevronDownIcon size={16} className={cx("shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div id={panelId} role="dialog" aria-label="Choose your location" className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] mx-card mx-card--overlay p-3">
          <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">Your location</p>
          <ul className="max-h-72 space-y-0.5 overflow-auto">
            {AREAS.map((a) => {
              const selected = picked.label === a.label;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    aria-current={selected || undefined}
                    onClick={() => {
                      setPicked({ label: a.label, location: { latitude: a.latitude, longitude: a.longitude } });
                      close();
                    }}
                    className={cx("flex min-h-11 w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm hover:bg-control-hover", selected && "bg-brand-soft font-semibold text-brand-ink")}
                  >
                    {a.label}
                    {selected && <CheckIcon size={16} />}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-3 border-t border-line pt-3">
            <Button size="sm" variant="secondary" onClick={useMyLocation} disabled={locating} className="w-full">
              {locating ? <Spinner /> : <CrosshairIcon size={16} />}
              Use my current location
            </Button>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Input aria-label="Latitude" inputMode="decimal" placeholder="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} className="h-11 md:h-9" />
              <Input aria-label="Longitude" inputMode="decimal" placeholder="Longitude" value={lng} onChange={(e) => setLng(e.target.value)} className="h-11 md:h-9" />
            </div>
            <Button size="sm" variant="ghost" onClick={applyCoordinates} disabled={!lat && !lng} className="mt-2 w-full">
              Use these coordinates
            </Button>
            <p role="status" aria-live="polite" className={cx("mt-1 min-h-5 text-xs", message?.kind === "error" ? "text-bad" : "text-muted")}>
              {message?.text}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
