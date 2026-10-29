# Web app and search API (milestone 13)

What a patient sees, and what the API behind it does. The idea running through all of it: **what is on screen follows
what happens at the pharmacy**, and the screen says how fresh each number is.

## Pages

| Route | What it is |
|---|---|
| `/` | Search. A welcome with suggestions until you search; then filters, list or map, and for a medicine that is out of stock everywhere, "Notify me" and same-ingredient alternatives. |
| `/pharmacies` | Every pharmacy, nearest first. |
| `/pharmacies/[id]` | One pharmacy: address, distance, directions, and everything it stocks with live status. Search within it, filter by availability, ask to be notified about anything out of stock. |
| `/notifications` | Your restock alerts: the notifications (with "New"), what you are waiting for (cancel), and earlier ones. A bell with an unread count in the header and bottom bar. |
| `/dashboard` | Pharmacy synchronization status, one card per active pharmacy, from `GET /api/nodes`: health, last synchronized, time since last sync, processed, duplicate and stale event counts, and the pharmacy outbox backlog when available. Unknown values say so; it has a Refresh button (no live updates yet). See [node-status.md](node-status.md). |

The header has a **location chip** (areas, "use my current location", or coordinates; remembered on the device), a theme
toggle, and the navigation (a bottom tab bar on phones). The search itself lives in the URL
(`/?q=crocin&stock=1&dist=5&price=50&sort=price&view=map`), so a search can be shared, bookmarked, and survives a reload.

## Live stock

Search no longer answers from the central database alone. For each offer the API asks Redis, where the sync service
keeps the current stock of every medicine at every pharmacy (milestones 7 to 10), and uses that when it has it.

| In Redis | Result |
|---|---|
| a record | its quantity, price and time of the last event win. Marked **Live**. |
| a record marked removed | the pharmacy stopped stocking it: dropped, whatever the central table says |
| a record with a price but no quantity yet | the missing field comes from the catalogue, so it never reads as "0 left" |
| medicine added through an event, never in the central table | appears (its details come from the catalogue) |
| nothing | the catalogue's last known value. Marked **Last known**. |
| Redis down or slow (over 400 ms) | everything falls back to the catalogue, search still answers, and the page says "Showing last known stock" |

### Distance and ordering (`distanceKm`, `meta.sortApplied`)

Distance is computed only from a valid user location to a pharmacy whose point is **verified** (two independent map sources agree). Otherwise `distanceKm` is `null` and `distanceVerified` is `false`; the app shows "Distance not shown" and no map pin. Unverified pharmacies get no distance credit when ranking, so they cannot outrank an otherwise equal verified one. With `sort=distance`, verified results come first nearest-first, then the unverified ones are set apart. If no result has a verified distance (or the location is unknown), `meta.sortApplied` is `best` and `meta.sortNote` explains it. `meta.unverifiedCount` counts results without a verified location; `maxDistanceKm` drops them and reports how many in `meta.unverifiedFiltered`.

### Directory listings (`GET /api/directory`)

Read-only, from the demo directory file: accepted entries not yet onboarded (P006) and research leads (`listingStatus` provisional, needs-review or excluded). Each has `inventory: "none"`, `locationVerified: false`, the demo label, and `directions` (`address`, `approximate` or `unavailable`). No coordinates, distance or stock are ever returned, so these never appear in search or on the map. The Pharmacies page lists non-excluded ones under "Directory listings: no inventory". See [demo-pharmacies.md](demo-pharmacies.md).

### Catalogue matches (`meta.matches`)

`GET /api/search` also returns `meta.matches`: every catalogue medicine the query matched (the same matching as before),
each as `{ medicine, listed }`. `listed` is true when at least one pharmacy lists the medicine, before any filter and
even at zero stock; it never says anything about stock and is never true just because the medicine is in the catalogue.
The page uses it for three empty states: **"No pharmacy has listed this medicine yet"** (matches exist, none listed),
**"“…” isn't in the MedLink catalogue"** (no matches), and the filter message when a listed medicine's offers are hidden
by filters. With offers it adds a note for other matches nobody lists. `data` and the other `meta` fields are unchanged,
and a client that ignores `matches` works as before; the web app treats a missing `matches` as "unknown" and shows
the old empty state.

