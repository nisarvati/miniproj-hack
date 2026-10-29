# Inventory transactions and movement history

Pharmacy staff can record a **sale** (dispensing) or a **restock** (stock received) in the portal, and see a **movement history**. Everything
happens in the pharmacy's own database, which stays authoritative for its stock; MedLink's search state is a copy that follows through the
normal event pipeline. This is not a point-of-sale or an ordering system.

## Flow of one transaction

```
POST /portal/sales  (session cookie: the pharmacy comes from the session, never from the request)
  one transaction in THAT pharmacy's database:
     lock the inventory row (SELECT ... FOR UPDATE)        -> concurrent sales queue up: no overselling
     check the stock, UPDATE inventory                      -> the outbox trigger writes the SALE / RESTOCK event row
     INSERT INTO inventory_movements                         -> the history row, pointing at that outbox event
  COMMIT  (or nothing at all)
  -> inventory connector -> Redis stream medlink:events:{P001} -> inventory-sync -> Redis state + central mirror
  -> live search, restock notifications (RESTOCK only), and GET /api/stream "stock" events (see live-updates.md)
```

The portal never touches Redis. A rolled-back transaction leaves no stock change, no outbox event and no history row; the tests prove this by
making the history insert fail and checking the stock and outbox are untouched. A `SALE` never triggers a patient's restock notification (only a
`RESTOCK` event does), and a price change is a different event again.

## Endpoints

All three need the portal session cookie (`401 UNAUTHENTICATED` without it). Responses use the portal's `{ data, meta? }` envelope and error shape
`{ error: { code, message, requestId, details? } }`. Unknown body fields are refused (`400`): in particular a `pharmacyCode` in the body is an error, and
one in the query string is ignored. The pharmacy is always the one in the session.

### `POST /portal/sales` and `POST /portal/restocks`

```http
POST /portal/sales
Content-Type: application/json
Idempotency-Key: 6f1c0f7e-2c3b-4a52-9d0e-0a6f6a8c1b11     (optional, 8 to 100 characters of A-Z a-z 0-9 _ . : -)

{ "medicineCode": "M006", "quantity": 2 }
```

`quantity` is a whole number from 1 to 1,000,000. `201 Created`:

```json
{
  "data": {
    "movementId": "402d4715-02ca-4d47-836c-6c03e001a637",
    "pharmacyCode": "P005",
    "medicineCode": "M006",
    "medicineName": "Augmentin 625mg",
    "operation": "SALE",
    "source": "TRANSACTION",
    "quantity": 2,
    "quantityDelta": -2,
    "quantityBefore": 60,
    "quantityAfter": 58,
    "occurredAt": "2026-10-29T16:55:01.120Z",
    "byYou": true,
    "eventId": "c5b0c7b4-0a37-4b8a-8d6f-3b55d3d1f6a4",
    "idempotencyKey": "6f1c0f7e-2c3b-4a52-9d0e-0a6f6a8c1b11"
  },
  "meta": { "replayed": false }
}
```

(The values are an example from a test run, not real figures.) `eventId` is the outbox event the change produced, so the movement can be followed downstream.
A restock is the same with `"operation": "RESTOCK"` and a positive `quantityDelta`.

| Status | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Quantity not a whole number of at least 1 (0, negative, fractional, a string, too large), a bad `medicineCode`, a missing or unknown field |
| 400 | `INVALID` / `INVALID_IDEMPOTENCY_KEY` | Bad `Idempotency-Key` (wrong length or characters, or sent twice); stock would exceed 1,000,000 |
| 401 | `UNAUTHENTICATED` | No valid session |
| 404 | `NOT_STOCKED` | The signed-in pharmacy does not carry that medicine (even if another pharmacy does) |
| 409 | `INSUFFICIENT_STOCK` | A sale of more than is on the shelf. Nothing is recorded; stock never goes negative |
| 422 | `IDEMPOTENCY_KEY_REUSED` | The key was already used for a different request (see below) |
| 503 | `PHARMACY_SCHEMA_OUTDATED` | The pharmacy database has not had migration `003` applied (run `npm run pharmacies:migrate`) |

### `GET /portal/history`

`?limit=` 1 to 100 (default 20) and `?offset=` 0 to 100000 (default 0); anything else is `400 VALIDATION_ERROR`. Newest first, ties broken by
id, so the order never changes between requests. The pharmacy is the session's; other query parameters are ignored.

```json
{ "data": [ { "movementId": "…", "pharmacyCode": "P005", "medicineCode": "M006", "medicineName": "Augmentin 625mg", "operation": "SALE", "source": "TRANSACTION",
              "quantity": 2, "quantityDelta": -2, "quantityBefore": 60, "quantityAfter": 58, "occurredAt": "…", "byYou": true, "eventId": "…", "idempotencyKey": null } ],
  "meta": { "total": 1, "limit": 20, "offset": 0, "hasMore": false } }
```

