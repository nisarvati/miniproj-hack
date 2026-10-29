# Pharmacy node status (`GET /api/nodes`)

A read-only view of how each pharmacy's inventory synchronization is doing, for the `/dashboard` page. MedLink is eventually consistent:
the numbers describe what MedLink has processed so far, and nothing here promises how quickly a change reaches search.

## Where the data comes from

| Source | Used for | Notes |
|---|---|---|
| Pharmacy registry (`activePharmacies`, `presentPharmacy` in `@medlink/db`) | Which pharmacies to list, and their names | The original five, plus a directory pharmacy once its `PHARMACY_Pxxx_DATABASE_URL` is set. No database is queried. |
| Redis sync status, `medlink:sync:{P001}` (written by `apps/inventory-sync`) | `lastSyncedAt`, `processedCount`, `duplicateCount`, `staleCount` | Read only. |
| Redis stream and consumer group `inventory-sync`, `medlink:events:{P001}` | Events waiting to be processed (`XINFO GROUPS`: lag + pending) | Used for the status only; not returned. |
| Sync service health endpoint, `http://127.0.0.1:<HEALTH_PORT_SYNC, default 4302>/health` | Whether anything is consuming the streams (`ready`) | Best effort, same limits as the connector. Redis cannot tell "caught up" from "nobody is running", so this is what lets a node be called healthy. |
| Connector health endpoint, `http://127.0.0.1:<HEALTH_PORT_CONNECTOR, default 4301>/health` | `unpublishedOutbox`, "pharmacy database unreachable", "polling failing" | Best effort. The outbox lives in each pharmacy's own database, which this endpoint never queries. If the connector is not reachable from the search service (not running, another host, or `HEALTH_PORT_CONNECTOR=off`) these are unavailable. |

No pharmacy database, credential or connection string is read or returned.

## Response

```json
{
  "data": [{
    "pharmacyCode": "P001", "name": "…", "status": "healthy|degraded|down|unknown", "statusReason": "…",
    "lastSyncedAt": "ISO timestamp | null", "syncLagMs": "number | null", "unpublishedOutbox": "number | null",
    "staleCount": "number | null", "duplicateCount": "number | null", "processedCount": "number | null"
  }],
  "meta": {
    "generatedAt": "ISO timestamp", "redis": "up | down | not-configured", "connector": "up | unreachable | not-configured",
    "syncService": "ready | not-ready | unreachable | not-configured",
    "thresholds": { "degradedAfterMs": 15000, "downAfterMs": 120000 }
  }
}
```

`statusReason` and `meta.thresholds` are additions to the minimal contract: they say which evidence decided `status`. Always HTTP 200 (see
"Redis unavailable"), `cache-control: no-store`. Open like the other `/api` routes (counts, times and public pharmacy names only).

## What each metric means

| Field | Meaning | Unknown (`null`) when |
|---|---|---|
| `lastSyncedAt` | When the sync service last **processed an event** for this pharmacy. Not a heartbeat. | Nothing was ever synchronized, or the stored value is not a valid date |
| `syncLagMs` | `generatedAt − lastSyncedAt`: the **time since the last processed event**, not the delay of an individual change | `lastSyncedAt` is null, or lies in the future |
| `processedCount` | Events that reached the sync handler (duplicates are stopped before it) | No status record, or the field is malformed |
| `duplicateCount` | Redeliveries skipped because the event id was already handled | As above. The counter is created by the first duplicate, so beside a valid `processedCount` an absent field is a real `0` |
| `staleCount` | Events that changed nothing because a newer event had already decided every field (older, out-of-order events) | As for `duplicateCount` |
| `unpublishedOutbox` | Changes the pharmacy recorded but has not yet published (connector's count) | The connector is unreachable or could not count |

A real `0` and "unknown" are never mixed up: the dashboard shows `0` only when MedLink measured `0`.

## Status policy

A quiet pharmacy has an old `lastSyncedAt` and is fine, so silence alone is never a failure. Freshness is held against a node only when events are
**waiting** (consumer-group lag + pending > 0). Rules, in order (first match wins):

1. Redis cannot be read → `unknown` for every node.
2. The connector reports the pharmacy's database unreachable → `down`.
3. Events are waiting:
   - last processed ≤ 15 s ago → `healthy` (being worked through);
   - 15 s – 120 s ago → `degraded`; never processed → `degraded`;
   - more than 120 s ago → `down` (the sync service is not consuming).
4. The connector reports its last poll of this pharmacy's outbox failed → `degraded`.
5. Nothing waiting and a valid `lastSyncedAt`:
   - sync service `ready` (or its check is not configured) → `healthy` ("caught up");
   - sync service `not-ready` → `degraded`;
   - sync service `unreachable` → `unknown` (nothing confirms that anything is processing changes).
6. Otherwise → `unknown`: never synchronized, the waiting count could not be measured, or the stored time is unusable.

A status key existing is never enough for `healthy`. The thresholds are `THRESHOLDS` in `apps/search-service/src/modules/nodes/service.ts`; they are
conservative defaults, not measured values.

## Redis unavailable

`200`, every `status` is `unknown`, every counter and time is `null`, `meta.redis` is `down` (could not be read in 800 ms) or `not-configured`
(`LIVE_STOCK=off`, or no Redis settings). Nothing is reported healthy or zero. The pharmacy list is still returned so the page can say what it cannot see.

## Limitations

- "Healthy" means this pharmacy's pipeline is caught up as far as MedLink can see. It does not prove the pharmacy's own systems are online: with the
  connector unreachable, changes stuck in a pharmacy outbox are invisible here (`unpublishedOutbox` is `null`, and the dashboard says so).
- There is no heartbeat. Detecting a silent pharmacy would need a heartbeat written by the connector or the sync service, which this milestone does not add.
- `syncLagMs` is time since the last processed event. The per-event delay the sync service measures (`lastLatencyMs`) is stored in Redis but not exposed here.
- Live updates arrive over `GET /api/stream` (see [live-updates.md](live-updates.md)); the dashboard also keeps its Refresh button, which reads this endpoint.
- No access control beyond the other `/api` routes. A role-restricted dashboard belongs with the admin-role milestone.
