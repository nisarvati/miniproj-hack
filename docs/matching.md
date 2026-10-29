# Match percentage, match reasons and rejected results

`GET /api/search` ranks the pharmacies that carry a medicine. Each result now also says **how well it fits MedLink's ranking rules as a percentage and why**,
and the search lists the offers the person's own filters **left out, with the reason**. Nothing about how results are ranked or which are shown has changed.

## What the percentage means (and does not)

The percentage is the existing ranking `score` (`apps/search-service/src/modules/ranking/rank.ts`) written out of 100. It is **not a second score**.
The ranking score is a weighted sum of four factors, each between 0 and 1, with weights that add up to 1, so the score is itself between 0 and 1; that is what
makes "× 100" a percentage of the most an offer can earn rather than an arbitrary rescaling.

```
score        = wAvailability·availability + wDistance·distance + wPrice·price + wRelevance·relevance     (0 to 1)
matchPercent = round(100 × score)             using the score at the four decimals the response publishes it with
```

So a reader can always check `matchPercent == round(score × 100)` on a result. It is a whole number from 0 to 100.

It means **"how well this listing satisfies MedLink's documented ranking rules for this search"**: how well the name matches, whether it is in stock, how close it is and how it is priced.
It is **not** a probability, **not** clinical suitability or advice, **not** a recommendation to switch to a different medicine, and **not** a promise that the medicine is available.
(Stock-risk scores for pharmacy staff, see [stock-risk.md](stock-risk.md), are a separate thing and are never combined with this.)

### The factors, weights and normalisation

Default weights (from `RANK_WEIGHT_*`, normalised to add up to 1): **availability 0.4, distance 0.3, price 0.2, relevance 0.1**. These are an initial product choice, not derived from medical or empirical evidence.

| Factor | Value from 0 to 1 | Notes |
|---|---|---|
| availability | in stock 1, low stock (at or below `LOW_STOCK_THRESHOLD`) 0.5, out of stock 0 | |
| distance | `1 − distanceKm / maxDistanceKm`, clamped to 0..1 (`RANK_MAX_DISTANCE_KM`, default 15) | **Unknown distance earns 0.** It is never treated as zero distance. |
| price | min-max within each medicine: lowest price 1, highest 0 | The range is set by the **in-stock** offers of that medicine among the **eligible** results (all of them if none is in stock). **When there is no spread (one offer, or equal prices) the factor is 1**: that is how the ranking has always worked, and the reasons say so (below). |
| relevance | exact brand name 1, exact generic 0.9, brand starts with the search 0.8, generic starts with it 0.6, anything else 0.4 | from the name search |

Each factor contributes `100 × weight × value` points to the percentage. The four contributions are rounded **together** (largest remainder) into whole `points`, so **the points of a result's four reasons add up to exactly its `matchPercent`**.
A tie in the ranking is broken as before: in-stock before out of stock, then higher score, then nearer, then cheaper, then input order.

### Order of operations

The match is calculated **after the filters**, on the eligible offers only, as the ranking always was. So the price factor compares an offer with the other eligible in-stock offers of the same medicine: change a filter and the percentages can change.
Offers the filters left out are not scored.

## Match reasons

Each eligible result has `matchPercent` and `matchReasons`: exactly one reason per factor, in the fixed order name, stock, distance, price.

```json
{ "code": "NEARBY", "factor": "distance", "points": 24, "factorValue": 0.88, "message": "About 1.2 km away: close enough to earn most of the distance credit." }
```

