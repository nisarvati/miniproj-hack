# Demo pharmacy directory (independent local pharmacies)

> **Demo directory listing — not a confirmed MedLink partner.**
> **Inventory shown is simulated and not confirmed by the named pharmacy.**

Real, independently run neighbourhood pharmacies, shown as a **demo directory** in MedLink. They are candidates, **not confirmed
partners**: none has agreed to take part or to the use of its name, and every stock level, price and availability shown for them is
**synthetic demo data** ([demo-seed.md](demo-seed.md)), not their inventory. Only business names and public street addresses are kept.

The data is `packages/db/pharmacy-directory/mumbai-demo.json` (checked 2026-10-22).

## How P001 to P005 are shown: a display mapping

P001 to P005 are still the five fictional demo pharmacies **underneath**; the app now shows them under these real names and addresses.

| | Persisted (unchanged) | Shown in the app |
|---|---|---|
| Central `pharmacies` rows (id, code, name, address, coordinates) | "Pharmacy A - Andheri West" … "Pharmacy E - Powai" | the directory name and address |
| Local databases, `pharmacy_profile`, 68 inventory rows, 74 outbox events | fictional demo identity | not shown by name |
| Redis streams, inventory keys, sync state, medicine index sets | `{P001}`…`{P005}` | none |
| Portal accounts (6, bound to the codes) | unchanged | the portal keeps the demo name: it edits the demo pharmacy's simulated stock |
| Catalogue | 167 medicines | unchanged |

The mapping is applied when a response is built (`presentPharmacy` in `packages/db/src/pharmacy-registry.ts`, used by the search service for
search results, the pharmacy list and detail, and by the notification service for the pharmacy name in a restock message). **Nothing is written.**
Remove the directory entry and the old names return.

Because the inventory underneath is synthetic, every directory identity is flagged `inventorySimulated: true` and the app shows, in addition to
"Demo directory listing — not a confirmed MedLink partner.", the separate notice **“Inventory shown is simulated and not confirmed by <name>.”** on result cards, the pharmacy list, the pharmacy page and map pop-ups.

**Limits of this approach**

* The fictional rows keep their old coordinates. They are never used for a pin, a distance, or directions of an unverified shop; only P004 has a verified point, and the app uses it
  (so search distances to P004 now measure to Hill Road). Server-side ranking still sorts the unverified shops by their internal demo point, so
  their position in a "nearest first" list is not meaningful, and the app shows "Distance not shown" for them.
* Persisted records (seed fixtures, the database, the simulator and portal consoles, logs) still say "Pharmacy A–E". The simulator and `demo:seed` print those names.
* Stored notification messages written before this change keep the old name.
* If you later onboard a shop for real, give it a new ID and database rather than reusing these.

## Accepted: 6 of 10 wanted

Of your 18 leads, **4 passed** (Paras, Roopam, Faiza, Mahavir Chemist). Two earlier candidates (Bandra Medical Stores, United Medical and General Stores)
complete the list. There is no accepted pharmacy in Powai/Chandivali, Kandivali, Dombivli or Dadar.

Your 18 research leads were checked first, then the earlier OpenStreetMap-based candidates. Each entry needs the shop to appear at the stated address in at least two independent sources, no sign of a chain, and a recorded provenance for every source (read directly, or only seen as a search snippet). Directories that copy OpenStreetMap do not count. Justdial returns 403 to automated reads and was not bypassed, so its facts are marked search-snippet.

Verified here means the shop was found at this address in two independent sources and shows no sign of being a chain. It does not mean the pharmacy is a partner, is open today, or holds a valid licence.

**Location rule.** A point is 'verified' when two independent map sources agree within 100 m, or, by the project owner's decision of 2026-10-30 (OpenStreetMap is the only map source used), when one OpenStreetMap pharmacy node whose name, category and address were re-read matches the listing; such an entry declares `"basis": "openstreetmap-node"`, and the validator accepts it only with an `osm-storefront-node` point within 100 m. P001 (Paras) and P003 (United) are verified this way. P002 (Roopam) and P005 (Faiza) have no OpenStreetMap record and stay unverified. Otherwise the observed points are kept as candidates and are never used for directions or distances; Google Maps directions then use the address. Neighbourhood-centre points are never recorded. Today **only 1 of 6** has a verified point (Bandra Medical Stores: an OpenStreetMap node and a
magicpin point agree to about 10 m). The others get directions by address and show no pin or distance. **P003's exact storefront is unverified**: only
"Chakala, Andheri East 400099" is shown, with no shop number.

## The directory

### P001 · Paras Medical and General Store — Andheri West

