"use client";

import { listDirectory, type DirectoryEntry } from "../../lib/api";
import { directionsUrlFor } from "../../lib/maps";
import type { Location } from "../../lib/api";
import { useAsync } from "../../lib/use-async";
import { DEMO_LISTING_LABEL } from "../ui/DemoBadge";
import { ExternalIcon, StoreIcon } from "../ui/icons";
import { Badge, Card, LinkButton } from "../ui/primitives";

const STATUS: Record<DirectoryEntry["listingStatus"], { label: string; note: string }> = {
  accepted: { label: "Listed, not yet on MedLink", note: "Found at this address in independent sources." },
  provisional: { label: "Provisional", note: "Seen in one source only; not confirmed." },
  "needs-review": { label: "Needs review", note: "The address is an unconfirmed lead." },
  excluded: { label: "Excluded", note: "" },
};

/**
 * Pharmacies and leads from the demo directory that are NOT inventory providers. They show no stock, no price, no distance and
 * no map pin; directions use the address only, and say so when the address is unconfirmed or incomplete. Excluded entries
 * (chains, closed, duplicates) are counted, not listed. Renders nothing if the directory cannot be loaded.
 */
export function DirectoryListings({ origin }: { origin: Location | null }) {
  const state = useAsync((signal) => listDirectory({ signal }), []);
  const shown = (state.data ?? []).filter((e) => e.listingStatus !== "excluded");
  const excluded = (state.data ?? []).length - shown.length;
  if (!shown.length) return null;
  return (
    <section aria-labelledby="directory-heading" className="space-y-3 border-t border-line pt-6">
      <div className="max-w-3xl">
        <h2 id="directory-heading" className="editorial-title text-2xl">Directory listings: no inventory</h2>
        <p className="mt-1 text-sm text-muted">
          Shops from public directories that are not connected to MedLink. They show no medicines, prices, stock or distance, and the addresses below are not all confirmed. Open directions only as a starting point.
        </p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Directory listings without inventory">
        {shown.map((e) => {
          const url = e.directions === "unavailable" ? null : directionsUrlFor(origin, { name: e.name, address: e.address, locationVerified: false });
          return (
            <li key={e.code}>
              <Card interactive className="flex h-full flex-col p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-ink">
                    <StoreIcon size={20} />
                  </span>
                  <div className="min-w-0">
                    <h3 className="editorial-title text-lg leading-snug">{e.name}</h3>
                    <p className="text-sm text-muted">{e.address}</p>
                    <p className="mt-2 flex flex-wrap gap-1.5">
                      <Badge tone="warn" className="!whitespace-normal">{DEMO_LISTING_LABEL}</Badge>
                      <Badge tone="neutral" title={STATUS[e.listingStatus].note}>{STATUS[e.listingStatus].label}</Badge>
                    </p>
                    <p className="mt-2 text-xs text-muted">No inventory: this shop has not joined MedLink, so no medicines are shown. Location not verified: no distance or map pin.</p>
                  </div>
                </div>
                <div className="mt-auto pt-3">
                  {url ? (
                    <LinkButton href={url} external size="sm" variant="directions" aria-label={`${e.directions === "approximate" ? "Get approximate directions" : "Get Directions"} to ${e.name}`}>
                      {e.directions === "approximate" ? "Approximate directions" : "Get Directions"} <ExternalIcon size={14} />
                    </LinkButton>
                  ) : (
                    <p className="text-xs text-muted">Directions unavailable: the address is incomplete.</p>
                  )}
                  {e.directions === "approximate" && <p className="mt-1 text-xs text-muted">The address is an unconfirmed lead, so the route may not reach the shop.</p>}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      {excluded > 0 && <p className="text-xs text-muted">{excluded} further lead{excluded === 1 ? "" : "s"} excluded (chain, closed or duplicate) and not listed.</p>}
    </section>
  );
}
