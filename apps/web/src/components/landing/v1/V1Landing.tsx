import Link from "next/link";
import { AvailabilitySample } from "../shared/AvailabilitySample";
import { FOOTER_LINKS, FOOTER_NOTE, HERO_DECK, IDS, INDEPENDENT, LIMITATIONS, NAV_LINKS, OWNERSHIP, PRIMARY_CTA, ROUTES, SECONDARY_CTA, STAFF, STEPS } from "../shared/content";
import controls from "../shared/controls.module.css";
import { LandingSearch } from "../shared/LandingSearch";
import { Contours } from "./Contours";
import { LandingAuthLink } from "./LandingAuthLink";
import { HeroMap } from "./heromap/HeroMap";
import { display, mono } from "./fonts";
import { Pipeline } from "./Pipeline";
import s from "./v1.module.css";

/**
 * The primary landing direction: print-tech paper. An ivory sheet, oversized grotesk, mono marginalia and one
 * healthcare-green accent carry the whole page, including the technical plate ("Under the surface") on the same paper.
 */
export function V1Landing() {
  return (
    <div className={`${display.variable} ${mono.variable} ${s.page}`}>
      <a className={s.skip} href={`#${IDS.main}`}>
        Skip to content
      </a>

      <header className={s.header}>
        <Link href="/" className={s.mark} aria-label="MedLink home">
          MedLink<span aria-hidden="true">®</span>
        </Link>
        <nav aria-label="Main" className={s.nav}>
          {NAV_LINKS.map((l) => (
            <a key={l.label} href={l.href}>
              {l.label}
            </a>
          ))}
          <LandingAuthLink />
          <a href={`#${IDS.search}`} className={s.navCta}>
            {PRIMARY_CTA}
          </a>
        </nav>
      </header>

      <main id={IDS.main}>
        {/* 1 · Hero */}
        <section className={s.hero} aria-labelledby="v1-title">
          <p className={`${s.meta} ${s.heroMeta}`} aria-hidden="true">
            <span>Plate I · Medicine availability</span>
            <span>Participating pharmacies only</span>
            <span>Confirm before you travel</span>
          </p>
          <div className={s.heroText}>
            <p className={s.kicker}>Fig. 01 · Medicine availability across independent pharmacies</p>
            <h1 id="v1-title" className={s.title}>
              <span>Find your</span> <span className={s.accent}>medicine.</span> <span>Know where</span> <span>to look.</span>
            </h1>
            <p className={s.deck}>{HERO_DECK}</p>
            <div id={IDS.search} className={`${controls.search} ${s.search}`}>
              <LandingSearch visibleLabel label="Search a medicine" placeholder="e.g. Crocin 500mg" />
            </div>
            <a href={`#${IDS.how}`} className={s.secondary}>
              {SECONDARY_CTA} <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className={s.heroArt}>
            <HeroMap className={s.slot} captionClassName={`${s.meta} ${s.figCap}`} />
          </div>
        </section>

        {/* 2 · How it works */}
        <section id={IDS.how} className={`${s.section} ${s.how}`} aria-labelledby="v1-how">
          <Contours className={s.contoursHow} />
          <p className={s.sectionTag}>
            <span>01</span> Method
          </p>
          <h2 id="v1-how" className={s.h2}>
            How it works
          </h2>
          <ol className={s.steps}>
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className={s.stepNo} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* 3 · Availability */}
        <section id={IDS.availability} className={`${s.section} ${s.availability}`} aria-labelledby="v1-avail">
          <p className={s.sectionTag}>
            <span>02</span> Ledger
          </p>
          <h2 id="v1-avail" className={s.h2}>
            Pharmacies, side by side
          </h2>
          <p className={s.lede}>One search, the same facts for each pharmacy: what it reports, what it costs, how far it is and how old the information is.</p>
          <p className={s.guide}>
            <span><b className={s.gOk} aria-hidden="true">●</b> In stock</span>
            <span><b className={s.gLow} aria-hidden="true">◐</b> Low stock</span>
            <span><b className={s.gOut} aria-hidden="true">○</b> Out of stock</span>
            <span>Live: reported by the pharmacy&apos;s own system</span>
            <span>Last known: an older value held by MedLink</span>
          </p>
          <div className={`${controls.avail} ${s.avail}`}>
            <AvailabilitySample />
          </div>
        </section>

        {/* 4 · Independent pharmacies: who owns the records */}
        <section id={IDS.network} className={`${s.section} ${s.ownership}`} aria-labelledby="v1-net">
          <p className={s.sectionTag}>
            <span>03</span> Ownership
          </p>
          <h2 id="v1-net" className={s.h2}>
            {INDEPENDENT.lead}
          </h2>
          <div className={s.ownCopy}>
            {INDEPENDENT.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          <dl className={s.own}>
            {OWNERSHIP.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* 5 · The technical plate, on the same paper, introduced by a printed cut line */}
        <p className={s.cut} aria-hidden="true">
          <span>Plate II</span>
          <span>Under the surface</span>
        </p>
        <Pipeline />

        {/* 6 · Pharmacy staff */}
        <section id={IDS.staff} className={`${s.section} ${s.staff}`} aria-labelledby="v1-staff">
          <p className={s.sectionTag}>
            <span>04</span> Staff
          </p>
          <h2 id="v1-staff" className={s.h2}>
            {STAFF.lead}
          </h2>
          <div>
            <p>{STAFF.body}</p>
            <Link href={ROUTES.portal} className={s.textLink}>
              {STAFF.cta} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>

        {/* 7 · Trust and limitations */}
        <section id={IDS.trust} className={s.section} aria-labelledby="v1-trust">
          <p className={s.sectionTag}>
            <span>05</span> Limits
          </p>
          <h2 id="v1-trust" className={s.h2}>
            What MedLink is, and is not
          </h2>
          <ul className={s.limits}>
            {LIMITATIONS.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>

        {/* 8 · Final conversion */}
        <section id={IDS.find} className={s.final} aria-labelledby="v1-final">
          <Contours className={s.contoursFinal} rings={7} />
          <p className={s.sectionTag}>
            <span>06</span> Colophon
          </p>
          <h2 id="v1-final" className={s.finalTitle}>
            Find your medicine.
          </h2>
          <div className={`${controls.search} ${s.search} ${s.finalSearch}`}>
            <LandingSearch visibleLabel label="Search a medicine" />
          </div>
          <p className={s.finalNote}>Stock and prices change. Call the pharmacy to confirm before you travel.</p>
        </section>
      </main>

      <footer className={s.footer}>
        <p>{FOOTER_NOTE}</p>
        <ul>
          {FOOTER_LINKS.map((l) => (
            <li key={l.label}>{l.href.startsWith("#") ? <a href={l.href}>{l.label}</a> : <Link href={l.href}>{l.label}</Link>}</li>
          ))}
        </ul>
        <p className={s.meta}>MedLink · Medicine availability across independent pharmacies</p>
      </footer>
    </div>
  );
}