`/api/health` reports it separately (`checks.live`) and never fails because of it. `LIVE_STOCK=off` turns it off.

On every card and row the freshness is explicit: a pulsing dot, **Live · updated 12 s ago**, or **Last known · updated 2
days ago**, counting up without a refetch.

## Filters, sorting, alternatives

`GET /api/search` also takes `inStock`, `maxDistanceKm`, `maxPrice` and `sort` (`best`, `distance`, `price`, `stock`).
Filters apply before ranking. Every sort puts what can be bought before what is sold out, and `rank` follows the
order shown.

"Out of stock everywhere" is decided from the **unfiltered** results: otherwise "In stock only" would hide the very
medicines that deserve a restock notification. With filters on, the page asks once more without them.

`GET /api/medicines/:id/substitutes?lat&lng` returns other medicines with the same active ingredient that can be bought
nearby, closest match first (same form and strength before the rest). Each says whether strength and form are the same,
and the response carries the notice shown with it: *Strength or form may differ. Check with a pharmacist or your doctor
before switching.* It is a suggestion, never a recommendation.

## Pharmacy endpoints

`GET /api/pharmacies/:id` (with `?lat&lng` also the distance) and `GET /api/pharmacies/:id/stock` (`q`, `inStock`; the
same live overlay; a summary of in stock / low / out).

## Design

* **Tokens, not colours.** `globals.css` defines one set of semantic tokens (`canvas`, `surface`, `ink`, `muted`,
  `line`, `brand`, and `ok` / `warn` / `bad` / `info` with soft backgrounds). Components use those names.
* **One appearance.** MedLink has only the light, warm-paper theme: there is no dark mode, no toggle and no stored theme
  choice. The root layout declares `color-scheme: light` (and one `themeColor`), so the operating system's dark setting and
  browser auto-dark have no effect, and `app/single-theme.test.ts` fails if a dark class, variant, toggle or saved-theme
  logic reappears.
* **Cards.** One card system (`Card` in `components/ui/primitives.tsx`; tokens `--card-*` and the `.mx-card` rules in
  `app/app-theme.css`, keyframes in `globals.css`; `app/card-system.test.ts` pins it). Variants: `glass` (default: a sage-tinted,
  slightly translucent paper surface, a fine green-tinted rule, a 1px cream edge, a soft neutral shadow), `solid` (forms and dense
  information: account, portal, pharmacy page), `quiet` (explanatory panels: flat), `overlay` (dialogs, popovers, search
  suggestions: the only one that blurs what is behind it, 10px, and only where `backdrop-filter` is supported; otherwise nearly
  opaque). `interactive` adds hover/focus feedback (a 2px lift, a firmer rule); `selected` is a solid green rule. Motion is
  180ms on one easing curve, only opacity and small transforms; new search results fade in once, `<details>` content eases open,
  dialogs ease in and out. `prefers-reduced-motion` removes all of it. The pharmacy directory stays a ruled list on purpose, and
  the calendar's entry chips use the same fill, rule and edge in a small, unblurred form.
* **Status is never only colour.** Stock is text plus an icon plus colour; "Live" is text plus a dot.
* **Phones first-class.** Bottom tab bar, filters that scroll sideways in one row, stock rows that stack.
* **Accessible.** Skip link, visible focus ring, labelled controls, announced toggle states, live regions for results.
  An axe-core audit (WCAG 2.0 / 2.1 A and AA plus best practices) of every page in both themes found no violations.
