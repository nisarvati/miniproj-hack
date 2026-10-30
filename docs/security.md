# Security, roles and known gaps

## Roles

The hackathon brief asks for secure login with three roles: *User*, *Partner / Recruiter / Pharmacist* and *Admin*. MedLink is a medicine-discovery product, so the middle role is **pharmacy staff**
(the "Pharmacist" in the brief): there is no recruiting in this domain, and no recruiter functionality was added.

| Role | Who | How they sign in | What they can do | Where it is enforced |
|---|---|---|---|---|
| **User** (patient) | anyone who searches; optionally signed in | public search needs nothing; the personal medicine calendar needs Google sign-in (Auth.js, web app) | search, subscribe to restock alerts, keep a private calendar | the calendar API checks the Auth.js session on the server ([authentication.md](authentication.md)) |
| **STAFF** (pharmacist) | an employee of one pharmacy | email and password in the portal, **after an administrator approves** the request | everything about **their own pharmacy** only: stock, sales and restocks, history, risk and alerts, restock plans, CSV export | portal API, every request, from the database ([routes](api.md)) |
| **ADMIN** | a MedLink administrator | email and password; created only by an operator | approve, decline and remove staff access. **Nothing about any pharmacy's data** | portal API, every request |

A patient is not a portal account at all: a patient's web session is a different cookie signed with a different secret, and the portal does not accept it (tested). There is no way to turn a patient into staff without an administrator.

### How the checks work

- The portal session cookie is signed (HMAC), HttpOnly, SameSite=Lax (Secure in production) and carries only the account id and the pharmacy it was issued for. **It does not carry the role.**
- On **every request** the portal reads the account again: it must exist, be `active`, and still hold the same pharmacy. The **role comes from that database row**. So a client cannot supply or change a role,
  and an administrator removing someone takes effect on their very next request (tested).
- `requireStaff` and `requireAdmin` guard every protected route; nothing is protected only in the browser. Unauthenticated: `401`. Wrong role: `403`. Another pharmacy's resource id: `404` (its existence is not revealed).
- Staff routes use the pharmacy from the account, never from the request: a `pharmacyCode` in a body is refused, in a query string ignored.
- **Least privilege.** An administrator has no pharmacy (a database constraint ties each role to its scope), so every staff route is `403` for them: they cannot read or change stock, history, alerts, plans or exports.
  There is no hardcoded allowlist and no default administrator. Existing accounts were migrated to STAFF (migration `007`); nobody was promoted.
- **Creating an administrator** needs database access: `PORTAL_ADMIN_PASSWORD='…' npm run portal:users -- create-admin <email>` (password of at least 12 characters, from the environment so it never reaches shell history).
  It refuses an email that already has an account: administrators are created new, never promoted.
- Sign-up can only create a **pending staff** request for a pharmacy; it cannot ask for a role, a status, or no pharmacy (the body is strict, and tested).

## Controls in place

