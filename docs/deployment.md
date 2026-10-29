# Setup and deployment

## Fresh setup (development)

Requirements: Node 22, npm, Docker.

```
npm ci
cp .env.example .env            # then set POSTGRES_PASSWORD and the other required values
npm run infra:up                # Postgres (5433) and Redis (6379) in Docker
npm run db:migrate              # central database migrations
npm run db:seed                 # central catalogue and pharmacies
npm run pharmacies:setup        # creates and seeds the five pharmacy databases
npm run portal:seed-users       # p001@pharmacy.test ... p005@pharmacy.test
npm run db:catalogue            # optional: import the larger catalogue
npm run dev:all                 # starts every service
```

Warning: `pharmacies:setup` and `pharmacies:reset` **reseed stock**. Use them on a fresh machine only.

## Existing environments

Apply only what is pending, which is safe on live data:

```
npm run db:migrate              # central (001 to 007)
npm run pharmacies:migrate      # the five pharmacy databases (001 to 005)
```

Order: central migrations first, then pharmacy migrations, then restart services. Migration 007 adds `role` to
`pharmacy_users`; existing accounts become `STAFF`. Already-applied migrations are never edited.

Create an administrator (never promotes an existing account):

```
PORTAL_ADMIN_PASSWORD='at-least-12-chars' npm run portal:users -- create-admin admin@example.org
```

## Ports

| Service | Port |
| --- | --- |
| Web | 3000 |
| Search API | 4000 |
| Pharmacy portal | 4200 |
| Inventory connector | 4301 |
| Inventory sync | 4302 |
| Notification service | 4303 |
| Postgres / Redis | 5433 / 6379 |

Check with `npm run services:status`. Each service exposes a health endpoint.

## Outside localhost

- Set `PORTAL_SESSION_SECRET` to a long random value. The portal refuses to start on a non-loopback `HOST` with the
  built-in development secret, and requires it when `NODE_ENV=production`.
- Serve over HTTPS (the session cookie is then `Secure`).
- Do not use `PORTAL_DEV_PASSWORD` or the seeded accounts.
- Set `CORS_ORIGINS` to the real web origin.

## Not provided

Be clear about what is **not** here:

- `docker-compose.yml` runs infrastructure only (Postgres, Redis, optional Redis Cluster). There are no Dockerfiles or
  containers for the applications; they run with `tsx` and `next`. A Dockerfile was deliberately not added because it
  could not be verified here.
- No CI pipeline.
- Redis Cluster tests (`npm run cluster:up`, `npm run test:cluster`) exist but were not run for this milestone.
- No backup, monitoring or high-availability configuration.
