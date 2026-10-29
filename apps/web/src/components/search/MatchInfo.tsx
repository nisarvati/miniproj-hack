import type { MatchReason, MatchReasonCode, SearchResult } from "../../lib/api";
import { InfoIcon } from "../ui/icons";

/** Short names for the reasons, for the one-line summary. */
const LABEL: Record<MatchReasonCode, string> = {
  NAME_MATCH: "Name match",
  IN_STOCK: "In stock",
  LOW_STOCK: "Low stock",
  OUT_OF_STOCK: "Out of stock",
  NEARBY: "Nearby",
  DISTANCE: "Distance",
  MISSING_DISTANCE: "No distance",
  PRICE_COMPARISON: "Price compared",
  PRICE_NO_COMPARISON: "Price",
  MISSING_PRICE: "No price",
};

/** The reasons that earned the most points, strongest first (ties in the fixed name, stock, distance, price order). At most `n`, and none that earned nothing. */
export function strongestReasons(reasons: MatchReason[], n = 2): MatchReason[] {
  return reasons
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.points > 0)
    .sort((a, b) => b.r.points - a.r.points || a.i - b.i)
    .slice(0, n)
    .map(({ r }) => r);
}

/**
 * The match percentage of one result and why, from the API (the web adds nothing and works out nothing). It says what the percentage is: how well the
 * listing fits MedLink's ranking rules. It is never clinical suitability or advice, and it does not promise the medicine is in stock.
 * Nothing here relies on colour: the percentage is text, and every factor is written out with its points.
 */
export function MatchInfo({ result }: { result: SearchResult }) {
  const { matchPercent, matchReasons } = result;
  if (typeof matchPercent !== "number" || !Array.isArray(matchReasons) || matchReasons.length === 0) return null;
  const strongest = strongestReasons(matchReasons);

  return (
    <div className="match-info text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-sm border border-control-border bg-surface px-2 py-0.5 text-xs font-semibold tabular-nums text-ink shadow-control" title="How well this listing fits MedLink's ranking rules: name, stock, distance and price. Not medical advice.">
          <span className="sr-only">Match: </span>
          {matchPercent}% match
        </span>
        {strongest.length > 0 && <span className="text-muted">Strongest: {strongest.map((r) => LABEL[r.code]).join(" · ")}</span>}
      </p>
      <details className="mx-details mt-1">
        <summary className="flex min-h-11 cursor-pointer items-center gap-1 font-semibold text-brand hover:underline md:min-h-0 md:py-1">
          <InfoIcon size={14} /> Why {matchPercent}%?
        </summary>
        <ul className="mt-2 space-y-1.5" aria-label={`How the ${matchPercent}% match is made`}>
          {matchReasons.map((r) => (
            <li key={r.factor} className="flex gap-2">
              <span className="w-12 shrink-0 text-right font-semibold tabular-nums">+{r.points}</span>
              <span className="text-muted">{r.message}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">
          The percentage shows how well this listing fits MedLink&apos;s ranking rules (name, stock, distance and price, weighted). It is not medical advice, not a
          recommendation to switch medicines, and not a promise the medicine is available. Call the pharmacy to confirm.
        </p>
      </details>
    </div>
  );
}
