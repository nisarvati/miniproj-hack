# Stock risk score and low-stock alerts

Pharmacy staff get a **stock-risk score** (0 to 100) for every medicine they stock and a **low-stock alert** when a medicine runs low. Both are
staff-only, in the pharmacy portal, and both are derived from the pharmacy's own stock. This is an operational aid for deciding what to look at
first. It is not a forecast, not a clinical or medical judgement, and it does not tell patients anything.

## The score

Source: `packages/pharmacy-ops/src/risk.ts` (a pure function, `assessStockRisk`, no I/O, tested in `packages/pharmacy-ops/test/risk.test.ts`).

Inputs: **q**, the units on hand, and **T**, the low-stock threshold (a whole number of at least 1).

| Case | Score |
|---|---|
| `q <= T` (low-stock condition) | `round(60 + 40 × (T − q) / T)`: 60 exactly at the threshold, up to 100 at zero stock |
| `q > T` | `min(59, round(60 / (q/T)²))`: falls quickly as stock grows past the threshold; never reaches the 60 of a breach |
| inputs missing or invalid | no score (`null`), level `UNKNOWN`, with the reason |

Two factors add up to the score, and each is returned with its points and a plain-language sentence:

- **Stock against the threshold** (`position`): 60 points once at or below the threshold; above it, between 0 and 59 by how many times the threshold the stock is.
- **How far below the threshold** (`depth`): 0 to 40 points, the share of the threshold level already gone. Zero stock always adds the full 40.

Levels: **0–24 LOW**, **25–49 MODERATE**, **50–74 HIGH**, **75–100 CRITICAL**.

With the default threshold of 5:

| Units | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 | 15 | 25 | 55 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Score | 100 | 92 | 84 | 76 | 68 | 60 | 42 | 31 | 23 | 15 | 7 | 2 | 0 |

Properties the tests pin: the score is an integer from 0 to 100 and deterministic; **it is 60 or more exactly when the medicine is at or below the threshold**
(so a breach is always HIGH or worse, and healthy stock cannot score high); zero stock is always 100; the score never rises as stock grows; invalid input is `UNKNOWN`, never 0 or 100.

**Why this formula.** The only reliable data MedLink has per medicine is the current stock and the threshold it already uses for the public "low stock" label
(`LOW_STOCK_THRESHOLD`). The score is simple enough to explain in one table, continuous at the threshold, and consistent with the alert (an alert is open exactly when the score is 60+).

**What it deliberately does not use.**
- *Sales speed / days of stock left.* The only sales history is the portal's movement history, which covers just the sales recorded there since tracking began (nothing is
  back-filled, and sales made some other way are not in it). A consumption rate computed from that would be a guess. Every response says so (`salesSpeedUsed: false` and a `demand` factor with `available: false`).
- *Expiry.* Out of scope for this milestone.

## Threshold

One setting, `LOW_STOCK_THRESHOLD` (default 5, a whole number from 1 to 1,000,000), read by both the search service (for the public LOW_STOCK label) and the
pharmacy portal (for alerts and the score), so the two agree. It is set in the environment (`.env.example`) and shown in every response (`meta.threshold`) and on the page. There is **no per-medicine or
staff-editable threshold**: that would need a schema change, an authorization rule and a UI, and nothing yet justifies it. Changing the value takes effect on the next read (the alerts are reconciled).

## Alerts

Table `stock_alerts` in **each pharmacy's own database** (migration `packages/db/pharmacy-migrations/004_stock_alerts.sql`). It lives with the pharmacy's stock so an alert can only belong to the pharmacy whose database it is in; there is no
pharmacy identifier to get wrong. It is derived state: the `inventory` table stays the authority, and the alert never changes stock.

| Rule | How |
|---|---|
| Open | A `LOW_STOCK` alert opens when a medicine is at or below the threshold, zero stock included. It records the stock, the threshold and the risk score at that moment. |
| No duplicates | A partial unique index allows one `ACTIVE` alert per medicine and type. Repeated and concurrent evaluations find the existing one. |
| Resolve | When stock is back above the threshold the active alert becomes `RESOLVED` (`STOCK_RECOVERED`, with the stock then). A medicine the pharmacy stops listing resolves with `NO_LONGER_STOCKED`. |
| Open again | Falling low again later opens a **new** alert; the resolved one stays as history. |
| Rolled-back or refused change | No alert: evaluation happens only after a change has committed. |
| Patients | Nothing is sent to patients or by email/SMS. Alerts are separate from restock subscriptions and notifications, which work as before (a RESTOCK still notifies a waiting shopper; a sale never does). |

### When it is evaluated

1. **After every committed change** made through the portal (sale, restock, stock count, add or remove a medicine): `PharmacySimulator` re-checks that medicine in its **own transaction after the change committed**.
   A problem there is logged and never fails or undoes the sale (tested by renaming the table mid-sale).
