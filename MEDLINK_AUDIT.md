# MedLink: repository audit

Read-only audit of `/Users/vati/medlink` (npm-workspaces monorepo, TypeScript). Nothing was changed except this file. Secret files (`.env`, `.env.local`) were not opened; environment variables are described from `.env.example` and the code.

**The most important finding first.** MedLink as built is a **federated medicine search and discovery platform** ("find which nearby pharmacy lists a medicine"), *not* a pharmacy inventory-management system. It has an excellent event-driven multi-node stock-sync pipeline and a polished web app, but most of the *hackathon requirements* (Admin role, dispensing transactions, expiry, stock-out risk score, prescription rules, restock planning, .ics/PDF export, dashboard history, Docker/hosting, README) **do not exist yet**. Section 4 marks each one. Section 6 is the build order.

---

## 1. Project overview

### Tech stack

| Layer | What is used |
|---|---|
| Language / runtime | TypeScript, Node 22 (ES modules), run with `tsx`; npm workspaces |
| Web app (`apps/web`) | Next.js 16 (App Router), React 19, Tailwind v4, Leaflet maps, GSAP (landing pages), Auth.js `next-auth@5.0.0-beta.32` (Google), `pg` |
| APIs | Fastify 5 (`search-service`, `pharmacy-portal`), Zod validation |
| Databases | PostgreSQL 16 (central DB + one database per pharmacy), `pg_trgm` for fuzzy search |
| Messaging / state | Redis 7 Streams (events), Redis hashes (live stock), optional 6-node Redis Cluster; `ioredis` |
| Email | Nodemailer + Gmail SMTP (off by default) |
| Tests / tooling | Vitest (about 1,114 tests in 92 files; last run green), ESLint, `tsc` |
| Infra | `docker-compose.yml` with Postgres, Redis and an optional Redis Cluster profile. **No app containers.** |

### Folder structure

| Path | Purpose |
|---|---|
| `apps/web` | Customer-facing Next.js site: landing pages, `/search`, `/pharmacies`, `/notifications`, `/calendar`, `/signin`, `/account`, `/portal` (staff UI) |
| `apps/search-service` | Public read API (port 4000): search, ranking, substitutes, pharmacies, restock subscriptions |
| `apps/pharmacy-portal` | Staff API (port 4200): signup, login, edit **own** pharmacy's stock |
| `apps/inventory-connector` | Reads each pharmacy's outbox and publishes events to Redis Streams |
| `apps/inventory-sync` | Consumes streams, de-duplicates, applies events to Redis state, mirrors to central Postgres |
| `apps/notification-service` | Turns RESTOCK events into notifications and optional emails |
| `apps/pharmacy-simulator` | CLI/demo that plays pharmacy software (sell, restock, price) and traces an event through the pipeline |
| `packages/db` | Migrations (central + per-pharmacy), seed data, catalogue import, pharmacy registry, health helper |
| `packages/event-schema` | The versioned inventory event contract (Zod) and Redis key helpers |
| `packages/pharmacy-ops` | Shared pharmacy operations (the code behind sell/restock/set quantity/add/remove) |
| `packages/redis` | Redis client wrapper (standalone and cluster) |
| `scripts/` | `dev-all.ts` (starts every service), `services-status.ts` (health of everything) |
| `tests/` | Cross-service integration tests (pipeline, live search, portal, restock email) |
| `docs/` | 12 design/ops documents (Redis Streams design, portal, simulator, auth, calendar, frontend, etc.) |
| `MEDLINK_PROJECT_CONTEXT.md`, `AGENTS.md`, `PRODUCT.md` | Long internal context and engineering rules (no root `README.md`) |

### How to run locally

Prerequisites: Node 22, Docker.

```
cp .env.example .env            # set POSTGRES_PASSWORD (compose refuses to start without it)
npm install
npm run infra:up                # Postgres (host port 5433) + Redis (6379)
npm run db:migrate && npm run db:seed        # central DB: 001-006 migrations, 15 seed medicines, 5 pharmacies
npm run pharmacies:setup        # one database + role per pharmacy (P001-P005)
npm run dev:all                 # starts every service below
# or individually: api:dev, portal:dev, web:dev, connector:start, sync:start, notify:start
npm run portal:seed-users       # staff logins for the portal (needs PORTAL_DEV_PASSWORD)
npm run demo                    # embedded pharmacy simulator walk-through
npm test | npm run typecheck | npm run lint
```

