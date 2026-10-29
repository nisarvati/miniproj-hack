# Personal medicine calendar

A signed-in patient can keep a private calendar of medicines: ones they **want to get**, have **ordered**, have **purchased**, or want a **reminder** about. It is the person's own notebook. MedLink is not a pharmacy: `ORDERED` and `PURCHASED` are notes the person wrote, not orders or purchases that MedLink placed, processed or verified, and nothing in the calendar says a medicine is available anywhere. It sends no email or SMS (it has nothing to do with the restock notification service), and it never touches inventory, Redis or the sync pipeline.

## How a request travels

```
signed-in person → /calendar (Next.js page, session checked on the server)
  → fetch /calendar-api/entries…            (same origin, cookie, never cached)
  → Next.js route handler                    apps/web/src/app/calendar-api/**/route.ts
  → createCalendarApi (server/calendar/api)  1 verified Auth.js session? → 401
                                             2 database configured?       → 503
                                             3 same-site JSON request when it changes data → 403 / 415
                                             4 validate body / query      → 400
  → resolvePatientId                          Google account id → patients row (created once)
  → repository (server/calendar/repo)         every statement scoped to that patient
  → central PostgreSQL                        medicine_calendar_entries
  → { data } JSON → the page re-fetches and shows what the server returned
```

The web app talks to PostgreSQL itself for this feature (a small pool in `apps/web/src/server/db.ts`). It is deliberately **not** under `/api`: in development `/api/*` is proxied to the search service, which knows nothing about Auth.js sessions. The search service, the inventory pipeline and the pharmacy portal are unchanged.

## Who is who

- Identity is Google's own stable account identifier (the OpenID `sub`, kept at sign-in as `googleId` from `account.providerAccountId`; the token's own `sub` is a random per-sign-in id and is never used), taken from the **verified session** on the server (`getPatientIdentity` in `apps/web/src/auth.ts`). Nothing in a request says who the caller is: a `userId` or `patientId` in a body or query string is never read.
- `patients` is keyed by `(provider, provider_subject)`, **never by email**. Two Google accounts with the same email are two patients. The row is created on first use with an upsert on that unique key, so simultaneous first requests make one row.
- `patients` is separate from the older `users` table, which is keyed by an email anyone can type (it is how restock alerts work without sign-in). They are deliberately not linked: doing so on an unverified email would let one person read another's data. Linking Google sign-in to restock alerts remains a separate decision.
- Ownership is enforced **in the SQL**: reads, updates and deletes all say `WHERE id = $1 AND patient_id = $2`, in the one statement that does the work. Someone else's entry is simply "not found" (404), whether it exists or not.

## Schema (migration `006_patient_calendar.sql`)

Creates two tables and two indexes; it changes nothing that exists.

| Table | Purpose |
|---|---|
| `patients` | one row per Google account: `id`, `provider` (`google`), `provider_subject`, display `email`/`name`, `created_at`. `UNIQUE (provider, provider_subject)` |
| `medicine_calendar_entries` | `id` (UUID, not guessable), `patient_id` → `patients` (cascade), `medicine_id` → `medicines` (nullable, `ON DELETE SET NULL`), `medicine_name`, `entry_type` (`WANT_TO_GET`/`ORDERED`/`PURCHASED`/`REMINDER`), `entry_date` (`DATE`), `notes` (≤ 1000), `status` (`OPEN`/`DONE`), `completed_at` (set exactly when `DONE`), `created_at`, `updated_at` |

Indexes: `(patient_id, entry_date, created_at, id)` serves "my entries between two dates", the only way the calendar reads; a partial index on `medicine_id` serves the foreign key.