2. **Whenever staff read** `/portal/risk` or `/portal/alerts`: the whole pharmacy is reconciled first. This catches stock changed some other way (plain SQL by the pharmacy's own software) and a changed threshold, and it repairs a missed step in (1).

Evaluation reads the stock under a row lock, so it sees the latest committed change, and every step is idempotent, so running it any number of times, at the same time as itself or as a sale, converges on the same state.

**Consistency.** Alerts for portal changes are in place when the request returns. A change made outside the portal appears the next time someone reads the alerts, and its alert's `createdAt` is when MedLink first
noticed it, not when the stock changed. The alerts do not go through Redis or the sync service, so they do not depend on, or wait for, synchronization to search.

### Why not the event pipeline, and why no SSE `alert` event

Alerts are private to a pharmacy's staff. `GET /api/stream` is public and unauthenticated, so putting alert data on it would publish staff-only information: **no `alert` event is emitted** and the public search API has no alert or risk data
(`tests/stock-alerts.test.ts` checks both). The portal page refreshes the alerts after anything recorded in it and on load. Pushing alerts to *other* staff sessions in real time would need an authenticated stream, which does not exist yet.
Nothing was added to the inventory pipeline, and no consumer-group message is read or acknowledged for this.

## API

All need the portal session cookie (`401` without it). The pharmacy always comes from the session; a `pharmacyCode` query parameter is ignored. Responses use the portal's `{ data, meta }` envelope and error shape.

| Endpoint | Returns |
|---|---|
| `GET /portal/risk?level=&limit=&offset=` | Every medicine the pharmacy stocks, highest risk first (ties by code): `medicineCode`, `medicineName`, `quantity`, `threshold`, `belowThreshold`, `score`, `level`, `summary`, `factors[]`, `alert` (`{ alertId, state, createdAt }` or `null`). `level` is one of LOW, MODERATE, HIGH, CRITICAL; `limit` 1–200 (default 50), `offset` 0–100000. `meta`: `total`, `hasMore`, `threshold`, `thresholdSetting`, `salesSpeedUsed: false`. |
| `GET /portal/risk/:code` | The same for one medicine. `404 NOT_STOCKED` if this pharmacy does not carry it (even if another does); `400` for a malformed code. |
| `GET /portal/alerts?state=&limit=&offset=` | Alerts newest first. `state` ACTIVE (default), RESOLVED or ALL; `limit` 1–100 (default 20). Each: `alertId`, `pharmacyCode`, `medicineCode`, `medicineName`, `type`, `state`, `quantityAtCreation`, `threshold`, `riskScoreAtCreation`, `createdAt`, `resolvedAt`, `resolvedReason`, `quantityAtResolution`, and for an active alert `current` (today's assessment, with factors). |

Invalid filters or paging are `400 VALIDATION_ERROR`. If the pharmacy database has not had migration `004`, these answer `503 PHARMACY_SCHEMA_OUTDATED` (a sale still succeeds). Example:

```json
{ "data": [ { "medicineCode": "M006", "medicineName": "Augmentin 625mg", "quantity": 3, "threshold": 5, "belowThreshold": true, "score": 76, "level": "CRITICAL",
              "summary": "3 units left, at or below the threshold of 5: risk 76, critical.",
              "factors": [ { "id": "position", "label": "Stock against the threshold", "points": 60, "available": true, "detail": "3 units on hand is at or below the low-stock threshold of 5, which starts at 60 points." },
                           { "id": "depth", "label": "How far below the threshold", "points": 16, "available": true, "detail": "2 units short of the threshold of 5 (40% of it) adds 16 points." },
                           { "id": "demand", "label": "Sales speed", "points": null, "available": false, "detail": "Not used: …" } ],
              "alert": { "alertId": "…", "state": "ACTIVE", "createdAt": "…" } } ],
  "meta": { "total": 14, "limit": 50, "offset": 0, "hasMore": false, "threshold": 5, "thresholdSetting": "LOW_STOCK_THRESHOLD", "formulaVersion": 1, "salesSpeedUsed": false } }
```

(Example values, not real data.) There is no endpoint that reconciles on its own: reading is the reconcile, and the function is safe to run repeatedly.

## In the portal

"Stock risk and low-stock alerts", above the stock list: the plain-language explanation and the threshold in use; **Active alerts** (medicine, units, threshold, level and score, the summary,
"How this score is made", and **Restock this**, which opens the restock form for that medicine); **Risk by medicine, highest first** (8 per page); and **Recently resolved alerts**. Level styling is calm for LOW and
MODERATE and only HIGH and CRITICAL ask for attention; the level is always written, never colour alone.

## Setup and trying it

```bash
npm run pharmacies:migrate        # once, after pulling this change: adds migration 004 to each pharmacy database (never seeds or changes stock)
npm run dev:all                   # or portal:dev etc.; LOW_STOCK_THRESHOLD is read from .env (default 5)
```

Demonstrate with a synthetic sequence at a pharmacy you may change (a restock afterwards puts the stock back):

1. Record a sale that brings one medicine to the threshold or below (portal → Record a sale). An alert appears under Active alerts with the score.
2. Record another sale: the same alert stays, with a higher score; no second alert.
3. Press **Restock this**, add enough to go above the threshold: the alert disappears from Active and shows under Recently resolved.

Tests:

```bash
npx vitest run packages/pharmacy-ops/test/risk.test.ts packages/pharmacy-ops/test/alerts.test.ts apps/pharmacy-portal/test/risk.test.ts \
  tests/stock-alerts.test.ts apps/web/src/components/portal
```

## Known limitations

- Staff-visible only; no real-time push to other open staff sessions, no email or SMS, nothing to patients.
- A change made outside the portal is noticed on the next read, with `createdAt` = when it was noticed.
- One global threshold; no per-medicine override. Changing it changes how every medicine is rated on the next read, and an active alert keeps the threshold it was opened under (`threshold`) while `current` uses today's.
- The score ignores how fast something sells (see above), so a slow seller at 6 units and a fast seller at 6 units score the same.
- Alerts exist only in pharmacy databases that have had migration `004`.