| Port | Service |
|---|---|
| 3000 | Web (Next.js) |
| 4000 | search-service (`/api/*`, `/health`) |
| 4200 | pharmacy-portal (`/portal/*`) |
| 4301 / 4302 / 4303 | health endpoints of connector / sync / notification service (127.0.0.1) |
| 5433 | Postgres (host) |
| 6379 (7001-7006 in cluster mode) | Redis |

Environment variables (names only; see `.env.example`): `POSTGRES_*`, `DATABASE_URL`, `REDIS_URL` / `REDIS_MODE` / `REDIS_CLUSTER_NODES`, `PORT`, `CORS_ORIGINS`, `LOW_STOCK_THRESHOLD`, `RANK_WEIGHT_*`, `RANK_MAX_DISTANCE_KM`, `LIVE_STOCK`, `PORTAL_PORT`, `PORTAL_SESSION_SECRET`, `PORTAL_SESSION_HOURS`, `PORTAL_DEV_PASSWORD`, `PHARMACY_P00x_DATABASE_URL`, `CONNECTOR_*`, `SYNC_*`, `NOTIFY_*`, `EMAIL_DELIVERY_ENABLED` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM`, `HEALTH_PORT_*`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_SITE_URL`. The **web app reads `apps/web/.env.local` only**, for `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `AUTH_URL` and `DATABASE_URL` (needed by the calendar).

---

## 2. Data model

### Central database (`medlink`, migrations 001-006)

| Table | Fields | Relationships / notes |
|---|---|---|
| `users` | id, name, email (unique), latitude, longitude, created_at | Email-keyed "anonymous" identity used by restock alerts. Not an authenticated user. |
| `medicines` | id, **code** (`M001`), brand_name, generic_name, dosage, form, created_at | Unique (brand, dosage, form); trigram indexes on brand and generic |
| `pharmacies` | id, **code** (`P001`), name, address, latitude, longitude, created_at | Unique (name, address) |
| `inventory` | id, pharmacy_id, medicine_id, **quantity**, **price**, updated_at | FK to both; unique (pharmacy, medicine). A **mirror** of pharmacy stock (search's fallback), not the source of truth. **No expiry, batch or reorder fields.** |
| `restock_subscriptions` | id, user_id, medicine_id, status (`ACTIVE`/`NOTIFIED`/`CANCELLED`), created_at, notified_at | One active subscription per (user, medicine) |
| `notifications` | id, user_id, subscription_id (unique), medicine_id, pharmacy_id, event_id, channel, message, created_at, delivered_at | `message` text can contain a unit count, e.g. "(12 available)" |
| `pharmacy_users` | id, email (unique, case-insensitive), password_hash (scrypt), pharmacy_code, status (`pending`/`active`/`rejected`), decided_at, created_at | Staff accounts, each bound to **one** pharmacy. **No role column.** |
| `patients` | id, provider (`google`), provider_subject, email, name, created_at | Keyed by Google's stable `sub` (unique on provider + subject) |
| `medicine_calendar_entries` | id (UUID), patient_id, medicine_id (nullable), medicine_name, entry_type (`WANT_TO_GET`/`ORDERED`/`PURCHASED`/`REMINDER`), entry_date (DATE), notes, status (`OPEN`/`DONE`), completed_at, created_at, updated_at | Cascade-deleted with the patient; index (patient, date) |

### Per-pharmacy databases (`pharmacy_p001` ... `pharmacy_p005`, one DB + role each)

| Table | Fields | Notes |
|---|---|---|
| `pharmacy_profile` | singleton, pharmacy_code, name | Exactly one row |
| `inventory` | medicine_code (PK), quantity (>=0), price (>0), updated_at | The **authoritative** stock |
| `outbox` | id, event_id (UUID, unique), event_type, medicine_code, quantity_delta, quantity_after, price, occurred_at, published_at, failed_at, error | Filled by a **database trigger** on every insert/update/delete of `inventory`, in the same transaction |

### Redis (live state)

Per-pharmacy streams (hash-tagged `{P001}` for cluster slots), a consumer group, dedup markers (`done` retained 168 h), per-medicine state hashes (quantity, price, timestamps, removed tombstone), per-pharmacy sync counters (`appliedCount`, `staleCount`, `duplicateCount`), and a dead-letter stream.

### Seed data

* 15 medicines (`M001-M015`, e.g. Crocin, Dolo, Augmentin, Glycomet), 5 pharmacies in Mumbai (`P001-P005`), generated stock per pharmacy (`packages/db/src/seed*.ts`).
* A 167-record medicine catalogue (`packages/db/catalogue/batch-001.json`, imported with `db:catalogue`).
* A 6-pharmacy "demo directory" of real Mumbai shops with simulated inventory (`pharmacy-directory/mumbai-demo.json`, P006+ optional).
* Staff users via `portal:seed-users` (password from `PORTAL_DEV_PASSWORD`).

---

## 3. API

Responses use `{ data, meta }` and `{ error: { code, message, details? } }`. Request ids are propagated (`x-request-id`). CORS is restricted to `CORS_ORIGINS`.

### search-service (port 4000), **no authentication on any route**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health`, `/api/health` | DB (and Redis live-stock) liveness |
| GET | `/api/medicines/search?q=` | Fuzzy medicine name/brand search (autocomplete) |
| GET | `/api/search?q&lat&lng&limit&inStock&maxDistanceKm&maxPrice&sort=best\|distance\|price\|stock` | The main search: ranked offers across pharmacies, live stock overlaid from Redis, `meta.weights` shows the ranking weights |
| GET | `/api/medicines/:id/substitutes?lat&lng` | Same-generic alternatives that are in stock nearby |
| GET | `/api/pharmacies` | Pharmacies near a point (sorted by distance) |
| GET | `/api/directory` | The demo directory listing |
| GET | `/api/pharmacies/:id` | One pharmacy |
| GET | `/api/pharmacies/:id/stock` | Its stock list with status and summary |
| GET | `/api/inventory`, `/api/inventory/:id` | Raw central inventory mirror (paged) |
| POST | `/api/restock-subscriptions` | Ask to be told when a medicine is back (`{email, medicineId}`) |
| GET | `/api/restock-subscriptions?email=` | List a person's subscriptions |
| DELETE | `/api/restock-subscriptions/:id?email=` | Cancel one |
| GET | `/api/notifications?email=` | List restock notifications |

