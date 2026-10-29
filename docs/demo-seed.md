# Demo inventory seeder

Spreads the catalogue medicines (see [catalogue.md](catalogue.md)) over the five demo pharmacies as **synthetic demo
stock**, so the discovery workflow can be tried across several pharmacies. Nothing it creates is real stock or a claim
about a real pharmacy.

```
npm run demo:seed                      # dry run (the default): prints the plan, writes nothing
npm run demo:seed -- --write           # add the stock, through the normal inventory path
npm run demo:seed -- --seed=other      # a different, equally repeatable spread
npm run demo:seed -- --list            # read only: which rows currently look like this seed's output
```

## How it writes

Each row is added with `PharmacySimulator.addMedicine`, the same code the portal and the simulator use: an insert into
**that pharmacy's own database**, whose trigger records a `MEDICINE_ADDED` event in the outbox in the same transaction.
The inventory connector, Redis Streams (`medlink:events:{P00x}`), the sync service, Redis state and the central mirror
then carry it exactly like any other change, so **the normal pipeline is exercised; nothing is written to Redis, to the
central inventory table or around the outbox.** If the connector and sync service are not running, the events wait in
the outbox and are delivered when they start. The central catalogue is only read.

There are five separate physical pharmacy databases (more once the independent demo pharmacies of [demo-pharmacies.md](demo-pharmacies.md) are provisioned and configured; until then the seeder uses exactly the five) (`PHARMACY_P00x_DATABASE_URL`) plus the central one, so each
pharmacy's inventory stays independent.

## What it adds (default seed `medlink-demo-1`)

The medicines are the 152 catalogue medicines above `M015` (the 15 demo medicines keep their own starting stock).
The plan is a pure function of the seed: the same seed always gives the same rows, a different seed a different spread.

* **Common** categories (pain, allergy, GI, respiratory, cardiology, vitamins, endocrinology, first aid) are listed by a
  pharmacy with probability 0.65, **mid** (anti-infectives, dermatology, neurology, hepatology, fertility) 0.35, **rare**
  (hospital/specialty, oncology, nephrology) 0.12: common medicines appear in several pharmacies, rare ones in few.
* Quantities: about 10% listed with **zero** stock, 20% low (1 to 5), the rest in stock. Prices are synthetic: a base price
  per medicine in a range for its tier, times each pharmacy's existing price factor and a little jitter, in rupees to two decimals.
* Intentional cases, the same for every seed:

| Case | Medicine | Result |
|---|---|---|
| several pharmacies, different prices | Amlong 5mg | all five pharmacies, five different prices |
| exactly one pharmacy | Retaunch | P002 only |
| listed but sold out | Cabgolin 0.5mg | P004, quantity 0 (`OUT_OF_STOCK`) |
| in the catalogue, listed by nobody | Nefrozon, Dutas | no offers; the search says "No pharmacy has listed this medicine yet" |

With the default seed against a fresh set of pharmacies: **322 new inventory rows** (P001 55, P002 64, P003 78, P004 56,
P005 69), of which 315 random, 5 multi-price, 1 single-pharmacy and 1 zero-stock.

## Names

The pharmacies seeded here are the persisted demo pharmacies P001 to P005 ("Pharmacy A" … "Pharmacy E"). The app shows them under the directory names described in [demo-pharmacies.md](demo-pharmacies.md), with the notice that the inventory is simulated; this command still prints the persisted names.

## Safety

* Dry run is the default. Nothing is written without `--write`, and it never runs at startup.
* A write is refused unless the environment is positively local or isolated: `NODE_ENV` is not `production`,
  `MEDLINK_ENV`/`APP_ENV` (if set) are development/local/test, `DATABASE_URL` is set, and the central and every pharmacy
  database are on `localhost`, `127.0.0.1` or `::1` with no "prod" in the database name. Anything unknown is blocked.
* It only **adds**. A pharmacy that already lists a medicine keeps its row untouched (reported as skipped), so existing and
  manually entered stock is never overwritten, a second run adds nothing, and nothing is deleted or reset.
* **Directory pharmacies are opt-in.** The default targets are P001 to P005 only. `--include-directory=P006` seeds a directory pharmacy, only if its database was set up with `npm run demo:directory-setup` (empty start) and holds no stock this seed did not write. See [demo-pharmacies.md](demo-pharmacies.md).
* It does not touch the central catalogue, migrations, users, approvals or credentials.

## Telling demo data from real data

The pharmacy schema has no column for it, and none was added. Demo rows are identified by reproduction: `--list` replays
the plan and prints the rows that are listed with exactly the planned pharmacy, medicine, quantity and price; a changed
row no longer matches. To remove demo stock, take those rows through `npm run simulator` (`remove <pharmacy> <medicine>`)
so the removals are events too; do not delete from the databases directly.

## Limits

* Quantity and price are not updated by a re-run: change the seed to add a different spread, never to refresh values.
* The seeder reads the central `medicines` table, so import the catalogue first (`npm run db:catalogue`); without it there is nothing to spread.
* Search sees the stock only once the connector and sync service have run (or, with Redis down, the central mirror).
