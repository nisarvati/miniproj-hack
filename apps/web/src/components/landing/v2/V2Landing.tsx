import Link from "next/link";
import { AvailabilitySample } from "../shared/AvailabilitySample";
import { FOOTER_LINKS, FOOTER_NOTE, HERO_DECK, IDS, INDEPENDENT, LIMITATIONS, NAV_LINKS, PRIMARY_CTA, ROUTES, SECONDARY_CTA, STAFF, STEPS } from "../shared/content";
import controls from "../shared/controls.module.css";
import { HeroSlot } from "../shared/HeroSlot";
import { LandingSearch } from "../shared/LandingSearch";
import { mono, sans } from "./fonts";
import s from "./v2.module.css";

/** Direction 2: clinical precision. A Swiss spec-sheet grid in chalk, graphite and mineral green, amber for action. */
export function V2Landing() {
  return (
    <div className={`${sans.variable} ${mono.variable} ${s.page}`}>
      <a className={s.skip} href={`#${IDS.main}`}>
        Skip to content
      </a>

      <header className={s.header}>
        <Link href="/landing/v2" className={s.mark} aria-label="MedLink, direction 2 home">
          <span aria-hidden="true" className={s.markIdx}>M</span>
          MedLink
        </Link>
        <nav aria-label="Main" className={s.nav}>
          {NAV_LINKS.map((l, i) => (
            <a key={l.label} href={l.href}>
              <span aria-hidden="true">{i + 1}.0</span> {l.label}
            </a>
          ))}
          <a href={`#${IDS.search}`} className={s.navCta}>
            {PRIMARY_CTA}
          </a>
        </nav>
      </header>

      <main id={IDS.main}>
        {/* Hero */}
        <section className={s.hero} aria-labelledby="v2-title">
          <h1 id="v2-title" className={s.title}>
            <span>Availability,</span> <span>made visible.</span>
          </h1>
          <div className={s.heroLeft}>
            <p className={s.idx} aria-hidden="true">0.1 — Search</p>
            <p className={s.deck}>{HERO_DECK}</p>
            <div id={IDS.search} className={`${controls.search} ${s.search}`}>
              <LandingSearch visibleLabel label="Medicine" />
            </div>
            <a href={`#${IDS.how}`} className={s.secondary}>
              {SECONDARY_CTA} <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className={s.heroField}>
            <p className={s.axisTop} aria-hidden="true">
              <span>Pharmacy →</span>
              <span>P00x</span>
            </p>
            <div className={s.fieldRow}>
              <p className={s.axisSide} aria-hidden="true">
                <span>Medicine ↓</span>
              </p>
              <HeroSlot
                className={s.slot}
                width={1800}
                height={1200}
                label="Abstract availability matrix: pharmacies across, medicines down, stock states as lines, symbols and type"
              />
            </div>
            <p className={s.legend}>
              <span>
                <b aria-hidden="true">●</b> In stock
              </span>
              <span>
                <b aria-hidden="true">◐</b> Low stock
              </span>
              <span>
                <b aria-hidden="true">○</b> Out of stock
              </span>
            </p>
          </div>
        </section>

        {/* How it works */}
        <section id={IDS.how} className={s.section} aria-labelledby="v2-how">
          <div className={s.secHead}>
            <p className={s.idx}>1.0</p>
            <h2 id="v2-how">How it works</h2>
          </div>
          <ol className={s.steps}>
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className={s.stepIdx} aria-hidden="true">1.{i + 1}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Availability */}
        <section id={IDS.availability} className={s.section} aria-labelledby="v2-avail">
          <div className={s.secHead}>
            <p className={s.idx}>2.0</p>
            <h2 id="v2-avail">Availability, compared</h2>
          </div>
          <div className={`${controls.avail} ${s.avail}`}>
            <AvailabilitySample />
          </div>
        </section>

        {/* Independent pharmacies */}
        <section id={IDS.network} className={s.section} aria-labelledby="v2-net">
          <div className={s.secHead}>
            <p className={s.idx}>3.0</p>
            <h2 id="v2-net">Built around independent pharmacies</h2>
          </div>
          <div className={s.netGrid}>
            <div className={s.netCopy}>
              <p className={s.lead}>{INDEPENDENT.lead}</p>
              {INDEPENDENT.body.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
            <figure className={s.diagram}>
              <svg viewBox="0 0 560 300" role="img" aria-labelledby="v2-diagram-title">
                <title id="v2-diagram-title">{`Schematic: ${INDEPENDENT.path.join(", then ")}.`}</title>
                <g stroke="currentColor" strokeWidth="1" fill="none">
                  {[40, 95, 150, 205, 260].map((y) => (
                    <g key={y}>
                      <rect x="10" y={y - 14} width="120" height="28" />
                      <path d={`M130 ${y} H 400`} />
                      <path d={`M400 ${y} L 420 150`} strokeDasharray="2 3" />
                    </g>
                  ))}
                  <rect x="420" y="20" width="130" height="260" fill="var(--amber)" stroke="none" />
                </g>
                <g fontFamily="var(--lp2-mono)" fontSize="10" fill="currentColor" letterSpacing="0.5">
                  {[40, 95, 150, 205, 260].map((y) => (
                    <text key={y} x="20" y={y + 3}>
                      P00x · own database
                    </text>
                  ))}
                  <text x="485" y="155" textAnchor="middle" fill="var(--graphite)">
                    SEARCH VIEW
                  </text>
                  <text x="265" y="16" textAnchor="middle">
                    change sent on →
                  </text>
                </g>
                <g stroke="currentColor" strokeWidth="0.6">
                  {Array.from({ length: 28 }, (_, i) => (
                    <path key={i} d={`M${140 + i * 10} 292 v${i % 5 === 0 ? 8 : 4}`} />
                  ))}
                </g>
              </svg>
              <figcaption>Schematic. Each pharmacy keeps its own database; MedLink reads what they pass along.</figcaption>
            </figure>
          </div>
        </section>

        {/* Pharmacy staff */}
        <section id={IDS.staff} className={s.section} aria-labelledby="v2-staff">
          <div className={s.secHead}>
            <p className={s.idx}>4.0</p>
            <h2 id="v2-staff">For pharmacy staff</h2>
          </div>
          <div className={s.staffGrid}>
            <p className={s.lead}>{STAFF.lead}</p>
            <div>
              <p>{STAFF.body}</p>
              <Link href={ROUTES.portal} className={s.button}>
                {STAFF.cta} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
        </section>

        {/* Trust and limitations */}
        <section id={IDS.trust} className={s.section} aria-labelledby="v2-trust">
          <div className={s.secHead}>
            <p className={s.idx}>5.0</p>
            <h2 id="v2-trust">Limits of the service</h2>
          </div>
          <ul className={s.limits}>
            {LIMITATIONS.map((l, i) => (
              <li key={l}>
                <span aria-hidden="true">5.{i + 1}</span>
                {l}
              </li>
            ))}
          </ul>
        </section>

        {/* Final conversion */}
        <section id={IDS.find} className={s.final} aria-labelledby="v2-final">
          <p className={s.idx}>6.0 — Search</p>
          <h2 id="v2-final" className={s.finalTitle}>
            Find a medicine.
          </h2>
          <div className={`${controls.search} ${s.search} ${s.finalSearch}`}>
            <LandingSearch visibleLabel label="Medicine" showTry={false} />
          </div>
        </section>
      </main>

      <footer className={s.footer}>
        <p>{FOOTER_NOTE}</p>
        <ul>
          {FOOTER_LINKS.map((l) => (
            <li key={l.label}>{l.href.startsWith("#") ? <a href={l.href}>{l.label}</a> : <Link href={l.href}>{l.label}</Link>}</li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