| Area | Control | Evidence |
| --- | --- | --- |
| Portal behind Vercel | Browser calls the portal on the web app's own origin (`/portal-api`), so the session cookie stays first-party (`HttpOnly`, `SameSite=Lax`, `Secure`); the proxy forwards only `/portal-api/portal/*` to one validated, server-side upstream; the upstream is absent from browser bundles | `apps/web/src/server/portal-upstream.test.ts`, `apps/web/src/lib/portal-base.test.ts`; built and exercised end to end against a stand-in upstream (docs/deployment.md) |
| Login throttle behind proxies | `TRUST_PROXY` is a hop count (off by default); a forwarded address is ignored unless trusted, and only the nearest N proxies are believed | `apps/pharmacy-portal/test/proxy.test.ts` |
| Worker health | Heartbeats carry counts and states only; a stale or missing one is never evidence of health | `apps/search-service/test/heartbeat-health.test.ts` |
| Analytics | `GET /api/analytics/network` is public and carries only counts of stream entries and stock statuses. `GET /portal/analytics` is staff-only, scoped to the session's pharmacy, read-only, and 403 for administrators | `apps/search-service/test/analytics.test.ts` (no quantities, sales, risk, alerts, plans), `apps/pharmacy-portal/test/analytics.test.ts` (isolation, read-only), `roles.test.ts` (401/403 matrix) |
|---|---|---|
| Authorization | server-side roles on every protected route; matrix of all route families × caller types | `apps/pharmacy-portal/test/roles.test.ts` |
| Pharmacy isolation | pharmacy from the account; separate databases per pharmacy; cross-pharmacy reads and writes tested for stock, history, alerts, plans and export | `roles.test.ts`, `transactions.test.ts`, `restock-plans.test.ts`, `risk.test.ts` |
| Password guessing | 8 wrong passwords per (address, email) and 40 per address in 15 minutes → `429` with `Retry-After`; applies equally to emails with no account; correct passwords are not counted | `roles.test.ts` |
| Passwords | scrypt with a per-password salt; constant-time comparison; the same work for an unknown email (no account enumeration by timing) | `portal.test.ts` |
| Sessions | HMAC-signed, expiring (8 h default), re-validated against the database on every request; **no session or token in any URL** | `portal.test.ts`, `roles.test.ts` |
| Secrets | `.env` is git-ignored and was never committed; the built-in dev session secret is refused when the portal listens beyond this machine, and in production | `roles.test.ts` (config) |
| Injection | every SQL value is a bound parameter; the few interpolated fragments are constants or numbered placeholders (reviewed across the code base) | audit in [verification.md](verification.md) |
| CSV | formula-injection defused (`=`, `+`, `-`, `@`, tab, CR get a leading `'`), RFC 4180 escaping, export capped at 10,000 rows, filename built from non-request data | `csv.test.ts`, `restock-plans.test.ts` |
| Public vs staff data | the public API has no staff route (route list pinned), none of its answers contains staff, account, alert, plan or credential data, and the public SSE stream carries only `connected`, `node`, `stock`, `heartbeat` | `security.test.ts`, `stream.test.ts`, `tests/stock-alerts.test.ts` |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a deny-all CSP on every API answer, including the SSE stream | `security.test.ts`, `roles.test.ts` |
| CORS and CSRF | only configured origins; the cookie is SameSite=Lax, so a cross-site form post carries no session, and state-changing requests from another origin need a CORS preflight that is refused | `security.test.ts` |
| Errors | generic `500`, no stack, path, SQL or secret in any error body | `security.test.ts`, `roles.test.ts` |
| Money and stock | row locking prevents overselling; idempotency keys make retries safe; a failed transaction leaves no history, event or alert | `movements.test.ts`, `transactions.test.ts` |
| Plans vs stock | restock plans never write stock, history, outbox or Redis (the source is checked by a test) | `restock-plans.test.ts` |

## Known gaps (not fixed, and why)

1. **Restock notifications are keyed by email only (privacy, highest).** `GET /api/notifications?email=`, `GET/DELETE /api/restock-subscriptions` have no sign-in: anyone who knows an email address can
   read which medicines it is waiting for and cancel them. It is the documented design ("there is no sign-in yet, so the email is the caller's identity", `notifications/routes.ts`) and fixing it means
   tying subscriptions to the patient's Google session, a redesign, not a fix. Do not use real patients' addresses in a public demo. Subscription data is only a medicine and a time; no health information is stored.
2. **Logout does not invalidate a cookie, it only clears it.** Sessions are stateless. Access is withdrawn by an administrator removing the account (effective at the next request), or by the session expiring (8 h).
3. **The login limiter lives in one process's memory.** It resets on restart and is per portal process; behind a reverse proxy, every client shares the proxy's address unless the proxy is configured as trusted. Fine for a single local portal.
4. **Seeded development accounts have a shared, known password** (`PORTAL_DEV_PASSWORD`, default `medlink-dev`). They are for local development; set the variable (or skip `portal:seed-users`) on any machine others can reach.
5. **The public stock API returns exact quantities** (`/api/search`, `/api/inventory`, `/api/pharmacies/:id/stock`). The web app deliberately shows only "in stock / low / out", but the API is open. Availability is the product's purpose; revisit if a pharmacy considers its counts commercially sensitive.
6. **No TLS, WAF or rate limit on the public API.** Both APIs listen on `127.0.0.1` by default; put a reverse proxy with TLS and rate limits in front before exposing them (the SSE endpoint caps itself at 100 streams).
7. **Staff accounts are plain email and password**, with no second factor and no password reset flow.
8. **The portal's dev defaults assume one machine.** Cookies are not `Secure` outside production.
