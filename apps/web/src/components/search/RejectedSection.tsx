import Link from "next/link";
import type { RejectedOffer, RejectionSummary } from "../../lib/api";
import { formatDistance, formatPrice, pluralise } from "../../lib/format";
import { StockBadge } from "../stock/StockBadge";
import { InfoIcon } from "../ui/icons";
import { Card } from "../ui/primitives";

/**
 * Pharmacies that were checked and left out by the filters the person chose, each with the reason. Set apart from the results and never ranked or
 * recommended. Every reason comes from the API; nothing is inferred here, and no reason is shown for a filter that was not chosen.
 * Not shown at all when nothing was left out.
 */
export function RejectedSection({ rejected, summary }: { rejected: RejectedOffer[]; summary: RejectionSummary | null }) {
  if (rejected.length === 0) return null;
  const total = summary?.total ?? rejected.length;
  const hidden = Math.max(0, total - rejected.length);

  return (
    <section aria-labelledby="rejected-heading" className="rejected-section space-y-3 border-t border-line pt-4">
      <div>
        <h2 id="rejected-heading" className="flex items-center gap-1.5 text-base font-semibold text-ink">
          <InfoIcon size={16} className="text-muted" /> Not matching your filters
        </h2>
        <p className="text-sm text-muted">
          {pluralise(total, "listing")} {total === 1 ? "was" : "were"} checked and left out by the filters you chose. {total === 1 ? "It is not a recommendation: change a filter to see it" : "They are not recommendations: change a filter to see them"} in your results.
        </p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2" aria-label="Listings left out by your filters">
        {rejected.map((r) => (
          <li key={`${r.medicine.id}-${r.pharmacy.id}`}>
            <Card variant="quiet" className="h-full space-y-2 border-dashed p-3.5">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">
                  {r.medicine.brandName} {r.medicine.dosage}
                  <span className="font-normal text-muted"> · {r.medicine.form}</span>
                </p>
                <p className="text-sm">
                  <Link href={`/pharmacies/${r.pharmacy.id}`} className="font-medium underline-offset-2 hover:text-brand hover:underline">{r.pharmacy.name}</Link>
                </p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                  <span>{formatPrice(r.price)}</span>
                  <StockBadge status={r.stockStatus} compact />
                  {r.distanceKm !== null ? <span>{formatDistance(r.distanceKm)}</span> : <span>Distance not shown</span>}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Left out because</p>
                <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-sm">
                  {r.reasons.map((reason) => <li key={`${reason.code}-${reason.filter}`}>{reason.message}</li>)}
                </ul>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="text-sm text-muted">Showing {rejected.length} of {total} left out. Narrowing your search shows fewer.</p>}
    </section>
  );
}
