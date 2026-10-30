# Analytics dashboard (`/dashboard`)

A read-only view of the pharmacy network, its inventory and its synchronization. It never creates, changes or completes anything (no stock, no
restock plan, no alert), and it adds no second live-update mechanism: it uses the existing `GET /api/nodes` and `GET /api/stream`.

## What is shown, and where each figure comes from

| Section | Figure | Source | Public? |
| --- | --- | --- | --- |
| Overview | Nodes, healthy nodes, events processed (since counting began), events waiting in outboxes, average time since last event | `GET /api/nodes` (Redis sync status, connector health) | yes |
| Overview | Your active alerts, your open restock plans | `GET /portal/analytics` | **staff of that pharmacy only** |
| Inventory | Stock availability (in / low / out) across the network and per pharmacy | `GET /api/analytics/network` (central mirror with live overlay): **status counts, never quantities** | yes |
| Inventory | Sales and restocks per day, most frequently sold, stock-risk distribution | `GET /portal/analytics`, from the pharmacy's own `inventory_movements` and inventory | **staff of that pharmacy only** |
| Synchronization | Events **published** per time bucket | `GET /api/analytics/network`: entry ids of each pharmacy's Redis stream (plain `XRANGE`, ids only) | yes |
| Synchronization | Events processed / duplicate / stale per pharmacy | `GET /api/nodes` counters (cumulative) | yes |
| Synchronization | Time since each pharmacy's last event | `GET /api/nodes` | yes |
| Synchronization | Backlog while the page is open | readings of `unpublishedOutbox` taken in this browser session | yes |
| Pharmacy network | One card per node: health, last event, counts | `GET /api/nodes` + live `node` events | yes |
| Restock planning | Plans by status, open, overdue | `GET /portal/analytics` (`restock_plans`) | **staff of that pharmacy only** |

Sales, risk, alerts and plans are never shown across the network: they belong to one pharmacy, and the public live stream deliberately carries no sale sizes
([live-updates.md](live-updates.md)). A signed-out visitor, an administrator (who has no pharmacy) and a visitor for whom the portal did not answer each get a
different, honest message instead of a number.

## What is deliberately not shown

- **Events processed over time, and a synchronization-lag trend.** MedLink keeps only cumulative counters and the time of the last event. The time series
  charts what each stream still retains **by publish time** and says so; the backlog line is measured only while the page is open.
- **Percentage changes or trends** against earlier periods: there is no stored history to compare with.
- **Pharmacy-wide totals of sales or risk**, for the privacy reason above.
- A quiet pharmacy's "time since last event" is not a delay. It is shown as a time, not as a health verdict.

Event processing, pharmacy-node health and medicine stock risk are three different things and are labelled as such on the page.

## `GET /api/analytics/network?hours=6|24|72` (public)

`{ data: { window, events, stock }, meta: { generatedAt, eventsMeaning, eventCap } }`. `window` has 24 clock-aligned buckets (`bucketMinutes` 15, 60 or 180).
`events` and `stock` each say `available: false` with a `reason` (`NOT_CONFIGURED`, `ERROR`) when they cannot be read; the other part still answers. Counts are capped at
5,000 stream entries per pharmacy (`events.truncated` says when that cut something). Unknown `hours`: `400`. `cache-control: no-store`.

## `GET /portal/analytics?days=7|14|30` (staff only; default 14)

Aggregates in the signed-in pharmacy's own database, one `SELECT` per section, for the pharmacy in the session (never one named in the request):
`movements.daily` (sales and restocks per UTC day, zero-filled), `movements.totals`, `topSold` (five medicines by units sold), `stock`, `risk.byLevel`, `alerts`, `plans`.
Each section is `{ available: true, ... }` or `{ available: false, reason: "SCHEMA_OUTDATED" | "ERROR" }`; a pharmacy database that has not had a migration gives one unavailable section, not a failed page.

- Only **sales and restocks recorded through the portal** (`source = TRANSACTION`) are counted. Stock-count corrections are reported separately and are not sales. Nothing before the movement history existed is back-filled, so a quiet day may also mean "not recorded".
- It **never reconciles alerts**: unlike the risk and alert views it does not write. `alerts.active` is the stored count and can trail the stock until staff open those views.
- Overdue means an open plan (planned or in progress) whose target date is before today (UTC).
- `401` without a session, `403` for an administrator, `400` for an unsupported range.

## Live updates

The page reuses the existing stream. A `node` event updates that card in place. A `stock` event schedules **one** read of the network figures 2.5 s later (a burst is one
read), plus the pharmacy's own figures when the event is for that pharmacy. After a reconnect everything is read again. A stream that is down leaves the page working with
Refresh. Nothing from the stream is stored as history.

## Entrance animation

Cards drop a few pixels (8 px) into place with a fade, once, the first time they are on screen, staggered 110 ms apart within a group; the header goes first. Only `transform` and `opacity`
change, so nothing shifts. A card keeps the same element across live updates and never replays. With `prefers-reduced-motion` there is no movement at all
(`.dash-drop` in `app-theme.css`; `Reveal.tsx`).

## Layout: one screen per section

On a tablet or larger window (at least 48rem wide and 34rem tall) `/dashboard` is a full-window page like `/calendar`: the app header, then the dashboard fills what is left (`app-shell-fill`,
`.dash-main`), with a fixed side navigation (a chip bar on a phone), a compact header, and a **stage** that scrolls from one section to the next, each snapping into place.
The height comes from the shell, so the real header height is already taken; nothing uses a guessed `100vh`.

- Each section is `height: 100%` of the stage, but never less than its content's own minimum (`min-height: min-content`). Its cards sit in a grid whose rows are `auto`, so each row
  gets its own content height and the rows share only the leftover space. When the window is too short for the content, the section is taller than the stage and the stage scrolls; cards
  are never squeezed over each other.
- Charts are drawn at the size of their container (`useBox`, a `ResizeObserver`), so they use the room a card has and text stays one size. On a phone they keep a fixed, readable height.
- A short window (under 820 px tall) or a tablet width tightens the density: padding, donut size and bar rows shrink, panel descriptions are cut to one line (the full text is the tooltip),
  and the section intro is kept for screen readers only. Nothing is removed.
- Five node cards are one row on a wide window, three per row on a laptop, and stacked rows on a tablet. A phone stacks everything and the page scrolls.
- The shell is `overflow: clip`, so following an anchor link can only scroll the stage, never the page chrome.

Measured in Chrome (see [verification.md](verification.md)): at 1440 x 900 and 1366 x 768 every section fits one screen for staff, signed-out visitors and administrators. At 768 x 1024 the
Overview and Restock sections fit; staff Inventory, Synchronization and Network need to scroll within their section. A 390 x 844 phone scrolls like any page, with no sideways overflow.

## Charts

No charting library was added. `charts.tsx` draws small SVG charts (grouped bars, line, donut, horizontal and stacked bars). Each is a labelled image with the same numbers in a
visually hidden table, a visible legend or value list (never colour alone), a tooltip on hover or keyboard focus, and an axis that starts at 0.
