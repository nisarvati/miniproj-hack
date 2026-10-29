/**
 * The product truth shared by all five landing directions. Directions change how this is presented, never what it
 * claims. Nothing here promises stock, speed, coverage or accuracy: see PRODUCT.md for the claims we can support.
 */

export const PRIMARY_CTA = "Find a Medicine";
export const SECONDARY_CTA = "Explore How It Works";

/** The medicine the availability section searches for. It exists in the seed data. */
export const SAMPLE_QUERY = "Paracetamol";

export const IDS = {
  main: "main-content",
  search: "search",
  how: "how-it-works",
  availability: "availability",
  network: "network",
  staff: "for-pharmacies",
  trust: "trust",
  find: "find-a-medicine",
} as const;

/** Only routes that exist in the app, plus anchors on the landing page itself. */
export const ROUTES = {
  app: "/search",
  pharmacies: "/pharmacies",
  notifications: "/notifications",
  portal: "/portal",
} as const;

export const HERO_DECK =
  "MedLink shows which nearby pharmacies list a medicine, what it costs, how far away it is and how recently each pharmacy's stock changed, so you can choose where to go before you travel.";

export const STEPS = [
  { title: "Search for a medicine", body: "Type a brand or generic name, such as Crocin 500mg or Paracetamol." },
  { title: "Compare nearby pharmacies", body: "Matching results come from participating pharmacies and are ranked by availability, distance and price." },
  { title: "Read the details", body: "Each result shows its stock status, its price and its distance, and says how recent that stock information is." },
  { title: "Verify, then go", body: "Stock and prices change. Call the pharmacy to confirm before you make the trip." },
] as const;

export const INDEPENDENT = {
  lead: "Each pharmacy keeps its own records. MedLink makes them searchable.",
  body: [
    "Participating pharmacies keep their own database, and that database remains the source of truth for their stock. When a pharmacy records a change, it is passed along to MedLink so the change can appear in search.",
    "That takes a short while, so search is not instant. MedLink only shows pharmacies that take part. It does not cover every pharmacy in a city.",
  ],
  /** The path a change takes, in plain words. Used by each direction's own diagram. */
  path: ["Pharmacy records a change", "Change is sent on", "MedLink updates its search view", "You see it in results"],
} as const;

/** The technical story (see docs/redis-streams.md), in words a patient can follow. Never states speed, scale or coverage. */
export const PIPELINE = {
  eyebrow: "Under the surface",
  title: "Independent pharmacies. One searchable picture.",
  lead: "Each participating pharmacy retains control of its own database. MedLink processes inventory updates through an event-driven pipeline to make availability searchable across the network.",
  plain: "In plain words: when a pharmacy records a change, the change is passed along, checked, and added to a shared picture that search reads from.",
  stages: [
    { title: "Each pharmacy's own database", body: "Stock lives with the pharmacy, which stays in control of it. A sale, a restock or a new price is recorded there first.", note: "Authoritative · P00x" },
    { title: "A change becomes an event", body: "The change is saved together with a note to pass it on, then sent as a small message on that pharmacy's own channel.", note: "Outbox → connector → one stream per pharmacy" },
    { title: "Synchronisation", body: "MedLink checks each message, ignores repeats, and keeps the newest information when messages arrive out of order.", note: "Validate · de-duplicate · order by event time" },
    { title: "Searchable inventory state", body: "The current picture of what each participating pharmacy lists, kept ready for search.", note: "Current state per pharmacy and medicine" },
    { title: "Medicine discovery", body: "Search combines that picture with the medicine catalogue. Each result says whether it is live or last known, and how old it is.", note: "Live or last known · with its age" },
  ],
  figure: "Illustrative schematic.",
  footnote:
    "It simplifies the real system, and the pharmacy labels are placeholders, not live readings. A change takes a short while to appear, so search is not instant. Only participating pharmacies are included. If the live picture is unavailable, search shows last known values and says so.",
} as const;

/** Who holds what: the ownership statement of the light "independent pharmacies" section. */
export const OWNERSHIP = [
  { label: "Records kept by", value: "The pharmacy, in its own database" },
  { label: "Shown in search", value: "What participating pharmacies report" },
  { label: "Confirmed by", value: "You, with a call before you travel" },
] as const;

export const STAFF = {
  lead: "Pharmacy staff keep their own shelf accurate.",
  body: "Staff at participating pharmacies sign in to the portal to update their own pharmacy's stock: the quantity on the shelf, a price, or whether a medicine is listed at all. Changes are written to the pharmacy's own system first.",
  cta: "Open the pharmacy portal",
} as const;

export const LIMITATIONS = [
  "MedLink helps you discover where a medicine is available. It does not sell or dispense medicines.",
  "It does not diagnose conditions, prescribe treatments or tell you what to take. Ask a pharmacist or doctor.",
  "Stock and prices can change after you look. Call the pharmacy to confirm before you travel.",
  "Every result says whether its stock is live from the pharmacy or the last known value, and when it was last updated.",
] as const;

export const NAV_LINKS = [
  { href: `#${IDS.how}`, label: "How It Works" },
  { href: `#${IDS.staff}`, label: "For Pharmacies" },
  { href: ROUTES.portal, label: "Portal" },
] as const;

export const FOOTER_LINKS = [
  { href: `#${IDS.how}`, label: "How It Works" },
  { href: `#${IDS.staff}`, label: "For Pharmacies" },
  { href: ROUTES.portal, label: "Pharmacy portal" },
  { href: ROUTES.pharmacies, label: "Pharmacies" },
  { href: ROUTES.notifications, label: "Restock alerts" },
] as const;

export const FOOTER_NOTE = "MedLink does not sell medicines or give medical advice. Stock and prices can change; call the pharmacy before you travel.";