| Code | Factor | When | Points |
|---|---|---|---|
| `NAME_MATCH` | relevance | always (the message says how the name matched) | 0–10 at default weights |
| `IN_STOCK` | availability | in stock above the low-stock threshold | full |
| `LOW_STOCK` | availability | in stock at or below the threshold | half |
| `OUT_OF_STOCK` | availability | none in stock (or stock not known) | 0 |
| `NEARBY` | distance | a **verified** distance that earns at least half the distance credit | by distance |
| `DISTANCE` | distance | a verified distance that earns less than half (none from `maxDistanceKm`) | by distance, can be 0 |
| `MISSING_DISTANCE` | distance | no distance can be claimed: the pharmacy's map location is not verified, or the user's location is not set | **0**, and the message says that is not the same as being far away |
| `PRICE_COMPARISON` | price | there is a real comparison set: **two or more** in-stock offers of this medicine among the eligible results with different prices | by price |
| `PRICE_NO_COMPARISON` | price | no comparison set (one offer, equal prices, or none known) | whatever the ranking gave it (full credit when there is no spread) |
| `MISSING_PRICE` | price | no price is known | 0 |

Rules the code and tests enforce:
- `NEARBY` and any distance in a message appear **only** with a verified distance; distances are shown to one decimal (no false precision).
- "The lowest price" / "The highest price" is said **only** with a valid comparison set and only for an offer that is in stock; an offer with no stock is "compared with the in-stock range". With no comparison set the message says there is nothing to compare it with and does not call it cheap or dear.
- A factor whose underlying figure is missing earns 0 whatever else is passed in, so a reason that says "no credit" can never sit next to points.
- Messages never contain a unit count (the public site does not show how many units a pharmacy has).
- `MISSING_PRICE` cannot arise from the current data path (a price always comes from the catalogue or live stock); it exists so the function stays safe.

## Rejected results

A rejection is a **hard filter the person chose**, evaluated on the actual offer. A low match percentage is never a rejection: every offer that passes the filters is a result, however low it ranks.
The filters are evaluated by one function (`apps/search-service/src/modules/search/rejection.ts`) that also decides eligibility, so the result list and the explanation cannot disagree. **Every** requested filter an offer fails is listed, not just the first.

| Code | Filter | Triggering condition |
|---|---|---|
| `OUT_OF_STOCK` | `inStock=true` | no units in stock |
| `PRICE_LIMIT_EXCEEDED` | `maxPrice` | price strictly above the limit |
| `OUTSIDE_DISTANCE_LIMIT` | `maxDistanceKm` | **verified** distance strictly beyond the limit |
| `MISSING_REQUIRED_DATA` | `maxDistanceKm` or `maxPrice` | the figure the filter needs is missing: no verified distance (`field: "distance"`, because the pharmacy's location is not verified or the user's is not set) or no price (`field: "price"`) |

A filter that was not chosen never produces a rejection. There is **no `DOES_NOT_MATCH_QUERY`**: medicines that do not match the search are not candidates in the first place (the query itself selects the medicines), so there is nothing evaluated to reject, and none are invented.

Each rejected entry carries the same public details as a result (medicine, pharmacy, price, stock status, verified distance or none) plus `reasons[]` (`code`, `filter`, `message`, `limit`, `actual`, and `field` where relevant). It has no match percentage and is never ranked.

### Where it is in the response

`data` is unchanged: the eligible results, in the same order, and `meta.count` is their number. Rejected offers are in **`meta.rejected`**, with **`meta.rejectionSummary`**:

```json
"rejected": [ { "medicine": { "…": "…" }, "pharmacy": { "…": "…" }, "price": 28, "stockStatus": "OUT_OF_STOCK", "distanceKm": 9.1, "distanceVerified": true,
                "reasons": [ { "code": "OUT_OF_STOCK", "filter": "inStock", "message": "Out of stock, and you chose in-stock pharmacies only.", "limit": null, "actual": 0 },
                             { "code": "OUTSIDE_DISTANCE_LIMIT", "filter": "maxDistanceKm", "message": "About 9.1 km away, beyond your limit of 5 km.", "limit": 5, "actual": 9.1 } ] } ],
"rejectionSummary": { "total": 6, "byReason": { "OUTSIDE_DISTANCE_LIMIT": 2, "MISSING_REQUIRED_DATA": 4 }, "shown": 6, "truncated": false },
"matchModelVersion": 1
```