* **Shown as:** shown over the persisted demo pharmacy “Pharmacy A - Andheri West” (display only)
* **Address shown:** 35/D-2, Vaibhav CHS, SVP Nagar, Versova, Andheri West, Mumbai, Maharashtra 400053
* **As listed in sources:** plot 35, d/2, vaibhav soc s.v.p. ngr, near four banglow, andhari, Mumbai, Maharashtra, 400053 (GST registry); OpenStreetMap: 35, Vibhav Cooperative Housing Society
* **Location:** **single-source**, not used for pins, distances or directions. Observed: 19.13639, 72.82323 ([osm-storefront-node](https://www.openstreetmap.org/node/12317765975)). Directions use the verified address until a second map source confirms the point.
* **Confidence:** high · **Independent:** `established` · **Checked:** 2026-10-22
* **Independence evidence:** Registered for GST as a proprietorship (individually owned) with one place of business at this address, active since 13 Jul 2017 (record read directly; the owner's legal name is deliberately not recorded). No brand or operator tag on the OpenStreetMap node; no other outlet of this name found. Not a known chain or e-pharmacy.
* **Sources:**
  * [gst-registry](https://piceapp.com/gst-number-search/paras-medical-and-gen-stores-27adgpy8292f1zv/) — Existence as a registered retail business at plot 35, D/2, Vaibhav Soc, SVP Nagar, near Four Bungalows, Andheri 400053; proprietorship; active. *(directly)*
  * [openstreetmap](https://www.openstreetmap.org/node/12317765975) — A pharmacy named 'Paras Medical and General Store' at house number 35, Vibhav/Vaibhav CHS, K/W ward. *(directly (Nominatim API))*
  * [directory-derived-from-osm](https://www.latlong.net/poi/paras-medical-and-general-store-412329) — Repeats the OpenStreetMap record; not counted. *(search-snippet)*
* **Unresolved discrepancies:** Building spelled Vaibhav (GST) / Vibhav (OpenStreetMap). The earlier explurger.com listing cited for this shop turned out to be a different 'Paras Medical Store' (Bahrojpur) and was removed.

### P002 · Roopam Medical and General Stores — Andheri East

* **Shown as:** shown over the persisted demo pharmacy “Pharmacy B - Andheri East” (display only)
* **Address shown:** Shop 8, Shopping Centre, 18-A M.M. Road, Bhavani Nagar, Marol, Andheri East, Mumbai, Maharashtra 400059
* **As listed in sources:** 18-A, Shop No.8, Bhavani Shopping Centre, near Lucky Snacks and Sweets, Marol Maroshi Road, Andheri East 400059 (Justdial); Shop No. 8, Bhavani Nagar Shopping Centre, MM Road, Marol, near Seven Health Hospital, 400059 (Sulekha); Shop Number 8, Zenith Society, Bhawani Nagar Rd, Marol (magicpin)
* **Location:** **conflicting**, not used for pins, distances or directions. Observed: 19.119136, 72.880293 ([directory-directions-link](https://magicpin.in/Mumbai/Marol/Pharmacy/Roopam-Medical-And-General-Stores/store/293799)); 19.1178507, 72.8843856 ([directory-directions-link](https://www.sulekha.com/roopam-medical-andheri-east-mumbai-contact-address)). The two directory points disagree by about 450 m, so neither is used. Directions use the address.
* **Confidence:** medium · **Independent:** `single-outlet-evidence` · **Checked:** 2026-10-22
* **Independence evidence:** Listed as one outlet on Justdial (established 2008, search-reported), magicpin and Sulekha; none of the pages lists another branch. The name is shop-specific, not a known chain or e-pharmacy. Ownership not confirmed from a registry.
* **Sources:**
  * [directory](https://magicpin.in/Mumbai/Marol/Pharmacy/Roopam-Medical-And-General-Stores/store/293799) — Name, Shop 8 Zenith Society / Bhawani Nagar, Marol; hours 9 AM to 11 PM. *(directly)*
  * [directory](https://www.sulekha.com/roopam-medical-andheri-east-mumbai-contact-address) — Name, Shop No. 8, Bhavani Nagar Shopping Centre, MM Road, Marol, Andheri East 400059. *(directly)*
  * [directory](https://www.justdial.com/Mumbai/Roopam-Medical-General-Stores-Near-Lucky-Snacks-and-Sweets-Andheri-East/022PXX22-XX22-120127112357-U7X9_BZDET) — 18-A, Shop No.8, Bhavani Shopping Centre, Marol Maroshi Road, Andheri East; established 2008. *(search-snippet (Justdial returns 403 to automated reads))*
* **Unresolved discrepancies:** Building named Bhavani Nagar Shopping Centre / Bhavani Shopping Centre / Zenith Society across directories (shop 8 and 18-A M.M. Road agree). Directory map points disagree by about 450 m.

### P003 · United Medical and General Stores — Andheri East

* **Shown as:** shown over the persisted demo pharmacy “Pharmacy C - Juhu” (display only)
* **Address shown:** Chakala, Andheri East, Mumbai, Maharashtra 400099
* **As listed in sources:** Shop No.2, Chakala Road, Andheri East, Mumbai - 400099 (Next to Samraj Hotel) (Justdial, search-reported); Cardinal Gracias Road, Chakala Village (OpenStreetMap). The exact storefront is NOT established: no shop number or street is used as the address.
* **Location:** **single-source**, not used for pins, distances or directions. Observed: 19.11118, 72.85865 ([osm-storefront-node](https://www.openstreetmap.org/node/12317845292)). One map source only, and the street differs between sources. Directions use the address.
* **Confidence:** low · **Independent:** `single-outlet-evidence` · **Checked:** 2026-10-22
* **Independence evidence:** One outlet found on Justdial (established 1998, search-reported); no brand or operator tag on the OpenStreetMap node. Ownership not confirmed from a registry.
* **Sources:**
  * [openstreetmap](https://www.openstreetmap.org/node/12317845292) — A pharmacy of this name in Chakala Village, Andheri East. *(directly (Nominatim API))*
  * [directory](https://www.justdial.com/Mumbai/United-Medical-General-Stores-Next-to-Samraj-Hotel-Andheri-East/022P8125382_BZDET) — Shop No. 2, Chakala Road, Andheri East 400099; established 1998. *(search-snippet only (Justdial returns 403; never opened))*
* **Unresolved discrepancies:** Street differs (Cardinal Gracias Road vs Chakala Road next to Samraj Hotel); both are in Chakala. The second source was never opened.

### P004 · Bandra Medical Stores — Bandra West

* **Shown as:** shown over the persisted demo pharmacy “Pharmacy D - Bandra West” (display only)
* **Address shown:** Shop 139, Hill Road, near Union Bank of India, Bandra West, Mumbai, Maharashtra 400050
* **As listed in sources:** Shop No. 139, Hill Road, Near Union Bank of India, Bandra West, Mumbai - 400050 (Sulekha); Shop No.139, 60/B, Hill Road, Near Elco Shopping Center (magicpin)
* **Location:** **verified** 19.05548, 72.83152 (An OpenStreetMap node and a directory map point agree to about 10 m. The OpenStreetMap point is used.)
* **Confidence:** high · **Independent:** `single-outlet-evidence` · **Checked:** 2026-10-22
* **Independence evidence:** One outlet only across Sulekha, magicpin and Justdial; Justdial describes it as established 1950 (search-reported). No brand or operator tag on the OpenStreetMap node; not a known chain. Ownership not confirmed from a registry.
* **Sources:**
  * [directory](https://www.sulekha.com/bandra-medical-stores-bandra-west-mumbai-contact-address) — Shop No. 139, Hill Road, near Union Bank of India, Bandra West 400050; hours 8 AM to 10 PM. *(directly)*
  * [directory](https://magicpin.in/Mumbai/Bandra-West/Pharmacy/Bandra-Medical-Store/store/2528ab/) — Shop 139, 60/B, Hill Road near Elco Shopping Center, with a map point. *(directly)*
  * [openstreetmap](https://www.openstreetmap.org/node/4312909188) — A pharmacy of this name on Hill Road, with a map point. *(directly (Nominatim API))*
  * [directory](https://www.justdial.com/Mumbai/Bandra-Medical-Stores-Near-Union-Bank-Of-India-Bandra-West/022PGE04127_BZDET) — Near Union Bank of India, Bandra West; established 1950. *(search-snippet)*
* **Unresolved discrepancies:** Shop number given as 139 and 60/B (same shop, two numbering schemes). Opening hours differ between directories.

### P005 · Faiza Medical and General Stores — Bandra East

* **Shown as:** shown over the persisted demo pharmacy “Pharmacy E - Powai” (display only)
* **Address shown:** Shop 19, near Mina Centre, Ahmed Zakaria Nagar, Bandra East, Mumbai, Maharashtra 400051
* **As listed in sources:** Shop No.19, Next to Mina Centre Building, Ahmed Zakaria Compound, Ahmed Zakaria Nagar, Kherwadi (magicpin); same shop number and landmark, 400051 (Justdial, search-reported)
* **Location:** **single-source**, not used for pins, distances or directions. Observed: 19.056411, 72.843954 ([directory-directions-link](https://magicpin.in/Mumbai/Bandra-East/Pharmacy/Faiza-Medical-&-General-Stores/store/293a42/)). One directory point only. Directions use the address.
* **Confidence:** low · **Independent:** `single-outlet-evidence` · **Checked:** 2026-10-22
* **Independence evidence:** One outlet on magicpin and Justdial (established 2005, search-reported); the page lists no other branch. Ownership not confirmed from a registry.
* **Sources:**
  * [directory](https://magicpin.in/Mumbai/Bandra-East/Pharmacy/Faiza-Medical-&-General-Stores/store/293a42/) — Shop 19, next to Mina Centre, Ahmed Zakaria Nagar; hours 9 AM to midnight. *(directly)*
  * [directory](https://www.justdial.com/Mumbai/Faiza-Medical-And-Ganeral-Stores-Bandra-East/022PXX22-XX22-160923161044-Y3M9_BZDET) — Faiza Medical And Ganeral Stores, Bandra East; shop 19, Mina Centre; established 2005. *(search-snippet)*
* **Unresolved discrepancies:** A second Justdial listing of the same name gives Anant Kanekar Marg instead. Justdial's 'License Received' field reads 'No' (a directory field, not an official finding): check the drug licence before use. Justdial spells the name 'Ganeral'.

### P006 · Mahavir Chemist — Borivali West

* **Shown as:** new ID, inactive until its database is configured
* **Address shown:** Shops 7 and 8, I.C. Colony Road, opposite the post office / near I.C. Church, I.C. Colony, Borivali West, Mumbai 400103
* **As listed in sources:** Ludovic Mansion Building, Shop No. 7/8, IC Colony, Near IC Church, 400103 (Sulekha); Shop No 7 & 8, The Palazzo Building, IC Colony Road (magicpin); Ludovic/Palazzo, opposite Post Office (Justdial, search-reported)
* **Location:** **single-source**, not used for pins, distances or directions. Observed: 19.2447426, 72.8515683 ([directory-directions-link](https://magicpin.in/Mumbai/Borivali-West/Pharmacy/Mahavir-Chemist/store/409649/)). One directory point only. Directions use the address.
* **Confidence:** medium · **Independent:** `single-outlet-evidence` · **Checked:** 2026-10-22
* **Independence evidence:** One outlet on Sulekha, magicpin and Justdial (established 1984, search-reported); none lists another branch. A separate 'Shree Mahavir Chemist' exists elsewhere (Mahavir Nagar) and is a different listing. Ownership not confirmed from a registry.
* **Sources:**
  * [directory](https://www.sulekha.com/mahavir-chemist-borivali-west-mumbai-contact-address) — Shop 7/8, Ludovic Mansion, IC Colony, near IC Church, Borivali West 400103. *(directly)*
  * [directory](https://magicpin.in/Mumbai/Borivali-West/Pharmacy/Mahavir-Chemist/store/409649/) — Shop 7 & 8, The Palazzo Building, IC Colony Road. *(directly)*
  * [directory](https://www.justdial.com/Mumbai/Mahavir-Chemist-Opposite-Post-Office-Ic-Colony-Borivali-West/022P1006368_BZDET) — Opposite Post Office, IC Colony; established 1984. *(search-snippet)*
* **Unresolved discrepancies:** Building named Ludovic Mansion (your lead, Sulekha) and The Palazzo (magicpin, Justdial); shop numbers agree. Opening hours differ between directories.

## Excluded (chains and online-first businesses)

| Name | Why |
|---|---|
| Apollo Pharmacy (all branches) | National chain. |
| Tata 1mg Pharmacy (Kastur Park, Borivali West) | Tata 1mg: chain and online-first retailer. |
| Zeno Health Pharmacy (Parasmani Tower, Dadar East) | National chain. |
| Noble Plus / Noble Chemist / Noble Medicals | Multi-branch Mumbai chain (more than ten OpenStreetMap branches across the target areas). This includes the 'Noble Medicals' example you suggested. |
| Wellness Forever | National chain. |
| MG365, MedPlus, Lifecare, Shoppers Drug Mart, Generic Medicine Pharmacy | Chains or branded generic-medicine networks. |
| SuperDoc Medical | The same name appears at two outlets (Andheri East and Kherwadi) in OpenStreetMap: multi-branch. |
| Jan Aushadhi Kendras | A government franchise network, not independent neighbourhood chemists. |
| Dava India / Davaindia franchise stores (e.g. Jay Maharashtra Medical) | Branded generic-medicine franchise chain. |
| Noble Plus / Noble Chemist / Noble Medicals in Andheri East, Chandivali and Powai | Multi-branch chain. |

## Your leads and earlier suggestions that did not pass

| Name | Result |
|---|---|
| Noble Medicals, Andheri East | Only the Noble Plus chain was found; excluded as a chain. |
| Liberty Medical & Super Market, Bandra West | No listing found. 'New Liberty Drug Corner' (Khar) and 'New Liberty Pharmacy' exist but were not confirmed to be the same business. |
| New Grace Medical and General Stores, Chandivali | No listing found. |
| Krishna Medical and General Stores, Borivali West | Only a trade listing in Kandar Pada (Dahisar side); several unrelated 'Krishna Medical' stores exist. |

## Unresolved: not in the directory

| Candidate | Area | Why |
|---|---|---|
| Arihant Chemist & Druggist (Gharkul Society, Sangeetkar N. Dutta Marg, Andheri West) | Andheri West | No listing at this address. Sulekha has an Arihant Chemist & Druggist in Andheri (400069) with no street, and Justdial one on Eksar Road, Borivali West: different or unplaced outlets, so the name alone is not evidence. |
| Annpurna Medical and General Store (Jijamata Road, Parsi Colony, Andheri East) | Andheri East | No Andheri East listing found; the Annapurna stores found are in Malvani and other cities. |
| Sangam Medical Stores and Distributors (Gundawali, Andheri East) | Andheri East | Not found at Gundawali. Other 'Sangam' businesses exist in Chakala and on Mahakali Caves Road; none matches the address. |
| Rajesh Medical and General Store (Saki Vihar Road, Chandivali) | Chandivali | No listing found. |
| New Grace Medical and General Stores / New Grace Medical Store (Sun Grace Building, Raheja Vihar, Chandivali) | Chandivali | Exists on one directory only (magicpin: Shop No 6, Sun Grace Building, with a map point 19.1167334, 72.8949829; the listing is old). No second source, no ownership evidence. |
| Get Well Chemists (Linking Road, Bandra West) | Bandra West | Justdial marks 'Get Well Chemist' at Plot 269/A, Linking Road as Closed Down; Sulekha and magicpin still list it at Link Square Mall, not near a petrol pump. |
| Bombay Medical and General Stores (National Library Road, Bandra West) | Bandra West | Justdial (44/2, near Akbar Academy, est. 1999) and Sulekha (Shop 2, NL Road) agree on the road but not the shop number, and magicpin lists a separate 'Bombay Medical' in Gandhi Nagar, so a second outlet of the same name may exist. |
| SSA / Shree Siddh Ambica Medical and General Stores (Vini Classic, Kandivali West) | Kandivali West | One directory (magicpin) and it marks the outlet as shut down. |
| Medicentre Medical & General Stores (Kandivali West) | Kandivali West | Only a Sulekha description without an address; Rashmi Enclave / Makecha School not found. |
| Sahakar Medical (Hanuman Nagar, Kandivali East) | Kandivali East | No listing found. |
| Golden Pharmacy (Shrinivas Society, Patharli Road, Dombivli East) | Dombivli East | One directory (Justdial, two pages of the same listing); no second source. Also outside Mumbai city. |
| Jay Maharashtra Medical (Parshwabhakti, Dombivli East) | Dombivli East | The magicpin listing is titled 'Jay Maharashtra Medical | Davaindia | Generic Pharmacy', a franchise of the Dava India chain: excluded as a chain. |
| Shree Laxmi Medical and General Store (Dawadi Gaon Road, Dombivli East) | Dombivli East | No listing found; same-named stores exist in Pune and Mumbra. |
| Jai Gurudev Pharmacy and General Store (Manpada Road, Sagaon, Dombivli East) | Dombivli East | Only a magicpin page whose address is in Kilpauk, Chennai. |
| Leelavati Medical | Bandra West (Hill Road) | Justdial (Shop 5, Rizvi Chambers No. 13, Hill Road) and magicpin ('Leelavati Medical Chemist Shop', Bal Krishna Jyot A-222) give different addresses, so it may be two outlets. OSM node exists (19.05476, 72.83648). |
| Solanki Medical (Shop / Stores) | Bandra West (Pali) | Several Solanki listings (shop 56/B vs 14/B Dheeraj Arcade, a separate Nutan Nagar one): possible multiple outlets, conflicting shop numbers. |
| Mount Medical Store | Bandra West | Only one non-OpenStreetMap source (magicpin, 4 Lilly Villa, St John Baptist Road); ownership not established. |
| Metro Medicals / Metro Medical | Bandra West | OpenStreetMap places it on 4th Road, Khar; Justdial and Sulekha place 'Metro Medical' at Rizvi Mahal, Waterfield Road. Location conflict. |
| Mamta Medical and General Store | Bandra West (Chapel Road) | The only corroboration is a directory derived from OpenStreetMap; a Justdial entry says 'opposite Lilavati'. GST records show other Mamta stores (Mahim West, Powai, Thane): ownership and location unclear. |
| Al Medica | Bandra West (Chapel Road) | Only an OpenStreetMap-derived directory; no independent source. |
| Johnson Medical and General Store (OpenStreetMap: 'Jhonson Medical') | Powai | Justdial text says 'next to Dr L H Hiranandani Hospital, opposite IIT main gate' (Fiji GL Complex), which does not obviously match the OpenStreetMap node on Powai Road; spelling differs; page not readable. |
| Ashwin Medical and General Stores | Powai (Central Avenue, Hiranandani Gardens) | Justdial listing seen only as photo captions; the OpenStreetMap node is duplicated; no ownership evidence. |
| Ambaji Medicals / Ambaji Medical Surgical & Ayurvedic | Powai | Two listings at two addresses (Galleria shop 78; Cypress CHS): possibly two outlets. |
| Adie Pharmacy | Dadar East | Strong location evidence (OSM + Justdial + magicpin + Sulekha), but listings show more than one outlet or entity ('Adie Chemist', 'Adie Enterprises'): independence not established. |
| Sai Krupa chemist / Saairam Medical | Dadar East (Dr Ambedkar Marg) | OpenStreetMap only; a magicpin entry lacks a street number; no corroboration of the specific shop. |
| Shastri Medical | Andheri East (Sahar Road) | Justdial lists a 'Shastri Medical (Closed Down)' at the same address. |
| Ashirwad Medical | Andheri East (M C Chagla Road) | magicpin says the outlet has shut down; Sulekha still lists it. |
| Esswell Pharma | Bandra East | The directory entry found ('Esswell Pharma Plus') is an ayurvedic shop in Dadar East; the Bandra East node could not be corroborated. |
| Gajanand Pharmacy, Apple Medical, Vora Medico, Krishnam | Bandra East / Andheri East | On OpenStreetMap only; no corroborating listing found. |
| Welcome Medical & General Stores / Bafna Medical and General Stores | Juhu (Andheri West ward) | Two OpenStreetMap nodes at the same point; directories give a different road (Fatima Palace Road); Juhu rather than Andheri West. |
| Pratik Medical | Andheri East (Sahar Road, Koldongri) | One directory (yappe.in) gives an address, but there is no OpenStreetMap node or other source, hence no storefront coordinates. |
| Shree Gajanan Prasad Medico / Medical & General Store (Shivhara, Kasturba Cross Road No. 2, opposite BMC Hospital, Borivali East) | Borivali East | Three directories (Justdial, Sulekha, magicpin) agree on the shop and building, but magicpin labels the area Dattapada (Borivali West), and a 'Shree Gajanan Prasad Chemist and General Stores' sits at Ambamata Chowk, so a multi-outlet business cannot be ruled out. No independent map point. |
| Archana Medical & General Stores (Panch Kutir, Ganesh Nagar, Ad Marg, Powai) | Powai | Exists on magicpin (with a map point 19.123182, 72.909151) and Justdial/Sulekha give only the area; no street-level second source, so the point is a single-source candidate. |
| Harsha Chemist & General Stores (Pundalik Building, Villa Hare Krishna Road, Powai) | Powai | Justdial snippet only; Sulekha lists the area without a street. |
| Shushrusha Medical (Hendre Castle, Gokhale Road, Dadar West) | Dadar West | Sulekha only; a Justdial snippet names a different shop (Mahavir Medical) near the hospital. |
| Millennium Chemist (Deewan Prakash Building, Sir Balchandra Road, Dadar East) | Dadar East | Sulekha lists it, but Justdial marks a Millennium Chemist in Hindu Colony as Closed Down; unclear whether it is the same shop. |
| Kubal Pharmacy (Bhanupadma, R. K. Vaidya Marg, Dadar West) | Dadar West | Justdial snippet and a Sulekha area entry without a street; no second street-level source. |
| Sheshadri Chemist, Parkway Chemist (Dadar East; Borivali East) | Dadar East / Borivali East | Area-level Sulekha listings only: no street address. |

## Candidate leads (not accepted; directory only)

`candidates` in `mumbai-demo.json` holds the leads that did not pass. They are **not** pharmacies: they have no row, database, registration, inventory or demo stock, they can never carry a verified point (`validateCandidate` rejects one), and they are not in `knownPharmacies`, `activePharmacies` or the seeder. Their IDs (P007 and up) are never reused. `GET /api/directory` returns them with no coordinates, and the Pharmacies page lists them under "Directory listings: no inventory" with the demo label. Excluded leads are only counted.

Directions: **address** for a provisional lead with a complete address; **approximate** for a needs-review lead with a complete address (an unconfirmed lead, labelled as such); **unavailable** when the address is incomplete (no shop, building or road) and for excluded leads. No lead gets a pin or a distance. Of your 18 addresses, Roopam (P002), Bandra Medical Stores (P004), Faiza (P005) and Mahavir Chemist (P006) are the accepted entries above; none of the other 14 passed. Evidence is as of 2026-10-22; source URLs are only those actually seen, and Justdial facts are search snippets.

### Provisional (found in one source)

| ID | Name | Address as supplied | Why / evidence | Sources |
|---|---|---|---|---|
| P011 | New Grace Medical and General Stores | Shop 6, Sungrace Society, Circular Road, Raheja Vihar, Chandivali, Mumbai 400072 | Found on one directory only (magicpin: Shop No 6, Sun Grace Building, Raheja Vihar; the listing is old). The society is spelled 'Sungrace' in the supplied address and 'Sun Grace' by magicpin. No second source and no ownership evidence, so it is not accepted. Observed point (single source, never used): 19.1167334, 72.8949829. | [directory](https://magicpin.in/Mumbai/Raheja-Vihar/Pharmacy/New-Grace-Medical-Store/store/4910c8/) (directly) |
| P018 | Golden Pharmacy | Shop 2, Srinivas CHS, Patharli Road, near Matoshree Lunch Home, Gograswadi, Dombivli East, Maharashtra 421201 | Found on one directory only (Justdial, seen as a search snippet; the society is spelled 'Shrinivas' there). No second source. Dombivli is also outside Mumbai city. | [directory](https://www.justdial.com/Thane/Golden-Pharmacy-Near-Matoshree-Lunch-Home-Grograswadi-Dombivli-East-Dombivli-East/022PXX22-XX22-220919172100-K7N3_BZDET) (search-snippet) |

### Needs review (not found, conflicting or incomplete)

| ID | Name | Address as supplied | Why / evidence | Sources |
|---|---|---|---|---|
| P007 | Arihant Chemist & Druggist | D-1, Sangeetkar N. Dutta Marg, Gharkul Society, Indira Nagar, Andheri West, Mumbai 400053 | No listing at this address. Sulekha lists an Arihant Chemist & Druggist in Andheri (400069) with no street, and Justdial one on Eksar Road, Borivali West: different or unplaced outlets, so the name alone is not evidence. | none |
| P008 | Annpurna Medical and General Store | Jijamata Road, Parsi Colony, Andheri East, Mumbai 400093 | No Andheri East listing found; the Annapurna stores found are in Malvani and other cities. No shop number was supplied. | none |
| P009 | Sangam Medical Stores and Distributors | Shop 9, Prathmesh Apartment, Gundawali Azad Road, Andheri East, Mumbai 400069 | Not found at Gundawali. Other 'Sangam' businesses exist in Chakala and on Mahakali Caves Road; none matches the address. | none |
| P010 | Rajesh Medical and General Store | Shop 7, Saraswati Pawar Chawl, Saki Vihar Road, near Oxford Chambers, Chandivali/Powai, Mumbai 400072 | Searched on 2026-10-22; no listing for this shop at this address was found. The address is exactly as supplied and unconfirmed. | none |
| P012 | Cure Chemist Medical | Shop 16, Building 12, MHADA Colony, near DMart, Chandivali/Powai, Mumbai 400072 | Searched on 2026-10-22; no listing for this shop at this address was found. The address is exactly as supplied and unconfirmed. | none |
| P013 | Dharamnath Chemist | Gumpha Darshan C CHS, Asara Colony Road, opposite Shri Gaon Devi Temple, Borivali East, Mumbai 400066 | The building (Gumpha Darshan, Borivali East) exists in property listings, but no pharmacy listing for this name was found. No shop number was supplied. | none |
| P014 | Medicentre Medical & General Stores | Shop 2, Rashmi Enclave of Dattani CHS, near Makecha School, Kandivali West, Mumbai 400067 | Only a Sulekha description without an address was seen (its URL was not kept); Rashmi Enclave / Makecha School could not be matched to it. | none |
| P015 | K.D. Chemist & General Store | A/2, Yadav Chawl, Akurli Road, Damu Nagar, Kandivali East, Mumbai 400101 | Searched on 2026-10-22; no listing for this shop at this address was found. The address is exactly as supplied and unconfirmed. | none |
| P016 | All India Drug House | Shop 2, Dalvi Hospital Building, Dr. Dalvi Road, Jethava Nagar, Kandivali West, Mumbai 400067 | Searched on 2026-10-22; no listing for this shop at this address was found. The address is exactly as supplied and unconfirmed. | none |
| P017 | Sahakar Medical | Hanuman Nagar, Kandivali East, Mumbai 400101 | No listing found, and the supplied address has no shop, building or road, so no directions are offered. | none |
| P019 | Shree Laxmi Medical and General Store | Shop 5, Shree Sai Building, Dawadi Gaon Road, near Dawdi Hospital, Sonar Pada, Dombivli East, Maharashtra 421203 | No listing found; same-named stores exist in Pune and Mumbra. | none |

### Excluded

| ID | Name | Address as supplied | Why / evidence | Sources |
|---|---|---|---|---|
| P020 | Zeelab Pharmacy | Shop 1, Shantiniketan Building, Kopar Road, near Shastri Nagar Hospital, Dombivli West, Maharashtra 421202 | Zeelab Pharmacy is a generic-medicine chain with hundreds of company-owned and franchise stores, so this outlet is not an independent pharmacy. No listing for this specific outlet was found. | [press](https://www.biospectrumindia.com/features/20/28170/startup-of-the-day-12-zeelab-pharmacy-.html) (search-snippet), [press](https://entrackr.com/snippets/otp-ventures-leads-24-mn-round-in-zeelab-pharmacy-8643423) (search-snippet) |

## Google Maps directions

Every pharmacy card, the list, the pharmacy page and the map pop-up show **Get Directions**; the page and pop-up also show **View on Google Maps**. Plain links in a new tab
(`target="_blank" rel="noopener noreferrer"`), no API key or SDK.

* `https://www.google.com/maps/dir/?api=1&destination=LAT,LNG` uses the pharmacy's **verified** point (only P004).
* Otherwise the destination is the percent-encoded **verified address** shown for that pharmacy. An unverified point is never used.
* `origin=` is added only when the user chose or saved a location; otherwise Google Maps starts from the user's current location. MedLink requests and stores nothing to open directions.

Code: `apps/web/src/lib/maps.ts`, `components/pharmacies/DirectionsActions.tsx`.

## Demo inventory for directory pharmacies (P006 and up)

Nothing is seeded for a directory pharmacy by default. `npm run demo:seed` targets P001 to P005 only, even if a `PHARMACY_P006_DATABASE_URL` happens to be set. To give a directory pharmacy synthetic stock, two explicit steps, both dry-run by default and both refused unless the environment is local development or test (no production host or database name):

1. `npm run demo:directory-setup -- P006 [--write]` applies the pharmacy schema and records the profile in that pharmacy's own database. **No stock and no outbox event** are created: it starts empty. The role and database must already exist (provisioning is a separate approval).
2. `npm run demo:seed -- --include-directory=P006 [--write]` adds synthetic rows through the normal inventory path (pharmacy database, outbox, connector, Redis Streams, sync). It refuses a database that is not set up for that code or already holds any stock this seed did not write, never updates or deletes, and a second run adds nothing.

Search and the app label the inventory as simulated and the listing as a demo entry. Central search only shows the pharmacy after it is registered (`npm run demo:register`, also dry-run by default and a separate approval); until then the sync service logs each event as not mirrored rather than reporting success.

**A listing-only state** (a directory pharmacy visible with no database and no verified point) would need `pharmacies.latitude/longitude` to become nullable: a schema migration. It has not been made; ask before doing it.

## Activating P006 or onboarding a shop for real (nothing has been done)

1. Verify Mahavir Chemist's point with a second map source and settle its building (Ludovic Mansion or The Palazzo).
2. Provision a role and database, set `PHARMACY_P006_DATABASE_URL` in `.env` only, run the pharmacy migrations with an empty start.
3. `npm run demo:register` (dry run first): it refuses an unverified point.
4. Make the connector, simulator and `pharmacies:*` commands use the configured list instead of a fixed five.

## Before relying on any entry

1. Open the Justdial pages yourself (automated reads got 403 and were not bypassed). P003's second source was never opened.
2. Confirm each shop is open at that frontage and check its drug licence (Faiza's Justdial listing says "License Received: No"; Faiza is low confidence).
3. Decide whether you are comfortable showing real shop names in a demo, and ask permission or use fictional names outside your team.
4. Verify ownership on the official GST or licence portal where it is `single-outlet-evidence`.
