# Live updates (`GET /api/stream`, Server-Sent Events)

The search API pushes stock changes and pharmacy-node status to open browsers. It is a convenience on top of the normal API, not a second
source of truth: MedLink stays eventually consistent, an event can arrive late or be missed, and **the JSON API is always the truth**
(every page keeps its Refresh button and reloads from the API after a reconnect). Nothing here claims delivery within any particular time.

## Endpoint

`GET /api/stream` on the search API (default `http://localhost:4000`, the same `NEXT_PUBLIC_API_URL` the web app uses).

- `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` (a reverse proxy must not buffer it), CORS like every `/api` route.
- **Authentication: none**, like the other `/api` routes. The stream carries the same public stock and node status as `/api/search` and
  `/api/nodes`: no credentials, no personal data, no sale sizes. A browser's `EventSource` cannot send headers, and nothing secret is put in the URL.
  A role-gated version belongs with the admin-role milestone.
- At most **100** concurrent streams (`HUB_DEFAULTS.maxClients`, `apps/search-service/src/modules/stream/hub.ts`). Beyond that: `503` with the normal JSON error `STREAM_FULL`.
- `Last-Event-ID` is supported (below). The first bytes are `retry: 3000` (the browser reconnects after 3 s).

## Events

Every `data:` is JSON with `"version": 1`. A client must ignore a version, event name or shape it does not know.

| Event | `id:` | When | `data` |
|---|---|---|---|
| `connected` | none | First thing on every connection | `{ version, bootId, resync, heartbeatMs, at }`. `resync: true`: the `Last-Event-ID` you sent could not be replayed, reload from the API. |
| `node` | on changes; none for the snapshot | Right after `connected` (the current state of every node, once), then whenever a node's reading changes | `{ version, node, meta }`. `node` is a `NodeStatusEntry` exactly as in `GET /api/nodes` ([node-status.md](node-status.md)); `meta` is `{ generatedAt, redis, connector, syncService }`. Unknown stays `null`; a Redis outage arrives as nodes with status `unknown`. A change in `syncLagMs` alone is **not** a change (it grows every second). |
| `stock` | yes | The sync service has finished a change published by a pharmacy | `{ version, eventId, pharmacyCode, medicineCode, eventType, quantity, price, occurredAt }`. `quantity` is the pharmacy's quantity after the change (`null` for a price update), `price` is `null` when the event has none. The size of a sale (`quantityDelta`) is deliberately not sent. |
| `heartbeat` | none | Every 15 s | `{ version, at }` |

`alert` is **not** emitted. The only existing alert source is the restock notification, which is per-user and private; stock-risk alerts do not exist
yet (a later milestone). No event is ever invented: everything above comes from the pharmacies' event streams or the node-status reading.

## Where events come from

```
pharmacy DB -> outbox -> connector -> Redis stream medlink:events:{P001} -> inventory-sync (consumer group "inventory-sync")
                                              |                                      |  writes dedup marker "done"
                                              +--- search API: one shared LiveHub ---+
                                                    XREAD (no group, no ack)  ->  "stock" events
                                                    getNodes() (Milestone 1)  ->  "node" events
                                                    -> every connected browser
```

- **One shared hub, not one subscription per browser.** A single timer reads every pharmacy stream with plain `XREAD` on the existing Redis
  client (no extra connection, one command per pharmacy because a cluster cannot read keys from different slots in one command) and recomputes node status once
  per tick, for everyone. With nobody connected there are no timers and no Redis traffic.
- **It cannot disturb inventory synchronization.** `XREAD` is not `XREADGROUP`: it creates no group, delivers nothing to a consumer, acknowledges nothing and
  deletes nothing, so the sync service's cursor and pending list are untouched (there is a test that asserts exactly that). SSE connections never run on the
  transaction path, and the stream does no database queries.
- **`stock` waits for the sync service.** A stream entry is released to browsers only once the sync service has marked that event id `done` (its dedup marker), in
  stream order. A browser that reloads on the event therefore sees the applied state. An entry never confirmed within 30 s (for example one that was dead-lettered) is
  skipped so it cannot hold the rest back; it is counted, not delivered.