**Dates** are stored as a plain calendar `DATE`, exactly as the person picked it in their own calendar. There is no instant to convert, so the server's and the browser's timezones cannot move an entry to another day. ("Today" is read from the person's own clock in the browser.)

**Catalogue medicines.** If a request carries `medicineId`, the server checks it against `medicines` and saves the name from the catalogue; a name sent alongside is ignored. Without `medicineId` the person's own text is kept. If a catalogue medicine is later removed, the entry keeps its name.

## Applying the migration

It is **not** applied automatically. With Postgres running (`npm run db:up`) and `DATABASE_URL` set in the root `.env`:

```
npm run db:migrate
```

It applies only pending files (here, 006) in one transaction and records it in `schema_migrations`; running it again does nothing. Then add the same `DATABASE_URL` to **`apps/web/.env.local`** (the web app reads that file, not the root `.env`) and restart the web app. Without it the calendar says "not set up on this server yet" (HTTP 503) instead of failing obscurely. Google sign-in must also be configured (see `authentication.md`).

## API

All under `/calendar-api`, JSON, private (`Cache-Control: private, no-store`, `Vary: Cookie`). Success: `{ "data": … }`; failure: `{ "error": { "code", "message", "details"? } }`. No database error text is ever returned.

| Method and path | Does | Success |
|---|---|---|
| `GET /entries?from=YYYY-MM-DD&to=YYYY-MM-DD[&limit=n]` | my entries in the range, oldest first | 200 (`meta`: `from`, `to`, `count`, `truncated`) |
| `POST /entries` | create | 201 |
| `GET /entries/:id` | one of mine | 200 |
| `PATCH /entries/:id` | change any of `medicineId`, `medicineName`, `type`, `date`, `notes`, `status` (`DONE` completes, `OPEN` reopens) | 200 |
| `DELETE /entries/:id` | delete | 204 |

Statuses: `401` no verified session, `400` invalid input (with per-field `details`), `403` a data-changing request a browser says is from another site, `404` not found or not yours (also for a malformed id), `409` the per-person limit (2000 entries) is reached, `413` body over 16 KB, `415` not `application/json`, `503` database missing or unreachable, `500` anything unexpected (generic message; the server logs only the error's own message, never a request body).

Rules: `type` is one of the four; `date` is a real calendar day from 2000-01-01 to 2100-12-31 (so `2026-02-30` is rejected, not rolled over); `medicineName` 1 to 200 characters when there is no `medicineId`; `notes` at most 1000; `from` and `to` are required, `to` not before `from`, and at most 372 days apart; `limit` 1 to 1000.

## The screens

- `/calendar` (needs a session, else redirects to `/signin?callbackUrl=%2Fcalendar`) is a full-window page with no sidebar. It uses the **same header as every other page** (`components/shell/AppHeader.tsx`, drawn by `AppShell`): MedLink (home), Search, Pharmacies, Notifications, Calendar (the current one underlined), the location control, the account (picture, links to `/account`) and Sign out (the existing server sign-out action, which ends the session and shows `/signin`; it deletes nothing). The header is exactly the same container as on every other page (same width, margins and height, so everything lines up); only the month below it is full width. The phone tab bar is shown too, so every destination is reachable on a phone. There is no footer. Below the header there is a toolbar (title, month, previous/next, Today, Add medicine) and the month grid, which takes all the rest of the width and height.
  - **Viewport:** from 48rem wide and 34rem tall the page is exactly the window and the six week rows share the height equally (seven equal columns); nothing scrolls. Below that (a phone, a very short window) the page scrolls and each week keeps at least 4.5rem. The paper texture comes from the app theme.
  - **Month grid:** today is a filled ring, the chosen day has a deeper outline, adjacent-month days are muted. Entries show as chips (type icon, name; done is struck through and ticked) with a "+N more" line when a day has more than fit. On a phone, where names would not be readable, a day shows a count instead. Arrow keys move between days; Enter or a click opens the day.
  - **Day dialog:** opening a day shows its entries in a dialog (count from what the server returned, type and status in words, mark done / reopen / edit / delete with confirmation, "Add to this day"). Add and edit use the one form, in the same dialog; Cancel returns to the day it came from. Focus stays inside, Escape or a click outside closes it (except during a save).
  - **Greens:** every entry is green, in one of six shades (`.shade0`…`.shade5`, mixes of the theme's `--brand`, `--live` and `--ok` with the paper colour). The shade is `FNV-1a(entry id) mod 6` (`shadeOf` in `entry-visuals.tsx`), so it is the same for an entry in every render, month, reload and view, and does not depend on order. It carries no meaning: the kind of entry (Want to get / Ordered / Purchased / Reminder) is its icon and its words, and Done is a tick and a strikethrough.
  - Everything is loaded from the API for the visible weeks and re-fetched after every change; nothing is kept in the browser. Success messages appear only after the server confirms. A failed save keeps what was typed and says what went wrong. If the session ends, the entries leave the screen and sign-in is offered.
- **Add to calendar** on each search result (signed in) saves that catalogue medicine with its id. Signed out it offers sign-in and returns to the search; with sign-in not set up it is not shown.
- The header and bottom navigation show **Calendar** only to a signed-in patient. That is a courtesy: the page and the API check the session themselves.

## Tests

- `apps/web/src/server/calendar/calendar.test.ts`: the migration, identity (including 25 simultaneous first sign-ins and the same email under two Google accounts), every endpoint against a real PostgreSQL (`<db>_test`), validation, authorization, cross-user isolation, timezone-proof dates, the entry limit, and failure handling.
- `apps/web/src/server/calendar/persistence.test.ts`: whole sessions with made-up Google accounts: each sign-in is a new session cookie read back through Auth.js's own session route, then the calendar API and the isolated test database. Entries survive sign-out and a new sign-in unchanged; an expired or forged session reads nothing and deletes nothing; another account (or the same email under another Google account) sees and changes nothing; a changed email or name on the same Google account is still the same calendar; concurrent first sign-ins make one patient.
- `apps/web/src/components/calendar/calendar-integration.test.tsx`: the screens driving the real API handlers and the real test database (add, reload, edit, complete, delete, failures, double submission, session end, other users).
- `apps/web/src/components/calendar/calendar-layout.test.ts`: the stylesheet rules the responsive layout depends on (jsdom runs no CSS, so layout itself was checked in a real browser, see below), and `entry-visuals.test.ts` (the shade function and the six greens).
- `apps/web/src/auth-server.test.ts`: a genuine signed session cookie yields the Google account id, and the real route files answer 401 without a session.
- `apps/web/src/lib/calendar-boundaries.test.ts`: the server layer is never imported by client code, nothing is stored in the browser, every change is scoped to its owner, and the calendar never touches the restock pipeline.

Layout was checked by driving headless Chrome against a production build on a spare port at 1536x864, 1440x900, 1280x720, 1280x600, 1024x768, 820x1180, 768x1024, 390x844 and 360x640 : no page-level scrolling at desktop and tablet sizes, no horizontal overflow at any size (a 360x640 phone scrolls vertically, as designed). In that check the browser stood in for the calendar API with in-memory data (no database), so it verified layout and interaction, not persistence; persistence is what the integration tests above prove against PostgreSQL.

What the tests do **not** cover: Next.js routing and the real Auth.js cookie in a browser, and a real Google sign-in. Check those by hand (see the checklist in the change report).

## Theme

The calendar sits inside the app theme (`.app-theme`): warm paper for the page, cells and dialogs, ink for text, forest green for accents and the six entry shades. No calendar file sets a white background (a test guards this), dropdown lists are themed in `app-theme.css`, and the browser's own date-picker popup, which the page cannot style, is drawn light, because the document declares a light colour scheme.

## Limits

The month view asks for six weeks at a time (at most 42 days); entries are capped at 2000 per person. There is no recurring entry, sharing, or export. Deleting a Google account at Google does not delete its MedLink calendar; there is no in-app account deletion yet.