* **No sign-in yet**, so the email you used to ask for an alert is how the device recognises you (see
  `docs/restock-notifications.md`). Notifications are simulated: they appear in the app instead of being emailed.

## Homepage and routes

| Route | What it is |
|---|---|
| `/` | The homepage: the V1 landing page (`components/landing/v1/V1Landing`), indexable, canonical link to `/`. It has no app chrome and carries its own header, footer and search. |
| `/search` | The search app (`SearchPage`). Its URL is its state: `/search?q=Crocin&stock=1&sort=price`. |
| `/pharmacies`, `/notifications`, `/portal` | Unchanged. |
| `/landing` | Redirects to `/` (the old comparison index is gone). |
| `/?q=...` | Redirects to `/search?q=...`, so searches that were shared or bookmarked before the move still work. Both redirects are in `next.config.ts` and are temporary (307) while the homepage settles. |

The search app used to live at `/`. It moved so that `/` can be the landing page; `SearchPage` builds its URLs from the
current path, so nothing inside it changed. Links that mean "search" (the Search tab, the empty states, the 404 page and
the landing pages' search) point at `/search`. The logo links to `/`. Set `NEXT_PUBLIC_SITE_URL` to the public address so
the canonical link is absolute (it defaults to `http://localhost:3000`).

## Application theme (V1 identity on the functional pages)

The pages that are not landing pages (`/search`, `/pharmacies`, `/pharmacies/[id]`, `/notifications`, `/portal` and the 404)
share the identity of the approved V1 landing page: warm paper, forest green, a heavy grotesk for headings, a mono for
labels, hairline ink rules and almost square corners. They stay denser and plainer than the landing page.

* **One file, one scope.** `app/app-theme.css` holds the theme and every rule in it is under `.app-theme` . `AppShell` renders that wrapper for ordinary pages only; `/` and `/landing/*` take its bare
  branch, so the homepage and V2-V5 cannot be affected. `app/app-theme.test.ts` fails if a rule escapes the scope or
  `:root` gains anything but `--app-*` / `--paper-grain`, and `AppShell.test.tsx` checks which routes get the wrapper.
* **Tokens, not per-page colours.** Components already use semantic tokens (`bg-surface`, `text-muted`, `border-line`,
  `bg-brand`...). The theme re-points those inside the scope (values mirror `.page` in `landing/v1/v1.module.css`) and
  re-points Tailwind's radius scale, so most pages needed no change. To retune the app, edit that one file.
* **Type.** `app/layout.tsx` loads V1's two families (Bricolage Grotesque, IBM Plex Mono) as `--app-display` and
  `--app-mono`, without preload, so the landing previews do not download them. `.editorial-title` (headings) is now the
  grotesk; `uppercase` labels, buttons and the nav use the mono (`.ui-mono`).
* **Status keeps its meaning.** In stock, low stock and out of stock (and Live vs Last known) are still written out and
  carry an icon as well as a colour; only the tones were warmed to sit on paper. Contrast of every token pair was checked
  (text 4.5:1, borders and focus ring 3:1).
* **Shell.** Header and tab bar have an ink rule, nav labels are mono with the current page underlined, and the footer
  has an ink rule. The `/search` start page (no query yet) is a flat, ruled version of the old hero.

## Landing page directions

V1 is now the homepage, and also stays at `/landing/v1` (noindex, the same component). V2-V5 are previews for review: still
at their own routes, noindex, and nothing links to them from the app.

| Route | Direction |
|---|---|
| `/landing/v1` | Print-tech paper (now the homepage at `/`): ivory sheet, oversized grotesk, mono marginalia, forest-green accent, with one technical plate ("Under the surface") on the same paper. |
| `/landing/v2` | Clinical precision: Swiss spec-sheet grid, graphite, mineral green, amber for action. |
| `/landing/v3` | Urban pharmacy atlas: a typeset map publication, olive and burnt orange. |
| `/landing/v4` | Signal and stream: graphite and off-white, moss signal states, amber; dark only. |
| `/landing/v5` | Humanist utility: warm off-white, forest green, terracotta; the person first. |

* **Same facts, different art direction.** Copy that states what MedLink does and does not do (not an online pharmacy,
  no medical advice, stock and prices change, not every pharmacy is connected) lives once in
  `components/landing/shared/content.ts`. Each direction owns its layout, type (`next/font`, loaded only on its own
  route), palette and CSS Module under `components/landing/vN/`. They deliberately depart from the app's identity.
* **No app chrome.** `AppShell` renders only its providers (theme, location, account) for `/`,
  `/landing` and `/landing/*`, so a page draws its own header, footer and skip link. Every other route has the app chrome.
* **Search is the existing search.** `shared/LandingSearch` is a plain `GET /search` form (`name="q"`) that also navigates
  with the router, so it works without JavaScript. It sends the visitor to `/search?q=...`, the search page's own URL state
  (built with `toSearchParams`). It carries behaviour only; each direction styles it through `data-ls` attributes.
* **Availability is real or labelled.** `shared/AvailabilitySample` calls `searchMedicines("Paracetamol", ...)` for the
  picked location and shows the returned medicine, strength and form, pharmacy, distance, stock, price and freshness
  (live vs last known, with its age). Loading, empty and error states are shown as such. Invented rows appear only if the
  reviewer picks "Illustrative preview", and every row and the section say they are invented. Pack size is not shown
  because the catalogue does not carry it.
* **Hero images.** `shared/HeroSlot` reserves each direction's image at a fixed aspect ratio (4:5, 3:2, 3:4, 16:9,
  4:5), so layout does not depend on the art. To use the real image, pass `src` and `alt` to that direction's
  `<HeroSlot>`; it fills the same box. V1 has its final artwork, `apps/web/public/images/landing/v1-hero.webp`
  (1600 × 2000, text-free, drawn as vector art and rasterised, with the V1 palette): a terrace of three independent pharmacy
  storefronts, each joined by a dotted line to its pin on a simple street map (hand-inked look, colour printed slightly off the linework). V2–V5 still show the placeholder.