- `rejected` lists at most **20** (`REJECTED_SHOWN`), in a fixed order: by medicine, then verified distance (unknown last), then price, then pharmacy. `rejectionSummary` counts **all** of them: `total` is the number of offers left out, `byReason` the number failing each filter (an offer failing two counts in both, so these can add up to more than `total`), `shown` how many are listed, `truncated` whether some are not.
- With no filter chosen, `rejected` is `[]` and the summary is all zeros.
- The existing `meta.unverifiedFiltered` keeps its meaning: offers left out **only** because their distance could not be established.
- Search results are not paginated by offer: `limit` (1–50) bounds how many **medicines** the query matches. Rejected offers never change that, the count of results, or their order.
- The substitutes endpoint (`/api/medicines/:id/substitutes`) is unchanged: its `best` offer carries no match percentage, and its notice (strength or form may differ; ask a pharmacist or doctor) stands. A match percentage is never used to suggest that one medicine can replace another.

## Examples

An eligible result (abridged): a verified pharmacy 1.2 km away, in stock, lowest of three prices.

```json
{ "rank": 1, "score": 0.904, "matchPercent": 90,
  "matchReasons": [
    { "code": "NAME_MATCH", "factor": "relevance", "points": 10, "factorValue": 1, "message": "Matches the brand name you searched exactly." },
    { "code": "IN_STOCK", "factor": "availability", "points": 40, "factorValue": 1, "message": "In stock, which earns the full availability credit." },
    { "code": "NEARBY", "factor": "distance", "points": 20, "factorValue": 0.68, "message": "About 4.8 km away: close enough to earn most of the distance credit." },
    { "code": "PRICE_COMPARISON", "factor": "price", "points": 20, "factorValue": 1, "message": "₹25. The lowest price in ₹25 to ₹31 across 3 pharmacies with stock in these results: a lower price earns more credit." } ] }
```

A result with no known distance: the same shape, with `{ "code": "MISSING_DISTANCE", "points": 0, "factorValue": null, "message": "No distance is known (…), so it earns no distance credit. That is not the same as being far away." }`.
(Illustrative figures; they add up: 10 + 40 + 20 + 20 = 90.)

## In the web app

Each result shows **"90% match"** (text, with a screen-reader label) and its strongest two factors; **"Why 90%?"** opens the four reasons with their points and a reminder of what the percentage is not. With filters on, a separate section
**"Not matching your filters"** follows the results: each left-out listing with its reasons, labelled as not a recommendation. It is hidden when no filter is chosen, nothing was left out, or the search failed; with no eligible result it appears under the usual "No pharmacies match your filters".

## Known limitations

- Only offers for medicines the query matched, at pharmacies that list them, are evaluated. A pharmacy that does not list a medicine is not a rejected candidate.
- The price factor is relative to the other eligible offers, so it changes with the filters and is full credit for a lone offer (documented in the reason, but still how the ranking works).
- Distance credit depends on verified locations. Most demo pharmacies have none, so their percentage is lower than a verified neighbour's for that reason alone, and the reason says so.
- A single global ranking weight set; no per-user preferences. The percentage is relative to MedLink's rules, not an absolute quality.
- At most 20 rejected offers are listed; the summary has the full counts.
- `DOES_NOT_MATCH_QUERY` is not implemented, by design (see above).
- Tested through automated tests and the API; the browser rendering is covered by component tests, not by a browser run.

## Try it

```bash
npx vitest run apps/search-service/test/match.test.ts apps/search-service/test/search-matching.test.ts \
  apps/web/src/components/search apps/web/src/lib/api.test.ts
curl -s 'localhost:4000/api/search?q=Crocin&lat=19.1364&lng=72.8296&inStock=true&maxDistanceKm=5' | python3 -m json.tool | head -80
```
