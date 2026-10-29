# API reference

Three HTTP surfaces: the **public search API** (`:4000`), the **pharmacy portal API** (`:4200`, sessions) and the **web app's own routes** (`:3000`). Every route below exists in the code
(`apps/search-service`, `apps/pharmacy-portal`, `apps/web/src/app`); the lists are checked by tests (`apps/search-service/test/security.test.ts` pins the public route list). Deeper behaviour is in
the linked pages. Values in examples are illustrative.

## Conventions

- JSON in, JSON out: `{ "data": …, "meta": … }`. Errors: `{ "error": { "code", "message", "requestId", "details"? } }`; `requestId` matches the `x-request-id` header (a safe client-sent one is kept).
- Errors never contain stack traces, file paths, SQL or secrets (tested). Unknown request-body fields are refused with `400` on the write endpoints.
- Lists are bounded: every list takes `limit` (with a documented maximum) and `offset` where paged; out-of-range values are `400 VALIDATION_ERROR`.
- Every response carries `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer` and `content-security-policy: default-src 'none'; frame-ancestors 'none'`. The portal also sends `cache-control: no-store`.
- CORS: only the origins in `CORS_ORIGINS` (default `http://localhost:3000`). The portal allows credentials from them; the public API never does.
- Authentication: the public API has none (it serves public data). The portal uses a signed, HttpOnly, SameSite=Lax session cookie. No token is ever accepted in a URL.

## Public search API (`:4000`)

| Method and path | Parameters | Answers |
|---|---|---|
| `GET /api/search` | `q` (1–100 chars), `lat`, `lng` (required), `limit` 1–50 (medicines, default 20), `inStock`, `maxDistanceKm` (above 0, up to 500), `maxPrice`, `sort` = `best`/`distance`/`price`/`stock` | ranked offers with `matchPercent` and `matchReasons`; `meta.rejected` and `meta.rejectionSummary` for offers the chosen filters left out. [matching.md](matching.md) |
| `GET /api/medicines/search` | `q`, `limit` | catalogue medicines matching a name |
| `GET /api/medicines/:id/substitutes` | `lat`, `lng` | same-ingredient medicines in stock nearby, with a notice that strength or form may differ |
| `GET /api/pharmacies` · `/api/pharmacies/:id` · `/api/pharmacies/:id/stock` | `lat`,`lng` (optional) · `q`, `inStock` | pharmacies, one pharmacy (with distance), and what it lists with live status |
| `GET /api/directory` | | directory listings that are not inventory providers |
| `GET /api/inventory` · `/api/inventory/:id` | `pharmacyId`, `medicineId`, `limit` ≤ 200, `offset` | inventory rows with a stock status |
| `GET /api/nodes` | | per-pharmacy synchronization status. [node-status.md](node-status.md) |
| `GET /api/stream` | `Last-Event-ID` header | Server-Sent Events. [live-updates.md](live-updates.md) |
| `POST /api/restock-subscriptions` | body `{ email, medicineId }` | ask to be told when a medicine is back in stock (`201` new, `200` already waiting) |
| `GET /api/restock-subscriptions` · `DELETE /api/restock-subscriptions/:id` | `email` | a person's waiting list; cancel one |
| `GET /api/notifications` | `email`, `limit` ≤ 100 | restock notifications for an email |
| `GET /api/health` · `GET /health` | | `200 {status:"ok", checks}` or `503 {status:"degraded"}` |

**Privacy note.** The three restock-subscription/notification routes identify a person by **email address alone**, with no sign-in: anyone who knows an address can read and cancel its subscriptions.
That is the documented design (there is no patient session in the search API), and it is the main privacy gap; see [security.md](security.md).

**SSE events** (`GET /api/stream`, public): `connected` (first), `node` (a pharmacy's synchronization status changed), `stock` (a pharmacy change has been processed: `pharmacyCode`, `medicineCode`,
`eventType`, quantity after, price, time), `heartbeat` (every 15 s). Ids are `<bootId>.<n>`; `Last-Event-ID` replays what was missed or says `resync: true`. No alert, risk, plan, movement or account data
is ever sent, and nothing about the caller changes what is sent.

## Pharmacy portal API (`:4200`)

Every route needs a session except `POST /portal/signup`, `POST /portal/login`, `POST /portal/logout` and `GET /health`. Without a valid session: `401 UNAUTHENTICATED`. With the **wrong role**: `403 FORBIDDEN`.
Staff routes act on the **signed-in staff member's own pharmacy only**; a `pharmacyCode` in a body is refused and one in a query string is ignored. Another pharmacy's resource id answers `404` (its existence is not revealed).

### Accounts and sessions

