# Demo walkthrough

About two minutes. Everything runs locally; the data is simulated demo data (five pharmacies, P001 to P005), not real
stock. The sign-in `p00N@pharmacy.test` accounts are development fixtures.

## Before you start

```
npm run infra:up
npm run services:status        # all services should report up
```

If the stack is not running, start it with `EMAIL_DELIVERY_ENABLED=false npm run dev:all` so no email is sent.
Open `http://localhost:3000`.

## Script

1. **The idea (15 s).** MedLink helps people find which nearby pharmacy has a medicine. It does not sell anything.
   Each pharmacy keeps its own database.
2. **Search (20 s).** Search for a medicine. Point at the match percentage and the reasons, and at a rejected result
   with its reason.
3. **Nodes (15 s).** Open `/dashboard`. Five independent pharmacy nodes, with their sync status.
4. **Change at a pharmacy (40 s).** In a second tab open `/portal`, sign in as `p001@pharmacy.test` (password from
   `portal:seed-users`; see [pharmacy-portal.md](pharmacy-portal.md)). Record a sale of the medicine you searched. The
   header shows which pharmacy you manage. Return to the search tab: the stock changes within a few seconds.
   Say "eventually consistent", not "instant".
5. **Why it is safe (15 s).** The portal wrote to the pharmacy's own database. The outbox, connector, Redis Stream and
   sync service carried it. Show the movement history and the risk and alert panel.
6. **Admin (15 s, optional).** Sign in as an administrator: the screen only manages access requests.

## Simulated or live

| Part | Nature |
| --- | --- |
| Pharmacies, stock, medicines | Simulated demo data |
| The sync pipeline, search, SSE, portal | Live, running locally |
| Email | Off |
| Latency numbers | Measured on one machine ([verification.md](verification.md)) |

## Fallback if something fails

The fallback does not depend on timing:

- **Stream does not update:** reload the search page; the change is in the result once the connector has run. Check
  `npm run services:status`.
- **A service is down:** restart only that one (`npm run connector:start`, `npm run sync:start`). Events wait in the
  pharmacy outbox and are caught up, so nothing is lost. Explain this; it is the design.
- **Redis is down:** search falls back to the central PostgreSQL mirror.
- **Nothing works:** walk through [architecture.md](architecture.md) and the test results in
  [verification.md](verification.md) instead.

## Safe data

Use only the seeded pharmacies and synthetic accounts. If you change stock, record a restock of the same amount
afterwards. Do **not** run `pharmacies:setup` or `pharmacies:reset` during a demo: they reseed stock.