### pharmacy-portal (port 4200), signed cookie `medlink_portal`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/portal/signup` | none | Request staff access to a pharmacy (stays `pending`; capped per pharmacy) |
| POST | `/portal/login` | none | Email + password (scrypt); sets HttpOnly SameSite=Lax cookie |
| POST | `/portal/logout` | cookie | Clears the cookie (sessions are stateless) |
| GET | `/portal/me` | pharmacist | Who am I, and which pharmacy |
| GET | `/portal/stock` | pharmacist | Own pharmacy's stock (from its own DB) |
| GET | `/portal/catalogue` | pharmacist | Catalogue medicines not yet stocked |
| PATCH | `/portal/stock/:code` | pharmacist | Set absolute quantity and/or price |
| POST | `/portal/stock` | pharmacist | Add a medicine to stock |
| DELETE | `/portal/stock/:code` | pharmacist | Remove a medicine |

Every portal route is scoped to the session's single `pharmacyCode`. **There is no admin API**: approval is done with `npm run portal:users -- approve|reject <email>`.

### Web app (port 3000)

* Pages: `/`, `/search`, `/pharmacies`, `/pharmacies/[id]`, `/notifications`, `/calendar`, `/signin`, `/account`, `/portal`, `/landing/v1-v5`.
* `GET|POST /auth/*` (Auth.js, Google only; mounted at `/auth`, not `/api/auth`).
* `/calendar-api/entries` (GET list, POST create) and `/calendar-api/entries/:id` (GET, PATCH, DELETE): patient calendar, requires a Google session; identity is the Google `sub` on the server; ownership enforced in SQL; same-origin check on writes.

### Background services

`GET /health` on 127.0.0.1:4301 / 4302 / 4303 (connector, sync, notifications): process, dependencies, readiness, counters, hints.

**WebSocket / SSE: none.** The browser refreshes by polling (see 4.3).

---

## 4. Features against the hackathon requirements

| # | Requirement | Verdict |
|---|---|---|
| 1 | Login with roles (User, Pharmacist, Admin) | **PARTIAL** |
| 2 | Core transactions | **PARTIAL** |
| 3 | Live updates without refresh | **PARTIAL** |
| 4 | Alerts, stock-out risk, 0-100 score | **MISSING** (only status labels) |
| 5 | Rule-based matching (prescription-only blocked) | **MISSING** |
| 6 | Planning: restock suggestions, nearest pharmacy | **PARTIAL** |
| 7 | Multi-node sync | **PARTIAL** (engine DONE; UI and one-process caveat) |
| 8 | Exports, history dashboard, node health | **MISSING / PARTIAL** |
| 9 | Deployment | **MISSING** |
| 10 | README | **MISSING** |