| Method and path | Role | Notes |
|---|---|---|
| `POST /portal/signup` `{ email, password (≥10), pharmacyCode }` | none | creates a **pending staff** request; always `202`, so it does not reveal which emails exist. No role can be requested |
| `POST /portal/login` `{ email, password }` | none | `200` sets the cookie and returns `{ email, role, pharmacy }`. `401 INVALID_CREDENTIALS`, `403 ACCOUNT_PENDING` / `ACCOUNT_NOT_APPROVED`, `429 TOO_MANY_ATTEMPTS` (with `Retry-After`) |
| `POST /portal/logout` | any | clears the cookie (`204`) |
| `GET /portal/me` | STAFF or ADMIN | `{ email, role, pharmacy }`; `pharmacy` is `null` for an administrator |

### Pharmacy staff (role STAFF)

| Method and path | Purpose | Docs |
|---|---|---|
| `GET /portal/stock` · `GET /portal/catalogue` | the pharmacy's stock · medicines it does not list yet | [pharmacy-portal.md](pharmacy-portal.md) |
| `PATCH /portal/stock/:code` `{ quantity?, price? }` · `POST /portal/stock` `{ medicineCode, quantity, price }` · `DELETE /portal/stock/:code` | count the shelf / change price · list a medicine · stop listing it | |
| `POST /portal/sales` · `POST /portal/restocks` `{ medicineCode, quantity }` + optional `Idempotency-Key` | atomic sale / received stock: stock, outbox event and history row in one transaction. `409 INSUFFICIENT_STOCK`, `422 IDEMPOTENCY_KEY_REUSED` | [inventory-transactions.md](inventory-transactions.md) |
| `GET /portal/history?limit&offset` | movement history, newest first | |
| `GET /portal/risk?level&limit&offset` · `GET /portal/risk/:code` | explainable 0–100 stock-risk scores | [stock-risk.md](stock-risk.md) |
| `GET /portal/alerts?state&limit&offset` | low-stock alerts (`restockPlan` shows an open plan) | |
| `POST /portal/restock-plans` · `GET /portal/restock-plans?status&limit&offset` · `GET` / `PATCH /portal/restock-plans/:id` · `GET /portal/restock-plans/export.csv?status` | restock planning (planning only: never changes stock) and CSV export | [restock-planning.md](restock-planning.md) |

### Administrator (role ADMIN)

| Method and path | Purpose |
|---|---|
| `GET /portal/admin/staff-requests?status&limit&offset` | accounts oldest first; `status` = `pending` (default), `active`, `rejected`, `all`; limit ≤ 100. No password hashes |
| `POST /portal/admin/staff-requests/:id/decision` `{ decision }` | `approve` or `reject` a pending staff request; `revoke` an active staff account (their next request is `401`). `404 ACCOUNT_NOT_FOUND`; `409 ACCOUNT_STATE` (wrong state, or an administrator account, which cannot be decided here) |

An administrator has no pharmacy and **every staff route answers `403` to them**.

### Portal error codes

`VALIDATION_ERROR` (400, with `details`), `INVALID` (400, a value the operation refuses), `INVALID_IDEMPOTENCY_KEY`, `UNAUTHENTICATED` (401), `INVALID_CREDENTIALS` (401), `FORBIDDEN` (403), `ACCOUNT_PENDING` / `ACCOUNT_NOT_APPROVED` (403),
`NOT_FOUND` / `PLAN_NOT_FOUND` / `ACCOUNT_NOT_FOUND` / `NOT_STOCKED` / `UNKNOWN_MEDICINE` / `UNKNOWN_PHARMACY` (404), `ALREADY_STOCKED` / `INSUFFICIENT_STOCK` / `PLAN_ALREADY_OPEN` / `INVALID_TRANSITION` / `PLAN_CLOSED` / `ACCOUNT_STATE` (409),
`IDEMPOTENCY_KEY_REUSED` (422), `TOO_MANY_REQUESTS` / `TOO_MANY_ATTEMPTS` (429), `PHARMACY_SCHEMA_OUTDATED` (503: run `npm run pharmacies:migrate`), `INTERNAL_ERROR` (500).

## Web app routes (`:3000`)

Pages: `/` (landing), `/search`, `/pharmacies`, `/pharmacies/[id]`, `/notifications`, `/dashboard`, `/portal`, `/signin`, `/account`, `/calendar`. Server routes: `/auth/[...nextauth]` (Google sign-in for patients),
`/calendar-api/entries` (`GET`, `POST`) and `/calendar-api/entries/[id]` (`GET`, `PATCH`, `DELETE`): a signed-in patient's private calendar ([medicine-calendar.md](medicine-calendar.md), [authentication.md](authentication.md)).

## Health endpoints of the background services

`GET http://127.0.0.1:4301/health` (connector), `:4302` (sync), `:4303` (notifications): `{ service, status, ready, uptimeSec, dependencies, details, hints }`; `200` when ready, `503` when degraded.
Bound to the loopback address, never to the network.