* **Links.** Only routes that exist (`/portal`, `/pharmacies`, `/notifications`) and anchors on the page. There are no
  privacy or terms links because those pages do not exist.

Technical marginalia (`P00x`, grid coordinates, rulers) are format and layout decoration. Nothing on these pages
claims a live reading except the availability table, which is the API's data.

## Running it

```
npm run api:dev     # the API, with live stock when Redis is reachable
npm run web:dev     # http://localhost:3000
```

For a live demo, run the pipeline too (`connector:start`, `sync:start`, `notify:start`) and drive it with the pharmacy
simulator (`npm run simulator`): sell something out and watch the result change in the browser.

## Tests

* `apps/search-service/test/live.test.ts`: the overlay (sale, restock, price, removal, addition, late events), fallback
  when Redis is down or never answers, filters and sorting, alternatives, pharmacy pages.
* `tests/live-search.test.ts`: a change made through the pharmacy simulator shows up in the search API through the
  real pipeline.
* `apps/web/src/**/*.test.tsx`: the pages and the notify form in jsdom against a fake backend (URL state, out-of-stock
  panel, filters, errors and retries, cancel, unread tracking). `lib/*.test.ts`: the pure logic.
* `apps/web/src/components/landing/**`: the shared search (route, validation, keyboard), the availability states (live,
  stale, error, empty, illustrative), and a smoke test of each direction (one h1, the primary CTA twice, only real
  links, one image slot, the limitations stated). `shell/AppShell.test.tsx`: the app chrome is dropped only under
  `/landing`.
* Not covered by tests in the repo: the visual result. It was checked in a real browser (screenshots, phone and desktop,
  light and dark, the whole subscribe / restock / notify journey, and the accessibility audit), but that is not repeatable
  from `npm test`.
