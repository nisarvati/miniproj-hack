import Link from "next/link";
import type { Location, SearchResult } from "../../lib/api";
import { formatDistance, formatPrice } from "../../lib/format";
import { Freshness } from "../stock/Freshness";
import { StockBadge } from "../stock/StockBadge";
import { ArrowRightIcon, MapPinIcon, PhoneIcon } from "../ui/icons";
import { Badge, Card, cx, LinkButton } from "../ui/primitives";
import { DemoBadge, SimulatedInventoryNotice } from "../ui/DemoBadge";
import { DirectionsActions } from "../pharmacies/DirectionsActions";
import { AddToCalendar } from "../calendar/AddToCalendar";
import { MatchInfo } from "./MatchInfo";

/**
 * One pharmacy's listing of one medicine. Medicine first (what it is), then the pharmacy and its distance, then price and stock,
 * then the actions. Everything shown comes from the search result; nothing is filled in.
 */
export function ResultCard({ result, origin, best }: { result: SearchResult; origin: Location | null; best: boolean }) {
  const { medicine, pharmacy, stockStatus } = result;
  const unavailable = stockStatus === "OUT_OF_STOCK";
  const phoneNumber = "phone" in pharmacy && typeof pharmacy.phone === "string" ? pharmacy.phone : null;

  return (
    <li>
      <Card interactive className={cx("result-card mx-enter h-full p-4 sm:px-5", best && "result-card-best border-[1.5px] border-brand")}>
        <article aria-label={`${medicine.brandName} ${medicine.dosage} at ${pharmacy.name}`} className="grid gap-x-6 gap-y-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">
              {medicine.brandName} {medicine.dosage}
              <span className="font-normal text-muted"> · {medicine.genericName} · {medicine.form}</span>
            </p>
            <h2 className="mt-1 text-lg font-semibold leading-snug text-ink">
              <Link href={`/pharmacies/${pharmacy.id}`} className="rounded underline-offset-2 hover:text-brand hover:underline">
                {pharmacy.name}
              </Link>
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              <span>{pharmacy.address}</span>
              {result.distanceKm === null ? (
                <span title="This listing's map location is not verified, so no distance is shown.">Distance not shown</span>
              ) : (
                <span className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-ink"><MapPinIcon size={13} />{formatDistance(result.distanceKm)}</span>
              )}
            </p>
            {pharmacy.demo && (
              <div className="mt-2 space-y-1">
                <p><DemoBadge demo independent={pharmacy.independent} /></p>
                <SimulatedInventoryNotice pharmacy={pharmacy} />
              </div>
            )}
            <div className="mt-2"><MatchInfo result={result} /></div>
            {unavailable && <p className="mt-2 text-sm"><a href={`#alternatives-${medicine.id}`} className="font-semibold underline underline-offset-2">Show substitutes</a> in the restock options above.</p>}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 md:min-w-44 md:flex-col md:items-end md:gap-1">
            <div className="flex items-center gap-2">
              {best && <Badge tone="brand">★ Best match</Badge>}
              <StockBadge status={stockStatus} compact />
            </div>
            <p className="flex items-baseline gap-1.5">
              <span className="text-2xl font-bold tabular-nums text-ink">{formatPrice(result.price)}</span>
              <span className="text-xs text-muted">per pack</span>
            </p>
            <Freshness source={result.source} updatedAt={result.updatedAt} />
          </div>

          <div className="flex flex-wrap items-start gap-2 border-t border-line pt-3 md:col-span-2">
            <DirectionsActions pharmacy={pharmacy} origin={origin} className="!min-w-0 !px-3 !text-xs justify-center" />
            <LinkButton className="!min-w-0 !px-3 !text-xs justify-center" href={`/pharmacies/${pharmacy.id}`} size="sm" variant="secondary">
              View pharmacy <ArrowRightIcon size={14} />
            </LinkButton>
            {phoneNumber && <a className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-control-border bg-surface px-3 text-xs font-semibold text-ink shadow-control hover:bg-control-hover md:h-9 md:min-h-0" href={`tel:${phoneNumber}`}><PhoneIcon size={14} />Call</a>}
            <div className="sm:ml-auto"><AddToCalendar medicine={medicine} /></div>
          </div>
        </article>
      </Card>
    </li>
  );
}
