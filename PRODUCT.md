# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Patients and caregivers are the primary users. They need a specific medicine and want to know which nearby pharmacy has it before making a trip. Pharmacy staff are secondary users who keep their own pharmacy's inventory current through the staff portal.

## Product Purpose

MedLink helps people find a suitable source for a medicine by comparing nearby availability, price, distance, stock confidence, and freshness. Success means a person can make an actionable choice and avoid wasted visits to pharmacies that do not have the medicine.

Useful success measures include relevant available search results, time to identify an option, agreement between displayed and actual inventory, trips avoided, and whether users find an option within their price and distance preferences. The north-star outcome is more searches leading to a suitable source with minimal effort; these are measures to assess, not claims of current measured performance.

## Positioning

MedLink is a medicine discovery and availability platform, not an online pharmacy. It makes pharmacy-owned stock discoverable while each pharmacy retains control of its own inventory system. The searchable view is synchronized data, not a replacement source of truth.

## Operating Context

Patients search by medicine and compare nearby pharmacies, then visit or contact a selected pharmacy. Search supports list and map views, filters, sorting, directions, pharmacy details, and restock alerts. Pharmacy staff sign in to update stock in their pharmacy's database; the established outbox and event pipeline carries changes to search and notifications.

## Capabilities and Constraints

- Search results include medicine and formulation details, pharmacy, distance, price, quantity/status, and freshness. Results distinguish live stock from last-known catalogue data; inventory is eventually consistent, and stock and prices may change.
- The documented catalogue exposes medicine name, strength, and form. Patients need to compare pack size too, but pack-size support is not established by the current API or catalogue; do not promise it until represented in the data.
- Restock alerts appear in the application's notification system. External email delivery is not guaranteed unless explicitly configured and enabled. Patient identity for alerts currently uses an email address; there is no documented patient sign-in.
- MedLink does not sell or dispense medicines, manage prescriptions, or provide medical advice. Availability and pricing are informational; users may need to confirm with the pharmacy.
- Pharmacy inventory remains authoritative in each pharmacy's local database. Preserve existing API, event, synchronization, and pharmacy-isolation contracts.

## Brand Commitments

The user wants MedLink to feel human-crafted, attractive, calm, and easy on the eyes, with a restrained palette. Keep the established warm stone, white, charcoal, and pine-teal identity; use distinct semantic colors for stock and warning states.

## Evidence on Hand

The repository contains the web app, search and pharmacy APIs, pharmacy portal, simulator, and implementation documentation in `docs/`. These support local development and functional demonstrations. No customer testimonials, independent inventory-accuracy study, or measured success metrics are documented; do not fabricate them or imply guaranteed availability.

## Product Principles

- Help people choose where to obtain a medicine before travelling.
- Make availability, price, distance, and data freshness understandable together.
- Keep pharmacy inventory ownership local and synchronization within established service boundaries.
- Be clear about stale or unavailable data and avoid clinical or availability guarantees.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Support keyboard use, visible focus, assistive technology, reduced motion, dark mode, and responsive layouts from narrow mobile screens through zoomed views.
