# Restock notifications (milestone 11)

A user who finds a medicine out of stock can ask to be told when it is back. When a pharmacy restocks it, the user gets
a **simulated** notification.

```mermaid
flowchart LR
  U([User]) -->|"POST /api/restock-subscriptions"| API[search-service]
  API --> DB[("Postgres<br/>restock_subscriptions")]
  P[("Pharmacy DB")] -->|"RESTOCK via outbox + connector"| S[("Redis stream<br/>per pharmacy")]
  S -->|"group restock-notifier"| N[notification-service]
  S -->|"group inventory-sync"| I[inventory-sync]
  N -->|"one statement: subscriptions -> NOTIFIED + notifications"| DB
  N -->|"send"| M["Notifier (mock: log)"]
  U -->|"GET /api/notifications"| API
```

## What happens

1. **Subscribe.** The web app offers "Notify me when it's back" for a medicine that is out of stock at every pharmacy
   in the results. `POST /api/restock-subscriptions {email, medicineId}` stores it as `ACTIVE`.
2. **Detect.** `notification-service` reads the same per-pharmacy streams as `inventory-sync`, through its own consumer
   group (`restock-notifier`), so each service gets every event and neither slows the other. `detectRestock` accepts a
   `RESTOCK` event that leaves stock (`quantityAfter > 0`). Sales, price changes, additions and removals are ignored.
3. **Fulfil.** One SQL statement turns every `ACTIVE` subscription for that medicine into `NOTIFIED` and stores one
   `notifications` row for it. Atomic: a subscription is either still waiting, or notified with its notification stored.
4. **Send.** The stored notification is handed to a `Notifier`. The mock one writes
   `[mock notification] Crocin 500mg is back in stock at Pharmacy A (15 available).` to the log and the row gets
   `delivered_at`. The user also sees it through `GET /api/notifications?email=` (the web app polls it).

## Guarantees

| Situation | Result |
|---|---|
| The same restock event is delivered twice (connector crash, retry, two instances at once) | Notified once. Only `ACTIVE` subscriptions are taken and the row is locked while it is flipped; `notifications.subscription_id` is `UNIQUE` as a last line of defence. Tested with six concurrent callers. |
| An old restock is replayed after the user subscribed (stream backlog, service down, a new consumer group reads from the start) | Not notified. Only subscriptions created at or before the event's time are fulfilled, so nobody is told about a restock that happened before they asked (the shelf may be empty again). They keep waiting for the next one. |
| The notification channel is down | The notification stays stored with `delivered_at IS NULL` and the event is **not** retried (nothing is left to fulfil). A sweep every `NOTIFY_SWEEP_INTERVAL_MS`, and one at startup, sends what is pending. |
| Crash after storing, before sending | Same: the sweep sends it after the restart. |
| Crash after sending, before `delivered_at` is saved | Sent again. Delivery is **at-least-once**; harmless for the mock, a real channel would need its own idempotency key (the notification id). |
| Several notification-service instances | Fine: events are shared by the consumer group, and sending locks rows with `FOR UPDATE SKIP LOCKED`, so none is sent twice. |
| The database is down while handling a restock | The event is left unacknowledged and retried, then dead-lettered after `NOTIFY_MAX_DELIVERIES` attempts. Retrying is safe (see the first row). |
| User subscribes twice while waiting | One subscription (`200`, same id). After it was fulfilled or cancelled, asking again creates a new one. |
| User cancels | `DELETE /api/restock-subscriptions/:id?email=`. A cancelled subscription is never notified. |

## API

| Request | Result |
|---|---|
| `POST /api/restock-subscriptions` `{email, medicineId}` | `201` new, `200` already waiting, `404` unknown medicine, `400` bad input. |
| `GET /api/restock-subscriptions?email=` | The user's subscriptions, newest first. |
| `DELETE /api/restock-subscriptions/:id?email=` | Cancels a waiting one. `404` if it is unknown, not theirs, or no longer waiting (same answer, so ids cannot be probed). |
| `GET /api/notifications?email=&limit=` | The user's notifications, newest first (default 20, at most 100). |

## Running it

```
npm run db:migrate        # adds restock_subscriptions and notifications (migration 003)
npm run notify:start      # the notification service (needs DATABASE_URL and Redis, see .env.example)
```

