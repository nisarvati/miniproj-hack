# Pharmacy portal

Where pharmacy staff sign in to change their stock: set the quantity on the shelf, change a price, list a medicine
or stop listing one. A change made here reaches **everything that shows stock**, because it travels the same way a
change from real pharmacy software does.

```mermaid
flowchart LR
  P["portal (staff sign-in)"] -->|plain SQL, one transaction| DB[("pharmacy's own DB")]
  DB -->|"trigger"| OB[("outbox")]
  OB --> C[connector] -->|XADD| S[("Redis stream")]
  S --> I[inventory-sync]
  I --> R[("Redis state")] --> A["search · pharmacy page · map"]
  I --> M[("central inventory table")] -.->|"fallback when Redis is down"| A
  S --> N[notification-service] --> U["restock notifications"]
```

The portal **never writes to Redis or to MedLink's central inventory table**. It writes to the pharmacy's own
database through `@medlink/pharmacy-ops` (the same code the pharmacy simulator uses, so the validation and the
"no overselling" locking are shared), and the pipeline carries the change from there. It needs the connector and sync
service running (`npm run connector:start`, `npm run sync:start`); without them a change waits in the pharmacy's
outbox and is caught up when they start.

## Run it

```
npm run db:migrate                  # adds the pharmacy_users table, and its sign-up status (migration 005)
npm run portal:seed-users           # p001@pharmacy.test ... p005@pharmacy.test, password medlink-dev
npm run portal:dev                  # the portal API on :4200
npm run web:dev                     # the web app; the portal is at /portal ("Pharmacy staff sign in" in the footer)
```

New staff request access on the same page ("Request access for your pharmacy"); an administrator approves them with
`npm run portal:users` (see below).

(plus `npm run infra:up`, `pharmacies:setup`, `connector:start`, `sync:start` as for the rest of the pipeline.)

## What staff can do

| Action | Endpoint | Recorded as |
| --- | --- | --- |
| Set the quantity on the shelf | `PATCH /portal/stock/:code` `{ quantity }` | `SALE` if lower, `RESTOCK` if higher, nothing if equal |
| Change the price | `PATCH /portal/stock/:code` `{ price }` | `PRICE_UPDATED` |
| List a medicine | `POST /portal/stock` `{ medicineCode, quantity, price }` | `MEDICINE_ADDED` |
| Stop listing a medicine | `DELETE /portal/stock/:code` | `MEDICINE_REMOVED` |
| Record a sale | `POST /portal/sales` `{ medicineCode, quantity }` | `SALE`, plus a movement-history row |
| Record a restock | `POST /portal/restocks` `{ medicineCode, quantity }` | `RESTOCK`, plus a movement-history row |
| See the movement history | `GET /portal/history?limit&offset` | (read only) |
| Plan a restock (a note, not stock) | `POST/GET /portal/restock-plans`, `GET/PATCH /portal/restock-plans/:id`, `GET /portal/restock-plans/export.csv` | (planning only; see [restock-planning.md](restock-planning.md)) |
| See stock risk and low-stock alerts | `GET /portal/risk`, `GET /portal/risk/:code`, `GET /portal/alerts` | (read only; see [stock-risk.md](stock-risk.md)) |

Sales, restocks and the history are described in [inventory-transactions.md](inventory-transactions.md). A quantity change through `PATCH` is also written to the history (marked as a stock count).

Also `POST /portal/signup`, `POST /portal/login`, `POST /portal/logout`, `GET /portal/me`, `GET /portal/stock` (read from the pharmacy's own
database) and `GET /portal/catalogue` (medicines the pharmacy does not list yet: every product in the central catalogue, including the imported batch described in [catalogue.md](catalogue.md)).

`POST /portal/login` and `GET /portal/me` answer `{ email, pharmacy: { code, name, address, registeredName } }`. The pharmacy is the one in the session cookie, read from the central `pharmacies` table and shown the way shoppers see it (`presentPharmacy`). `registeredName` is MedLink's own label for the account and is `null` when it equals `name`. With no row for the code, `name` is `Pharmacy <code>` and `address` is `null`. The portal header and the "Managing inventory for ..." heading show these fields.

