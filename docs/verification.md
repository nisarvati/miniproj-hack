# Verification

What has actually been run, what it showed, and what has **not** been checked. Nothing here is a claim about
production; it is the state of the repository on a developer machine (Node 22, macOS, local Docker Postgres and Redis).

## Automated checks

| Check | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | clean |
| Types | `npm run typecheck` | clean (root and `@medlink/web`) |
| Tests | `npm test` | 117 files passed, 1 skipped; 1746 tests passed, 6 skipped |

Most test files use a real Postgres and Redis (the dev containers), not mocks. `tests/` holds service-level
integration tests; component tests cover the web UI with a mocked `fetch`.

**Not run:** `npm run test:cluster` (Redis Cluster mode; needs `npm run cluster:up`), real SMTP delivery (email is
switched off in the dev stack), and any browser. There is no browser end-to-end suite.

## Synchronization and recovery (covered by existing tests)

| Behaviour | Where it is tested |
| --- | --- |
| Duplicate delivery does not change state | inventory-sync and flow tests (dedup markers) |
| Stale or out-of-order events do not overwrite newer state | inventory-sync stale-event guard tests |
| Malformed events go to the dead-letter stream, not silently dropped | inventory-sync dead-letter tests |
| A consumer that crashes mid-event is taken over | crash-takeover tests (`XAUTOCLAIM`) |
| Redis down: events wait in the outbox and are published later | connector retry tests |
| Central mirror down: Redis state and the stream are unaffected | inventory-sync mirror-outage tests |
| Health reports degraded when a dependency fails | service health tests |

These were confirmed to exist and pass in the full run above. They were not re-derived by hand.

## Role and security checks (this milestone)

- `apps/pharmacy-portal/test/roles.test.ts`: 401/403 matrix over every staff and admin route, forged, expired and
  revoked credentials, cross-pharmacy attempts, role read from the database on each request, sign-up cannot request a
  role, database constraints on role/pharmacy, admin operations, login throttling with an injected clock, headers,
  production secret guard.
- `apps/search-service/test/security.test.ts`: the public route list is pinned, no staff routes or fields leak, CORS
  allows only the configured origin, security headers are present including on the SSE response.
- `AdminPanel.test.tsx`: admin screen states, approve/decline/revoke, paging.

Also checked against the **running dev stack** with curl and synthetic accounts (all removed afterwards):

- An administrator created with `portal:users create-admin` signs in; `/portal/me` shows `role: ADMIN` and no pharmacy.
- Creating the same email again, and a password under 12 characters, are refused.
- Every staff route answers 403 to the administrator.
- A sign-up that tries to send a role is rejected (400). A pending account cannot sign in (`ACCOUNT_PENDING`).
- The administrator approves the request; the staff member signs in and reads stock (200) but gets 403 on admin routes.
- The administrator revokes access; the staff member's **existing** cookie is refused (401) on the next request.
- Eight wrong passwords for one email give 401, then 429 with `Retry-After: 900`.
- Security headers are present on the API and on the SSE response.

## Measured latency

`npm run perf:measure -- --yes --pairs 10` on P005, 20 sequential transactions (10 sale and restock pairs, net zero),
everything on one machine:

| Stage | min | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| Portal transaction committed | 9 ms | 14 ms | 29 ms | 30 ms |
| Visible in search | 442 ms | 541 ms | 985 ms | 1001 ms |
| Announced on the SSE stream | 481 ms | 970 ms | 985 ms | 1471 ms |

All 20 were under 500 ms (transaction) and 5 s (stream); no timeouts; stock was restored and the throwaway account
and its movement rows removed. Dominated by the connector poll (about 1 s) and the stream hub poll (500 ms). This is
a single-machine sample, **not a load test**, and says nothing about a networked deployment.

## Browser checks: not performed

No browser was driven. The UI is covered by component tests only. Before a demo, walk this list by hand:

1. Landing page loads; search for a medicine returns results with match percentage and reasons.
2. A rejected (filtered-out) result shows its reason.
3. `/dashboard` shows five nodes and updates when stock changes.
4. `/portal`: sign in as `p001@pharmacy.test`; the header shows pharmacy P001's name and address.
5. Record a sale, then a restock; the history table shows both.
6. Risk scores and low-stock alerts render; "Restock this" fills the form.
7. Create a restock plan, change its status, download the CSV.
8. Sign in as an administrator: only the access-request panel appears; approve and decline work.
9. Sign out; protected pages redirect to sign-in.

## Requirements matrix

| Requirement | Status |
| --- | --- |
| Federated search across independent pharmacies | Implemented, tested |
| Each pharmacy owns its database; changes via outbox | Implemented, tested |
| Redis Streams delivery, dedup, ordering, dead-letter | Implemented, tested |
| Live updates in the browser (SSE) | Implemented, tested; browser not driven |
| Atomic sale/restock with history and idempotency | Implemented, tested |
| Stock risk and low-stock alerts | Implemented, tested |
| Match explanations and rejections | Implemented, tested |
| Restock planning and CSV export | Implemented, tested |
| Staff and administrator roles | Implemented, tested |
| Container deployment of the apps, CI | **Not built** (see [deployment.md](deployment.md)) |
| Redis Cluster | Supported by key design; cluster test suite not run here |

## Dashboard layout (browser-measured)

Measured with headless Google Chrome over the DevTools protocol against the running dev stack, with the staff-only endpoints answered by a synthetic fixture so the busiest (staff) view could be
measured. This is a layout check, not a data check, and it is not an automated test in the repository. Fit means the section is no taller than the stage and no card's content spills out or overlaps another.

| Viewport | Overview | Inventory | Synchronization | Network | Restock |
| --- | --- | --- | --- | --- | --- |
| 1440 x 900 (staff, signed-out, admin) | fits | fits | fits | fits | fits |
| 1366 x 768 (staff, signed-out, admin) | fits | fits | fits | fits | fits |
| 768 x 1024, staff | fits | scrolls (892 > 731 px) | scrolls (852) | scrolls (861) | fits |
| 768 x 1024, signed-out | fits | fits | scrolls (852) | scrolls (861) | fits |
| 390 x 844 | page scrolls, 0.7 to 2 screens per section, no horizontal overflow | | | | |

Tooltips were checked to stay on screen and inside their card at every size. Unit tests cover the layout rules, chart sizing, tooltip clamping, the shell and the overview table.