It runs next to `connector:start` and `sync:start` and works against a single Redis or the cluster
(`REDIS_MODE=cluster`, see `docs/redis-streams.md`).

## Email delivery (off by default)

The notification is always stored and shown in the app. In addition, when `EMAIL_DELIVERY_ENABLED=true` and `SMTP_USER` / `SMTP_PASS` (a Gmail App Password) are set for the notification service, it is sent as an email through Gmail SMTP (Nodemailer): `src/config.ts`, `src/mailer.ts`, `src/email-template.ts`, `EmailNotifier` in `src/notifier.ts`. Set the credentials in the git-ignored root `.env`, or in `apps/notification-service/.env.local`; never in code, in `.env.example` or in the web app (a test fails if the web source mentions them).

* `delivered_at` is set only after the SMTP server accepted the message. Off: the simulated notifier runs and no email is sent. Enabled but incomplete: nothing is sent and the alert stays pending, with the missing setting names logged.
* Each pending notification is sent and committed on its own, so a crash repeats at most one. A failed send backs off in memory (30 s, doubling to 1 h) and the notifier never re-sends one it already got accepted. Delivery is still at-least-once.
* The email shows the pharmacy as MedLink presents it, with the demo label, "Inventory shown is simulated…" and "Location not verified" where they apply, plus the stock disclaimer.
* SMTP acceptance is not inbox delivery. `npm run notify:test-email -- --to=you@example.com [--send]` is the one-off check (dry run unless `--send`).

See [development.md](development.md) for starting everything (`npm run dev:all`), checking it (`npm run services:status`) and diagnosing a missing email.

### Trying it through the website

1. Services running (you start them): API (`api:dev`), web (`web:dev`), portal (`portal:dev`), `connector:start`, `sync:start`, and `notify:start` with email enabled (its log says "email delivery is enabled").
2. Open `/pharmacies`, open **Bandra Medical Stores** (P004). Crocin 500mg is out of stock there in the starting data; press **Notify me** on that row, enter an address you control, submit. The page says you're on the list; `/notifications` shows what you are waiting for.
3. Open `/portal`, sign in as that pharmacy's staff account (`p004@pharmacy.test`, development password in the portal doc), find Crocin 500mg and set the quantity above 0.
4. Within a few seconds the notification appears under `/notifications` and the email arrives. A subscription is for the medicine at any pharmacy, so a restock anywhere would trigger it.

## Decisions and limits

* **Identity is an email.** There is no sign-in, so the email in the request *is* the user: it is created in `users`
  on first use, and anyone who knows an address can read or cancel its subscriptions. Fine for simulated
  notifications; real delivery needs real authentication first.
* **A subscription is for a medicine, not for a pharmacy.** Any pharmacy's restock fulfils it. The message names the
  pharmacy and the quantity.
* **The API does not check that the medicine is really out of stock.** The web app only offers the button when it is.
  Checking in the API would need one trusted source of "available", see the next point.
* **The notification comes from the pharmacy's own event, not from the search data.** Search now overlays live stock
  from the same events (see `docs/frontend.md`), so after a restock the results and the notification agree within a
  second or two. If live stock is unavailable, search falls back to the central database, which events do not update,
  and says so on screen.
* **The event's time is the pharmacy's clock** and is compared with the subscription's creation time in the central
  database. A pharmacy whose clock runs far behind could miss a subscriber made in that gap; they are notified at the
  next restock.
* **`MEDICINE_ADDED` with stock** (a medicine newly listed) is not treated as a restock. Adding it to `detectRestock`
  is a one-line change if it should notify.
* **A restock is reported as it happened.** If it sells out again before the notification is sent (a long outage),
  the user is still told it was restocked.

## Tests

* `apps/notification-service/test`: detector, the SQL (exactly-once, concurrency, old events, delivery sweep) and the
  service on real Redis streams (second consumer group, duplicate events, backlog replay, a channel that is down).
* `apps/search-service/test/notifications.test.ts`: the API.
* `tests/restock-notifications.test.ts`: the acceptance path with nothing mocked between the stages: subscribe over
  HTTP, restock in the pharmacy database, connector, Redis stream, notification service, read the notification over HTTP.
* `apps/web/src/lib`: the client calls and the "which medicines to offer" rule.
