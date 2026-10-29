import Link from "next/link";
import { AvailabilitySample } from "../shared/AvailabilitySample";
import { FOOTER_LINKS, FOOTER_NOTE, HERO_DECK, IDS, INDEPENDENT, LIMITATIONS, NAV_LINKS, PRIMARY_CTA, ROUTES, SECONDARY_CTA, STAFF, STEPS } from "../shared/content";
import controls from "../shared/controls.module.css";
import { HeroSlot } from "../shared/HeroSlot";
import { LandingSearch } from "../shared/LandingSearch";
import { mono, serif } from "./fonts";
import s from "./v3.module.css";

const NODES: [number, number][] = [
  [90, 80],
  [210, 210],
  [330, 70],
  [470, 170],
  [540, 60],
];

/** Direction 3: urban pharmacy atlas. A typeset map publication: warm paper, charcoal, olive, one burnt orange. */
export function V3Landing() {
  return (
    <div className={`${serif.variable} ${mono.variable} ${s.page}`}>
      <a className={s.skip} href={`#${IDS.main}`}>
        Skip to content
      </a>

      <header className={s.header}>
        <Link href="/landing/v3" className={s.mark} aria-label="MedLink, direction 3 home">
          MedLink
        </Link>
        <p className={s.running} aria-hidden="true">
          An atlas of independent pharmacies
        </p>
        <nav aria-label="Main" className={s.nav}>
          {NAV_LINKS.map((l) => (
            <a key={l.label} href={l.href}>
              {l.label}
            </a>
          ))}
          <a href={`#${IDS.search}`} className={s.navCta}>
            {PRIMARY_CTA}
          </a>
        </nav>
      </header>

      <main id={IDS.main}>
        {/* Hero */}
        <section className={s.hero} aria-labelledby="v3-title">
          <div className={s.heroText}>
            <p className={s.plate} aria-hidden="true">Plate I · Medicine availability</p>
            <h1 id="v3-title" className={s.title}>
              <span>Your city</span> <span>has the</span> <span className={s.accent}>answer.</span>
            </h1>
            <p className={s.deck}>{HERO_DECK}</p>
            <div id={IDS.search} className={`${controls.search} ${s.search}`}>
              <LandingSearch visibleLabel label="Look up a medicine" />
            </div>
            <a href={`#${IDS.how}`} className={s.secondary}>
              {SECONDARY_CTA} <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className={s.heroMap}>
            <HeroSlot
              className={s.slot}
              width={1500}
              height={2000}
              label="Stylised urban map: street grid, independent pharmacy nodes, restrained availability marks. No real addresses"
            />
            <div className={s.mapKey} aria-hidden="true">
              <span className={s.north}>N<i>↑</i></span>
              <span>Schematic · not to scale</span>
              <span>Grid A–L · 1–12</span>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id={IDS.how} className={s.section} aria-labelledby="v3-how">
          <p className={s.tag}>Route</p>
          <h2 id="v3-how" className={s.h2}>
            How it works
          </h2>
          <ol className={s.route}>
            {STEPS.map((step) => (
              <li key={step.title}>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Availability */}
        <section id={IDS.availability} className={s.section} aria-labelledby="v3-avail">
          <p className={s.tag}>Key</p>
          <h2 id="v3-avail" className={s.h2}>
            Read the whole neighbourhood at once
          </h2>
          <div className={`${controls.avail} ${s.avail}`}>
            <AvailabilitySample />
          </div>
        </section>

        {/* Independent pharmacies */}
        <section id={IDS.network} className={`${s.section} ${s.network}`} aria-labelledby="v3-net">
          <p className={s.tag}>Neighbourhoods</p>
          <div className={s.netCopy}>
            <h2 id="v3-net" className={s.h2}>
              {INDEPENDENT.lead}
            </h2>
            {INDEPENDENT.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          <figure className={s.diagram}>
            <svg viewBox="0 0 600 300" role="img" aria-labelledby="v3-diagram-title">
              <title id="v3-diagram-title">{`Schematic map: ${INDEPENDENT.path.join(", then ")}.`}</title>
              <g stroke="currentColor" strokeWidth="0.8" opacity="0.4" fill="none">
                {[40, 100, 160, 220, 280].map((y) => (
                  <path key={`h${y}`} d={`M0 ${y} H600`} />
                ))}
                {[60, 140, 220, 300, 380, 460, 540].map((x) => (
                  <path key={`v${x}`} d={`M${x} 0 V300`} />
                ))}
                <path d="M0 270 L600 30" strokeWidth="2.2" opacity="0.6" />
              </g>
              <g stroke="var(--orange)" strokeWidth="1" strokeDasharray="3 4" fill="none">
                {NODES.map(([x, y]) => (
                  <path key={`${x}-${y}`} d={`M${x} ${y} L300 150`} />
                ))}
              </g>
              <g fill="var(--paper)" stroke="currentColor" strokeWidth="1.4">
                {NODES.map(([x, y]) => (
                  <g key={`n${x}-${y}`}>
                    <circle cx={x} cy={y} r="8" />
                    <circle cx={x} cy={y} r="2.5" fill="currentColor" stroke="none" />
                  </g>
                ))}
                <circle cx="300" cy="150" r="20" fill="var(--orange)" stroke="none" />
              </g>
              <g fontFamily="var(--lp3-mono)" fontSize="10" fill="currentColor">
                {NODES.map(([x, y]) => (
                  <text key={`t${x}-${y}`} x={x + 12} y={y + 4}>
                    P00x
                  </text>
                ))}
                <text x="300" y="154" textAnchor="middle" fill="var(--paper)" fontSize="8">
                  SEARCH
                </text>
              </g>
            </svg>
            <figcaption>Schematic, not a real map. Each pharmacy keeps its own records; MedLink reads what they pass along.</figcaption>
          </figure>
        </section>

        {/* Pharmacy staff */}
        <section id={IDS.staff} className={`${s.section} ${s.staff}`} aria-labelledby="v3-staff">
          <p className={s.tag}>For pharmacies</p>
          <h2 id="v3-staff" className={s.h2}>
            {STAFF.lead}
          </h2>
          <div>
            <p>{STAFF.body}</p>
            <Link href={ROUTES.portal} className={s.link}>
              {STAFF.cta} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>

        {/* Trust and limitations */}
        <section id={IDS.trust} className={s.section} aria-labelledby="v3-trust">
          <p className={s.tag}>Notes</p>
          <h2 id="v3-trust" className={s.h2}>
            What this atlas does not do
          </h2>
          <ul className={s.notes}>
            {LIMITATIONS.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>

        {/* Final conversion */}
        <section id={IDS.find} className={s.final} aria-labelledby="v3-final">
          <p className={s.tag}>Look something up</p>
          <h2 id="v3-final" className={s.finalTitle}>
            Ask your <em>city.</em>
          </h2>
          <div className={`${controls.search} ${s.search} ${s.finalSearch}`}>
            <LandingSearch visibleLabel label="Look up a medicine" showTry={false} />
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
