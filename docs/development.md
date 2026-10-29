# Running MedLink locally

## Prerequisites

* Node.js 22 and `npm install` at the repo root.
* Docker, for PostgreSQL and Redis: `npm run infra:up` (starts both if they are not running; a no-op for containers that are).
* `.env` copied from `.env.example` (never commit it), then once: `npm run db:migrate && npm run db:seed && npm run pharmacies:setup`.

## Start everything: `npm run dev:all`

Starts the web app (:3000), search API (:4000), pharmacy portal (:4200), inventory connector, inventory-sync and notification service from the existing workspace scripts, every log line prefixed with its service (`[connector]`, `[notify]`, ...).

* It never kills, restarts or replaces anything already running. A service is **skipped, with a message**, if its port is taken, its health endpoint already answers, or a process for it already exists.
* It does not start PostgreSQL/Redis unless you add `--infra`; if they are unreachable it stops and says so.
* `npm run dev:all -- --check` only prints what it would start. `-- --skip=web,portal` leaves services out.
* Ctrl+C stops **only the processes this command started** (each in its own process group). If a service exits on its own, the others are stopped and the exit code is propagated.
* It does not turn email on. The notification service reads `EMAIL_DELIVERY_ENABLED` itself and logs its mode.

## Check what is running: `npm run services:status`

Reports each component and what the check actually proved. It only reads: it starts, stops and writes nothing, and prints no connection string, credential or email address. Exit code 1 if something needed is not running, unreachable or degraded.

| State | Meaning |
|---|---|
| ✓ healthy | it answered a check that exercises what it depends on (Search API health, a background service's `/health` with `ready: true`, Redis `PING`) |
| • running | it answers, but that does not prove readiness (the web app answers HTTP; the portal's health route does not check its databases; PostgreSQL accepted a TCP connection) |
| ! degraded | it answers but reports a failing dependency, with a hint |
| ✗ not running / unreachable | nothing listening / no usable reply |
| ? unknown | a process exists but has no health endpoint (an older build), or the process list could not be read |

The connector, sync and notification service each serve `GET /health` on `127.0.0.1` (4301, 4302, 4303; override with `HEALTH_PORT_CONNECTOR`, `HEALTH_PORT_SYNC`, `HEALTH_PORT_NOTIFY`, or `off`). It reports three separate things: the process answered, whether Redis / PostgreSQL / each pharmacy database answered a bounded probe (read-only), and `ready`. Extra details: the connector's count of events still waiting in each pharmacy outbox, the notification service's email mode (`disabled`, `enabled` or `unconfigured`, setting names only) and its count of notifications waiting to be sent. A service started before this existed has no endpoint until you restart it.

Limits: the web app and portal checks prove only that they answer; Redis in cluster mode is checked on its first node only; the checks say nothing about the quality of the data.

## Running one service while debugging

`npm run web:dev`, `api:dev`, `portal:dev`, `connector:start`, `sync:start`, `notify:start`. Each logs what it is, its configuration state (never secrets), and a one-line "ready" or "cannot reach X" verdict at startup.

## The restock email workflow, and why stock updates alone send nothing

Updating stock does not itself send an email. All of these must be true:

1. A **waiting subscription** exists (website "Notify me", `POST /api/restock-subscriptions`).
2. The stock change is a **RESTOCK**: quantity went **up** (a lower quantity is a SALE; the same quantity or a price change is not a restock).
3. The pharmacy's **outbox row was published**: the **connector** must be running.
4. The **notification service** must be running, consuming that stream.
5. The subscription was created **before** the event, and is for **that medicine** (any pharmacy).
6. **Delivery** is configured: `EMAIL_DELIVERY_ENABLED=true` with `SMTP_USER` and `SMTP_PASS` (a Gmail App Password), set in the git-ignored `.env` or `apps/notification-service/.env.local`. Otherwise the alert is in-app only (disabled) or stays pending (unconfigured).

## Diagnosing a missing email (read-only checks)

| Symptom | Check | Meaning |
|---|---|---|
| Nothing at all | `npm run services:status` | a required service is not running |
| Subscription never saved | `docker exec medlink-postgres-1 psql -U medlink -d medlink -c "SELECT s.id,s.status,s.created_at,m.code FROM restock_subscriptions s JOIN medicines m ON m.id=s.medicine_id ORDER BY s.id DESC LIMIT 5"` | no row |
| Event never published | `... -d pharmacy_p004 -c "SELECT id,event_type,medicine_code,occurred_at,published_at FROM outbox ORDER BY id DESC LIMIT 5"` | `published_at` empty = connector not running or failing; no RESTOCK row = the change was not a restock |
| Event not consumed | `docker exec medlink-redis-1 redis-cli XINFO GROUPS "medlink:events:{P004}"` | no `restock-notifier` group, or high lag/pending = notification service not consuming |
| No notification row | `... -d medlink -c "SELECT id,subscription_id,created_at,delivered_at FROM notifications ORDER BY id DESC LIMIT 5"` | none = no matching waiting subscription (wrong medicine, or created after the event) |
| Pending notification | same query | `delivered_at` empty = not sent yet: email failed or is unconfigured (the notification service log says which, by setting name) |
| Failed email | notification service log: `email was not sent` with attempt and retry time | SMTP error; it retries with back-off (30 s doubling to 1 h) and never twice for one accepted message |
| "Delivered" but no email | `services:status` shows `email delivery: disabled` | the simulated notifier marks alerts delivered without sending |

## Tests

* `npm test` runs everything. The pure and mocked tests (`packages/*/test`, `apps/web`, `apps/notification-service/test/{email,test-send,notifier,restock,restock-email-flow}.test.ts`, `tests/dev-tooling.test.ts`) need no infrastructure.
* The database tests use **isolated** resources only: the `<DATABASE_URL database>_test` databases (created on demand; the schema reset can never touch development data) and a random `test-xxxxxxxx` Redis key prefix that no running service reads. They never contact a mail server: `tests/restock-email-pipeline.test.ts` drives subscribe, portal change, outbox, connector, stream, notification service and the real `EmailNotifier` into a **fake SMTP transport**.
* That test runs the connector and notification service **in the test process**, so it cannot detect a service that was never started. It includes "service missing" cases (no connector: the event stays unpublished in the outbox; no notification service: it waits in the stream) and recovery. For a running system use `npm run services:status`.
* `npm run test:cluster` runs the suite against the Redis Cluster profile.

## Trying real Gmail delivery (controlled, manual)

1. Put `SMTP_USER` and `SMTP_PASS` (App Password) in your own `.env` / `.env.local`; never in code, chat or `.env.example`.
2. One message to an address you control: `npm run notify:test-email -- --to=you@example.com` (dry run), then add `--send`. The result is SMTP acceptance, not inbox delivery.
3. For real alerts also set `EMAIL_DELIVERY_ENABLED=true` and restart the notification service, then follow the website steps in [restock-notifications.md](restock-notifications.md).

## Stopping

Ctrl+C in the `dev:all` terminal stops what it started. Services you started yourself are stopped in their own terminals. PostgreSQL and Redis keep running (`docker compose stop` if you want them down). Nothing here kills unrelated processes.