- `operation`: `SALE` (stock fell) or `RESTOCK` (stock rose), the same classification the outbox trigger uses.
- `source`: `TRANSACTION` (an explicit sale or restock) or `STOCK_COUNT` (staff set the quantity after counting the shelf with `PATCH /portal/stock/:code`).
- `byYou`: whether the signed-in staff member made it. No other staff identity is returned (the table keeps the account id, not an email address).
- Not recorded: adding or removing a listing, price changes, and anything done to a pharmacy database by other means. **Nothing is back-filled**:
  stock and outbox events from before the migration are not turned into history, and the history starts empty.

## Concurrency and atomicity

Each transaction locks the medicine's inventory row before it reads the stock, so two sales of the same medicine run one after the other and the
second sees what the first left (the tests fire 10 to 12 at once at a stock of 5 and exactly 5 succeed). The stock change, the outbox event and the history row
are one database transaction. Schema `CHECK`s additionally guarantee `after = before + delta` and that a `SALE` has a negative and a `RESTOCK` a positive delta.

## Idempotency

Send an `Idempotency-Key` header to make a retry safe (the portal page sends one for every entry and reuses it if you press the button again after a failure; editing the entry
starts a new key). It is enforced durably: a unique index on the movement row, written in the same transaction as the stock change.

- **Same key, same request** (same operation, medicine and quantity): applied once. Every repeat returns the original movement with `200` and `meta.replayed: true`, even if the stock has since changed.
- **Same key, different request** (another quantity, medicine, or sale versus restock): `422 IDEMPOTENCY_KEY_REUSED`; nothing changes.
- **Concurrent identical requests**: one applies, the rest wait for it and are replays (even for different medicines, one wins and the other gets `422`).
- Keys are per pharmacy. A request that **failed** (for example `INSUFFICIENT_STOCK`) is not remembered, so the same key can be used again later.
- No key: every request is its own transaction, as before. Stock counts (`PATCH`) are absolute and do not use keys.

## Database change

New pharmacy-schema migration `packages/db/pharmacy-migrations/003_movements.sql` (additive: one table `inventory_movements` with its indexes; no existing table or migration is touched).
It applies to every **pharmacy's own database**, not the central one.

```bash
npm run pharmacies:migrate    # applies only pending pharmacy migrations to each active pharmacy; safe to repeat; never seeds or changes stock
```

Do **not** use `pharmacies:setup` for this on a database with real data: it reloads the starting stock. New databases get the migration automatically. Until it is applied, stock
count edits and the new endpoints answer `503 PHARMACY_SCHEMA_OUTDATED`.

## In the portal page

Under "Managing inventory for …": a **Record a sale or restock** panel (the medicine list is the pharmacy's own, with how many are in stock; one submission at a time), the stock list, and a
**Movement history** table (10 per page, Newer / Older). A recorded entry refreshes the stock list and the history; shoppers' search results follow through the pipeline, and the live stream announces the change.

## Try it

```bash
npm run dev:all                       # or: api:dev, portal:dev, connector:start, sync:start, web:dev
npm run pharmacies:migrate            # once, after pulling this change
# sign in at http://localhost:3000/portal, or by API (the cookie is the session):
curl -s -c jar -X POST localhost:4200/portal/login -H 'content-type: application/json' -d '{"email":"<staff email>","password":"<password>"}'
curl -s -b jar -X POST localhost:4200/portal/sales    -H 'content-type: application/json' -H 'Idempotency-Key: demo-sale-000001' -d '{"medicineCode":"M006","quantity":1}'
curl -s -b jar -X POST localhost:4200/portal/restocks -H 'content-type: application/json' -H 'Idempotency-Key: demo-restock-0001' -d '{"medicineCode":"M006","quantity":1}'
curl -s -b jar 'localhost:4200/portal/history?limit=5'
curl -N localhost:4000/api/stream     # in another terminal: a "stock" event follows each change once the sync service has processed it
```

(A sale followed by a restock of the same size leaves stock where it was. A restock notifies shoppers who are waiting for that medicine, as any restock does.)

Tests:

```bash
npx vitest run packages/pharmacy-ops/test/movements.test.ts apps/pharmacy-portal tests/inventory-transactions.test.ts apps/web/src/components/portal
```

They use the `*_test` databases and unique Redis key prefixes; nothing in your development data is touched.

## Limitations

- History covers sales, restocks and stock counts made in the portal. It is not a complete audit log of every stock change.
- Offset paging: if movements are recorded while someone pages, a row can shift between pages.
- Idempotency keys are remembered as long as the movement row exists (there is no expiry).
- A stock count has no key; pressing it twice sets the same quantity twice, which is harmless.
