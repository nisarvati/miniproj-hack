"use client";

import type { StockSource } from "../../lib/api";
import { formatAge } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { LiveDot } from "../ui/primitives";

/**
 * Says where a figure comes from. "Live" is synced from the pharmacy's own system and keeps counting; "last known"
 * is the central database's value, which can be older. A patient should be able to tell the two apart.
 */
export function Freshness({ source, updatedAt, className }: { source: StockSource; updatedAt: string; className?: string }) {
  const now = useNow();
  const age = formatAge(updatedAt, now);
  return source === "live" ? (
    <span className={`inline-flex items-center gap-1.5 text-xs text-muted ${className ?? ""}`} title={`Synced from the pharmacy's own system. Last change: ${new Date(updatedAt).toLocaleString()}`}>
      <LiveDot />
      <span className="font-semibold text-ok">Live</span>
      <span>· updated {age}</span>
    </span>
  ) : (
    <span className={`inline-flex items-center gap-1.5 text-xs text-muted ${className ?? ""}`} title={`Last known value in MedLink's database: ${new Date(updatedAt).toLocaleString()}`}>
      <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-muted/50" />
      <span>Last known · updated {age}</span>
    </span>
  );
}