### 4.1 Login with roles: PARTIAL
* **User**: Google sign-in for patients (`apps/web/src/auth.ts`, `auth-actions.ts`, `docs/authentication.md`). Anonymous browsing is allowed; restock alerts use a typed email only.
* **Pharmacist**: staff accounts with scrypt hashes, signed HttpOnly session cookie, per-pharmacy scoping, sign-up approval flow (`apps/pharmacy-portal/src/{auth,routes,users,admin}.ts`, migrations 004-005, UI `apps/web/src/components/portal/PortalPage.tsx`).
* **Admin**: **missing as a role.** Approval exists only as a CLI (`portal:users`). No `role` column, no admin login, no admin UI or API, no authorisation checks beyond "this session's pharmacy".
* Gaps: three separate identity systems (Google patients, portal staff, anonymous email) and no shared role model; portal sessions are stateless (cannot be revoked); there is no password reset.

### 4.2 Core transactions: PARTIAL
* **Add stock**: `POST /portal/stock` adds a catalogue medicine; `PATCH /portal/stock/:code` sets an absolute count. A *restock by N units* exists only in the simulator CLI (`packages/pharmacy-ops/src/simulator.ts` `restock`), not as an HTTP route or UI button.
* **Dispense**: `sell()` exists with validation (`INSUFFICIENT_STOCK`, whole numbers, delta rules) but is **only reachable from the simulator/CLI**. There is no dispense endpoint or screen, no patient/prescription/dispense record, no transaction log table beyond the outbox.
* **Medicine search**: **DONE.** `pg_trgm` fuzzy search, ranking by availability, distance, price and relevance, filters, sorting, substitutes, map view (`apps/search-service/src/modules/search`, `medicines`, `ranking`).
* **Validation**: **DONE** at every boundary (Zod on routes and events, DB `CHECK` constraints, the trigger rejects code changes).
* Atomicity: stock change plus its outbox event are one transaction (trigger), which is strong.

### 4.3 Live updates: PARTIAL
* Server side is event-driven end to end: pharmacy DB trigger -> outbox -> connector (poll 1 s) -> Redis Stream -> sync (blocking read) -> Redis state, which search reads. Measured in the simulator docs: about 110 ms embedded, about 1 s with the standalone connector (`docs/pharmacy-simulator.md`).
* Browser side is **polling**, not push: `SearchPage.tsx` and `PharmacyPage.tsx` refetch every **20 s** (and on tab focus); the notification count polls too (`providers/account.tsx`). There is no WebSocket or SSE channel anywhere. So a change is visible after up to ~20 s, which misses a "within about 5 s" target.

### 4.4 Alerts, risk, score: MISSING
* Only `stockStatus` = IN / LOW / OUT from a global `LOW_STOCK_THRESHOLD` (default 5) in `search-service/.../inventory/stock.ts`. It is a label, not an alert, and not per-medicine.
* **No expiry data at all** (no expiry/batch columns, no alerts).
* **No stock-out risk, no 0-100 score, no explanation.** The only "score" in the code is the 0-1 search *relevance/ranking* score (`ranking/rank.ts`), which is a different thing.
* Related, real: restock **notifications to shoppers** (`apps/notification-service`) when a medicine returns. That is not a pharmacist low-stock alert.

### 4.5 Rule-based matching: MISSING
* No prescription-only / schedule flag on medicines, no rules engine, no "blocked with a reason".
* Adjacent, real: `findSubstitutes` (same generic name, ranked by same strength and form) and an API note that "a substitute is a suggestion, not a prescription" (`search/service.ts`, `search/routes.ts`). The product copy states MedLink does not prescribe or dispense.

### 4.6 Planning: PARTIAL
* **Nearest pharmacy**: **DONE.** Haversine distance in search and in `/api/pharmacies`; `sort=distance`; the web ranks pharmacies from the chosen location; verified vs unverified coordinates are handled.
* **Restock suggestions**: **MISSING** (no reorder level, consumption rate, lead time, or suggestion output).