- It starts at each stream's current end: history is never replayed to a browser.
- Entries that are not valid events (bad JSON, unsupported `schemaVersion`, or naming another pharmacy than the stream's) are skipped and counted; one never ends the stream.

## Connection lifecycle

1. The server sends `connected`, anything missed (see below), then the node snapshot.
2. Heartbeats every 15 s keep proxies from closing an idle connection.
3. A client that cannot keep up (more than 512 KB unsent) is dropped; the browser reconnects.
4. When the browser goes away, its slot, socket and (for the last client) all of the hub's timers are released. On server shutdown every stream is ended first.
5. If Redis is unreachable the stream stays open: the stock feed is retried every 500 ms, node events report `unknown`, nothing crashes, and nothing is reported healthy. If the hub was already reading, it resumes from its stored stream position, so changes published during the outage are delivered once Redis is back; a hub that starts while Redis is down begins at the end of each stream once it can read, and clients resync on reconnect anyway.

## Reconnection and `Last-Event-ID`

Events carry ids `<bootId>.<n>`. The server keeps the last 200 in memory.

- Reconnecting with an id from this run that is still in the buffer: the missed events are replayed after `connected` (`resync: false`).
- An id from before a server restart, older than the buffer, or otherwise unknown: `connected` has `resync: true`, nothing is replayed, and the client reloads from the API.
- The web client (`apps/web/src/lib/live.ts`) additionally reloads after **every** reconnect, ignores an event id it has already seen, and retries by itself with a growing delay if the browser gives up.

**Reliability.** At-most-once per connection, in order; no exactly-once claim. Events can be missed (a long outage, a buffer overflow, a server restart) and a replay can repeat one (the client discards repeated ids). Restarting the search API loses the buffer, so everyone resyncs.

## In the web app

- **`/dashboard`**: shows `Connecting… / Live / Reconnecting… / Live updates off` and when it was last updated. A `node` event replaces that card (only if it is newer than what the page already has); the first load and Refresh still use `GET /api/nodes`; a reconnect triggers one reload.
- **`/search`**: when a `stock` event arrives for a medicine in the current results, the same search is read again once, 800 ms later (a burst is one reload). Events for other medicines are ignored. The existing 20 s refresh stays as the fallback.
- Without `EventSource` (or with the stream down) both pages work as before.

## Trying it locally

```bash
npm run dev:all          # web :3000, search API :4000, portal :4200, connector, sync, notifications
# or just what live updates need:
npm run api:dev          # search API (also serves /api/stream)
npm run sync:start       # consumes the streams, writes the "done" markers
npm run connector:start  # publishes the pharmacies' outbox to Redis
npm run web:dev
```

Watch the raw stream (`-N` turns off curl's buffering):

```bash
curl -N http://localhost:4000/api/stream
```

You get `connected`, five `node` snapshots and a `heartbeat` every 15 s. In another terminal make a real change through a pharmacy's own database (this goes
through the outbox, the connector, Redis and the sync service, like the portal does). A price change is the quietest way, because it cannot trigger restock notifications:

```bash
# in the pharmacy portal (http://localhost:3000/portal), change a price, or from code:
#   new PharmacySimulator(pools).changePrice("P001", "M001", 26)   (packages/pharmacy-ops)
```

A `stock` event follows within a couple of seconds, then `node` events as the counters move. Open `/dashboard` and `/search?q=Crocin` in a browser to watch the cards and results update.

Tests: `npx vitest run apps/search-service/test/stream.test.ts apps/web/src/lib/live.test.tsx apps/web/src/components/dashboard apps/web/src/components/search/SearchLive.test.tsx`
(the Redis feed tests use the local Redis with a unique key prefix and remove their keys).

## Limitations

- In-process and in-memory: one search-API process. Behind several instances each has its own hub, buffer and `bootId` (a reconnect to another instance resyncs; nothing is lost, but `Last-Event-ID` replay does not carry across instances).
- Polling, not push: stock events are noticed within about one poll (500 ms) of the sync service finishing, and node status within about 5 s (or sooner after stock changes).
- `stock` events are hints. They do not include sale sizes, and a change the sync service never confirms is not announced at all.
- No access control (see above), and no stream for stock-risk alerts until that feature exists.
