# Restock planning, progress tracking and CSV export

Pharmacy staff can write down **what they mean to order and by when**, track it, reschedule it and export the list. This is the pharmacy's own to-do list.
It is not an ordering system, and **a plan never changes stock**.

## Plans are not inventory transactions

| | Restock plan | Recorded restock (`POST /portal/restocks`) |
|---|---|---|
| What it is | a note: "order 50 of this by 5 Nov" | stock that has actually arrived |
| Changes stock, movement history, outbox, Redis, search | **never** | yes, atomically ([inventory-transactions.md](inventory-transactions.md)) |
| Reaches shoppers and restock notifications | no | yes, through the normal pipeline |

**Marking a plan COMPLETED means the planning task is done. It does not mean stock arrived.** When a delivery arrives, staff use **Record received stock**
on the plan, which fills the existing restock form (medicine and planned quantity, to be confirmed) and records the restock only when they press **Record restock**.
Nothing in the planning code reads or writes `inventory`, `inventory_movements`, `outbox`, `stock_alerts` or Redis (a test checks the source, and others snapshot stock, history and outbox around every plan operation).

## Data model

Table `restock_plans` in **each pharmacy's own database** (migration `packages/db/pharmacy-migrations/005_restock_plans.sql`, additive, no existing table or migration touched).
Plans therefore cannot belong to, or be reached from, another pharmacy: the pharmacy always comes from the signed-in session.

| Column | Notes |
|---|---|
| `plan_id` | UUID, the public id |
| `medicine_code` | `M001` form. No foreign key: a plan outlives a medicine the pharmacy stops listing. Creation checks the pharmacy currently lists it |
| `planned_quantity` | whole number, 1 to 1,000,000 |
| `status` | `PLANNED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED` |
| `target_date` | a calendar day (`YYYY-MM-DD`), no time zone |
| `notes` | optional, trimmed, at most 500 characters |
| `created_by_user_id` | the staff account that made it (id only; the API says only whether it was you) |
| `created_at`, `updated_at` | every change moves `updated_at` |
| `completed_at` | set exactly while the status is COMPLETED (a `CHECK` guarantees it, so reopening cannot leave a stale one) |

**One open plan per medicine.** A unique index allows at most one PLANNED or IN_PROGRESS plan per medicine. That stops a double click, or a plan started twice from the same alert, from creating duplicates,
and holds under concurrent requests. Completed and cancelled plans do not count, so a medicine can be planned again once the earlier plan is closed.
There is **no audit trail**: a reschedule overwrites the date and moves `updated_at`; the previous date is not kept.

## Lifecycle

```
PLANNED ──► IN_PROGRESS ──► COMPLETED ──► (reopen) IN_PROGRESS
   │  ▲          │  │
   │  └──────────┘  └──────────────────────► CANCELLED   (final)
   └──────────────────────────────────────► COMPLETED / CANCELLED
```

| From | To |
|---|---|
| PLANNED | IN_PROGRESS, COMPLETED, CANCELLED |
| IN_PROGRESS | PLANNED, COMPLETED, CANCELLED |
| COMPLETED | IN_PROGRESS (reopen; clears `completed_at`) |
| CANCELLED | nothing: it is final, make a new plan |

- Changes are checked on the server under a row lock. Two changes at once are applied one after the other, and the second is checked against what the first left.
- A move that is not in the table, or to the current status, is `409 INVALID_TRANSITION`. Reopening while another plan for the medicine is open is `409 PLAN_ALREADY_OPEN`.
- **Quantity, target date (reschedule) and notes** can be changed only while the plan is open (or in the same change that reopens it). On a completed or cancelled plan, or together with completing or cancelling: `409 PLAN_CLOSED`.
- The medicine, the pharmacy, the creator and the timestamps cannot be changed. A request that names them is refused (`400`), never silently ignored.
- Target dates are real calendar days from yesterday (UTC; a person east of Greenwich can already be a day ahead) to two years ahead. Nothing is converted or defaulted: anything else is refused.

## API

All need the portal session cookie (`401` without it) and are about the signed-in pharmacy only. A `pharmacyCode` in a body is refused; in a query string it is ignored. Responses use the portal's `{ data, meta }` envelope and error shape.