## Sign-in and who can change what

Roles are `STAFF` (one pharmacy) and `ADMIN` (none). Sign-in is throttled (8 wrong passwords per account, 40 per address, per 15 minutes, then 429). See [security.md](security.md).

- Accounts live in the central `pharmacy_users` table: an email, a scrypt password hash and **one** pharmacy code.
- Signing in sets a signed (HMAC), `HttpOnly`, `SameSite=Lax` cookie holding the user and the pharmacy code. It
  expires after `PORTAL_SESSION_HOURS` (8). Every request also checks that the account still exists.
- The pharmacy is **always taken from the session**, never from the request, and request bodies are strict, so a
  P001 login cannot change P002's stock whatever it sends.
- Cross-origin requests are allowed only from `CORS_ORIGINS`, with credentials.

## Signing up and approval

Staff ask for access to **one existing pharmacy** (P001...). The request is not an account you can use: it is stored in
`pharmacy_users` with `status = 'pending'`, and only `active` accounts can sign in, change stock, or keep a session
(`requireAccount` checks the status on every request, so rejecting or removing someone ends their session at once).

- `POST /portal/signup` `{ email, password (10+ characters), pharmacyCode }` answers `202 { status: "pending" }`. The
  pharmacy must exist; the form cannot set a status or pick anything but the pharmacy code. The answer is the same when
  the email is already registered (and that account is left unchanged), so the form does not reveal which emails
  have accounts.
- Signing in with a correct password while pending answers `403 ACCOUNT_PENDING` (or `ACCOUNT_NOT_APPROVED` if
  rejected); a wrong password or unknown email still gets the ordinary `401`.
- At most 20 requests may wait per pharmacy (`429` after that), so the unauthenticated form cannot fill the table.
- Approving is an administrator action. Administrators (role `ADMIN`, no pharmacy) can use the portal's admin screen,
  or `GET /portal/admin/staff-requests` and `POST /portal/admin/staff-requests/:id/decision` (`approve`, `reject`,
  `revoke`), and every staff route answers an administrator with 403. The CLI still works:

```
npm run portal:users -- list            # pending requests (add "all" for every account)
npm run portal:users -- approve <email>
npm run portal:users -- reject <email>
```

  Only a pending request can be decided; an active account is never changed by it. Migration 005 defaults existing
  accounts (including the seeded ones) to `active`.
- A rejected email cannot request again; remove its row from `pharmacy_users` first. Approval is by email, so check
  the person really works at that pharmacy before approving.

Not built, on purpose, for development: email verification of the address, a notification to administrators when a
request arrives, password reset, roles inside a pharmacy, an audit
trail of who changed what. Add them before real use. Set `PORTAL_SESSION_SECRET` (required when
`NODE_ENV=production`) and serve it over HTTPS (the cookie is then also `Secure`).

## The central table follows live stock

Search prefers live stock from Redis but falls back to the central `inventory` table when Redis is down or does not
know a medicine. So that the fallback is not stale, **inventory-sync copies every applied change into that table**
(when it has `DATABASE_URL`; `SYNC_MIRROR=off` disables it). See `apps/inventory-sync/src/mirror.ts`.

- It copies the item as Redis now has it (already ordered and de-duplicated), so repeating or reordering is harmless,
  and a row is only overwritten by something not older (`updated_at <= asOf`).
- It is best effort: a failure is logged and counted, not retried, because the Redis change and its dedup marker are
  already committed. The next change to the same medicine writes the then-current state.
- A seeded row is stamped with the seed time, so an event older than that does not overwrite it.
- This replaces the old unauthenticated `POST/PATCH /api/inventory` endpoints, which wrote only to this table and
  were overridden by live stock. They are gone; `GET /api/inventory` remains.