### 4.7 Multi-node sync: PARTIAL (the strongest part)
Done and tested (`docs/redis-streams.md`, `apps/inventory-*`, `packages/event-schema`, `tests/pipeline.test.ts`):
* **2+ nodes, separate DB each**: five pharmacy databases with separate roles; the pharmacy DB is authoritative and the central mirror is derived.
* **Event-based sync**: transactional outbox -> versioned event schema -> Redis Streams -> consumer group.
* **Duplicates**: stable `eventId`, two-state dedup marker (lease + `done`), atomic apply-and-mark in one Lua script.
* **Out-of-order**: per-field event-time comparison, `quantityAfter` stored (not deltas), tombstones for removed medicines; the same result for any arrival order (tested).
* **Recovery**: Redis down -> events wait in the outbox; sync down -> streams hold them; Redis AOF; pending-entry take-over after `SYNC_MIN_IDLE_MS`; dead-letter stream after `SYNC_MAX_DELIVERIES`.
* **Sync status**: per-service `/health`, `npm run services:status`, per-pharmacy counters in Redis, `npm run pharmacies:status`.

What is missing or weak:
* **No sync status *page*** in the web app (CLI and JSON only).
* The "nodes" are databases on **one Postgres server**, and one connector process serves all pharmacies; there are no separate pharmacy *servers* to show "2 servers, one goes offline". The simulator and `PHARMACY_P00x_DATABASE_URL` make it easy to fake, but it is not demonstrated as independent processes or hosts.
* Streams are capped at about 100,000 entries per pharmacy (a long consumer outage can lose the oldest); retry delay is a flat 10 s (no backoff).

### 4.8 Exports, history, node health: MISSING / PARTIAL
* **Exports**: no `.ics`, no PDF anywhere (no PDF library; no iCalendar output). The patient calendar is in-app only.
* **Dashboard history**: none. There is no history table or chart; the pharmacy outbox is a de-facto event log but has no read API or UI.
* **Node health view**: PARTIAL, as CLI (`services:status`) and JSON `/health`, not a web page.

### 4.9 Deployment: MISSING
* `docker-compose.yml` provides only Postgres, Redis and an optional Redis Cluster. **No Dockerfile**, no containers for web / search-service / portal / connector / sync / notifications, no `render.yaml`, `fly.toml`, `vercel.json`, Procfile or CI config.
* Production gotchas already visible: `next.config.ts` rewrites `/api` and `/portal-api` **only in development**, so in production the browser calls `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`, **baked in at build time**) and needs CORS; services bind `127.0.0.1` by default; every service starts via `tsx` (no build step).

### 4.10 README: MISSING
* No root `README.md`. Good internal documentation exists (`docs/*.md`, 12 files; `MEDLINK_PROJECT_CONTEXT.md`; `AGENTS.md`), including setup (`docs/development.md`) and ASCII flow diagrams, but there is no single entry point, no architecture diagram image, no team roles.
* **Scoring formula**: the search *ranking* weights are documented in `.env.example` (availability 0.4, distance 0.3, price 0.2, relevance 0.1) and returned in `meta.weights`; there is no stock-risk score formula because that feature does not exist.

---

## 5. Quality check