| Endpoint | |
|---|---|
| `POST /portal/restock-plans` `{ medicineCode, quantity, targetDate, notes? }` | `201` with the plan. `404 NOT_STOCKED` (the pharmacy does not list the medicine), `409 PLAN_ALREADY_OPEN` (`error.details.planId` is the open plan), `400` for anything invalid |
| `GET /portal/restock-plans?status=&limit=&offset=` | `status`: `PLANNED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, `OPEN` (planned or in progress) or `ALL` (default). `limit` 1–100 (default 20). Soonest target date first, then oldest first. `meta`: `total`, `limit`, `offset`, `hasMore`, `status` |
| `GET /portal/restock-plans/:id` | one plan; `404 PLAN_NOT_FOUND` for an unknown id **or another pharmacy's** |
| `PATCH /portal/restock-plans/:id` `{ status?, quantity?, targetDate?, notes? }` | at least one field; `notes: null` clears them |
| `GET /portal/restock-plans/export.csv?status=` | the CSV download (below) |

A plan: `planId`, `pharmacyCode`, `medicineCode`, `medicineName`, `plannedQuantity`, `status`, `targetDate`, `notes`, `createdAt`, `updatedAt`, `completedAt`, `byYou`, `currentQuantity` (the shelf now, for context; planning never changes it).

Alerts (`GET /portal/alerts`) also carry `restockPlan: { planId, status, targetDate } | null`: the **open** plan for an active alert's medicine. It is looked up, never created: reading alerts or risk scores makes no plan.
If a pharmacy database has not had migration `005` yet, the plan routes answer `503 PHARMACY_SCHEMA_OUTDATED` and alerts keep working without plans.

## CSV export

`GET /portal/restock-plans/export.csv` returns `200`, `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="restock-plans-P001-open-2026-11-01.csv"`,
`X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. The filename is built only from the pharmacy code, the status filter and the date, never from anything in the request.

Columns, always written, in this order: `plan_id, medicine_code, medicine_name, planned_quantity, status, target_date, created_at, updated_at, completed_at, notes`.
Timestamps are ISO 8601 (UTC), `target_date` is `YYYY-MM-DD`, `completed_at` is empty unless completed. Rows are in the list order (target date, then oldest first). No staff identity, credentials, patient data or other pharmacy's details.

- RFC 4180: CRLF row ends; a field with a comma, quote or line break is quoted with quotes doubled. An export with no plans is a valid file with just the header.
- **Formula-injection protection.** A spreadsheet runs a cell as a formula when its text starts with `=`, `+`, `-` or `@` (or a tab or carriage return). Every text cell that starts with one of those characters is prefixed with a single quote
  (`=1+1` becomes `'=1+1`), so Excel, Sheets and LibreOffice show it as text. The rest of the value is unchanged. Staff-typed notes and catalogue names are the cells this protects. Unusual numbers (for example a negative one) are treated as text and protected too.
- At most **10,000** plans per file; `X-Export-Truncated: true` says when some were left out (narrow the filter).
- No BOM is written, so Excel may need "import as UTF-8" for non-English notes.

No CSV library was added (the repository had none); the writer is `packages/pharmacy-ops/src/csv.ts` with its own tests, including a read-back check.

## In the portal

- **Restock planning** panel (below the low-stock alerts): a **New plan** form (medicine from this pharmacy's own list, units to order, target date, optional notes), filters **Open / Completed / Cancelled / All**, the plan list (10 per page, Earlier / Later),
  and **Export CSV** (the filter on screen, a real download). Each plan shows its status in words, the target date (with "Overdue" in words for an open plan past its date), the stock now and when it was last updated.
- Actions follow the lifecycle: **Start**, **Back to planned**, **Complete**, **Reopen**, **Reschedule**, **Edit**, **Cancel plan** (with a confirmation: it is final), and **Record received stock**, which hands the medicine and planned quantity to the restock form.
- **From a low-stock alert:** an alert has **Plan restock**, which opens the form for that medicine with the alert's risk badge, explanation, stock and threshold beside it and a **starting** target date (tomorrow for CRITICAL, 3 days for HIGH, a week otherwise: only a starting value, editable).
  The quantity is **left blank**: MedLink has no sales history to base a number on, so the person decides. If the medicine already has an open plan the alert shows its status and date and a **View plan** button instead.

## Setup and demo

```bash
npm run pharmacies:migrate     # once, after pulling this change: adds migration 005 to every pharmacy database (never seeds or changes stock)
npm run dev:all
```

1. Sign in to the portal. Record a sale that takes a medicine to the low-stock threshold: an alert appears.
2. **Plan restock** on the alert, enter a quantity, save. The alert now shows the plan. Stock is unchanged.
3. **Start**, then **Reschedule** to a later date, then **Complete**. Stock is still unchanged.
4. **Record received stock** fills the restock form with the planned quantity; press **Record restock**. Now stock rises and the movement history shows it.
5. **Export CSV** downloads the plans.

Tests:

```bash
npx vitest run packages/pharmacy-ops/test/csv.test.ts packages/pharmacy-ops/test/restock-plans.test.ts apps/pharmacy-portal/test/restock-plans.test.ts apps/web/src/components/portal
```

## Known limitations

- No audit trail or reschedule history; no supplier field, orders, reminders or notifications to anyone.
- One open plan per medicine; to order the same medicine twice at once, finish or cancel the first plan.
- A plan is not linked to the restock that fulfils it: staff record the restock themselves, and the plan keeps whatever status they gave it.
- Target dates are calendar days checked against UTC (with a day's tolerance), not the pharmacy's local time.
- Plans exist only in pharmacy databases that have had migration `005`.