### Security
1. **search-service is fully unauthenticated**, including `/api/inventory` (raw mirror) and the restock endpoints. Subscriptions and notifications are identified **by typed email only**: anyone who knows an address can read and cancel its subscriptions (documented in code as a known limitation).
2. **No rate limiting on any HTTP service** (searched: none). Portal `/login` runs scrypt per attempt, so it is both brute-forceable and a cheap CPU-exhaustion target. No lockout. `/portal/signup` is capped per pharmacy but not per IP.
3. **Hard-coded development secret**: `apps/pharmacy-portal/src/config.ts` falls back to `DEV_SECRET = "medlink-dev-only-session-secret-change-me"` when not in production; production requires `PORTAL_SESSION_SECRET`, which is correct, but a staging deploy without `NODE_ENV=production` would sign sessions with a public string.
4. `.env.example` uses `change-me` placeholders; `.env` is git-ignored (not inspected). `docker-compose` requires `POSTGRES_PASSWORD` (good). All pharmacy DBs share one Postgres instance and host.
5. Portal sessions are stateless and cannot be revoked; the cookie is `Secure` only when configured; no CSRF token (relies on SameSite=Lax and JSON bodies).
6. Positives: parameterised SQL everywhere, Zod at every boundary, owner-scoped SQL for the calendar (patient identity is Google's `sub`), constant-time password and signature checks, location logged at about 1 km precision.

### Reliability and error handling
* Strong: central error handler with stable error codes, outbox parking for bad rows, dead-letter stream, health endpoints that distinguish process / dependencies / readiness.
* Known soft spots: one flaky timing test (`notification-service` "a channel that is down…", failed twice in full runs, passes alone); the seeded demo data and the "live" mirror can diverge if the sync service is off (search falls back to the mirror and labels it "last known").

### Performance (what would exceed your limits)
* **Transaction (< 500 ms):** a portal stock change is one small write plus a trigger in the pharmacy DB; expect tens of ms. The sale path is not exposed over HTTP, so it is not measured. Search does several queries (trigram match, inventory join, Redis overlay); with a 15-medicine seed it is fast, but **no latency measurements or load tests exist**. When filters are active the web fires a second unfiltered search (extra load per page).
* **Sync (< ~5 s):** server-side fine (about 0.1-1 s; connector poll 1 s, sync block 2 s). **Two things can exceed 5 s:** (a) the **20 s browser polling**, and (b) **failed deliveries retry only every 10 s** (`SYNC_MIN_IDLE_MS`). The notification sweep is 5 s.

### Other
* A stray `apps/web/.next-redesign/` build directory is present locally (git-ignored; safe to delete).
* The calendar persistence bug (random per-sign-in Google identifier) was fixed; entries saved before that fix sit under old identities and are not linked to the account.

---

## 6. Prioritised plan (ordered by marks)

Marks: core transactions + live updates (20), sync (15), scoring (15), matching + planning (15), deployment (15).

**Strategy note:** the repo's centre of gravity (search platform) differs from the hackathon brief (inventory management). The fastest path is to **reuse the pharmacy-portal + pipeline as the inventory system** and add the missing domain features on top, rather than rewriting.

1. **Core transactions + live updates (20 marks)**
   * Add pharmacist HTTP endpoints for **restock** (+N) and **dispense** (-N with validation, reason, and a `transactions` table recording who/what/when) by calling the existing `PharmacySimulator.restock/sell`; add buttons in `PortalPage.tsx`.
   * Add an **Admin role** (a `role` column on `pharmacy_users`, an admin login and a simple approvals screen/route replacing the CLI).
   * Replace the 20 s polling with **SSE** from search-service (Redis pub/sub or stream tail) and make the web listen; at minimum drop the poll to 3-5 s. Add `expiry_date`/batch to stock.
2. **Scoring (15 marks)**
   * Add expiry (batch table or `expiry_date`) and per-medicine `reorder_level`; compute **low-stock, expiry and stock-out-risk alerts** and a **0-100 risk score** (e.g. weights on days-of-cover from recent SALE events, expiry proximity, stock vs reorder level) with a plain-English "why" string; expose `/api/alerts` and a dashboard. Document the formula in the README.
3. **Sync (15 marks)**: mostly done, so spend on **visibility and the demo**
   * Add a **sync status page** (read `medlink:sync:*` counters + `/health` of each service into a JSON route and a web table: lag, applied/stale/duplicate counts, last event, up/down).
   * Make "2 servers" demonstrable: run two connector instances (`CONNECTOR_PHARMACIES`) and script an outage-and-recovery demo (`demo` + stop/start).
4. **Matching + planning (15 marks)**
   * Add `requires_prescription` / schedule to `medicines` and a **rules module** that blocks a dispense with a reason ("Prescription required: Schedule H"); return the reason in the API and UI.
   * **Restock suggestions** from consumption rate and reorder level, and keep the existing nearest-pharmacy search (already done) as the "nearest with stock" answer.
5. **Deployment (15 marks)**
   * Write one **Dockerfile** (multi-service via `command`) and extend `docker-compose.yml` with web, search-service, portal, connector, sync, notification services; set `NEXT_PUBLIC_API_URL` at build; add a hosting config (e.g. Render/Fly) and env documentation; bind to `0.0.0.0` in containers.
6. **Exports and history (remaining marks)**: `.ics` export of calendar entries (small: one route that serialises entries) and a printable/PDF report; a history chart from the outbox events.
7. **README**: one root `README.md` with setup, an architecture diagram (the outbox -> stream -> sync flow already exists as ASCII in `docs/redis-streams.md`), the scoring formula, and team roles.
8. **Hardening (cheap, do alongside):** add `@fastify/rate-limit` (login, search), remove the dev-secret fallback for non-local environments, require auth or signed tokens on restock endpoints, and add a simple latency check for search and stock updates.
