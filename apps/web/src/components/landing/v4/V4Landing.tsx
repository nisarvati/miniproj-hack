import Link from "next/link";
import { AvailabilitySample } from "../shared/AvailabilitySample";
import { FOOTER_LINKS, FOOTER_NOTE, HERO_DECK, IDS, INDEPENDENT, LIMITATIONS, NAV_LINKS, PRIMARY_CTA, ROUTES, SECONDARY_CTA, STAFF, STEPS } from "../shared/content";
import controls from "../shared/controls.module.css";
import { HeroSlot } from "../shared/HeroSlot";
import { LandingSearch } from "../shared/LandingSearch";
import { display, mono } from "./fonts";
import s from "./v4.module.css";

const RAILS = [36, 84, 132, 180, 228];

/** Direction 4: signal and stream. Graphite, warm off-white, moss signal states, one amber; the network is the picture. */
export function V4Landing() {
  return (
    <div className={`${display.variable} ${mono.variable} ${s.page}`}>
      <a className={s.skip} href={`#${IDS.main}`}>
        Skip to content
      </a>

      <header className={s.header}>
        <Link href="/landing/v4" className={s.mark} aria-label="MedLink, direction 4 home">
          <span aria-hidden="true" className={s.pulse} />
          MedLink
        </Link>
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
        <section className={s.hero} aria-labelledby="v4-title">
          <p className={s.meta} aria-hidden="true">
            <span>Index · availability layer</span>
            <span>Nodes · P00x … P00n</span>
          </p>
          <h1 id="v4-title" className={s.title}>
            <span>Every pharmacy.</span> <span className={s.dim}>A clearer picture.</span>
          </h1>
          <div className={s.heroRow}>
            <p className={s.deck}>{HERO_DECK}</p>
            <div id={IDS.search} className={`${controls.search} ${s.search}`}>
              <LandingSearch visibleLabel label="Search a medicine" />
              <a href={`#${IDS.how}`} className={s.secondary}>
                {SECONDARY_CTA} <span aria-hidden="true">↓</span>
              </a>
            </div>
          </div>
          <div className={s.field}>
            <div className={s.rulerTop} aria-hidden="true" />
            <HeroSlot
              className={s.slot}
              width={2400}
              height={1350}
              label="Monumental processed visualisation: independent pharmacy nodes sending inventory events through a distributed network into a searchable availability layer"
            />
            <ol className={s.stages} aria-label="From pharmacy to search">
              {INDEPENDENT.path.map((p, i) => (
                <li key={p}>
                  <span aria-hidden="true">{String(i + 1).padStart(2, "0")}</span> {p}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* How it works */}
        <section id={IDS.how} className={s.section} aria-labelledby="v4-how">
          <p className={s.tag}>
            <span aria-hidden="true">// </span>trace
          </p>
          <h2 id="v4-how" className={s.h2}>
            How it works
          </h2>
          <ol className={s.trace}>
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className={s.stepNo} aria-hidden="true">
                  S{i + 1}
                </span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Availability */}
        <section id={IDS.availability} className={s.section} aria-labelledby="v4-avail">
          <p className={s.tag}>
            <span aria-hidden="true">// </span>availability
          </p>
          <h2 id="v4-avail" className={s.h2}>
            One view of many shelves
          </h2>
          <div className={`${controls.avail} ${s.avail}`}>
            <AvailabilitySample />
          </div>
        </section>

        {/* Independent pharmacies */}
        <section id={IDS.network} className={s.section} aria-labelledby="v4-net">
          <p className={s.tag}>
            <span aria-hidden="true">// </span>network
          </p>
          <h2 id="v4-net" className={s.h2}>
            {INDEPENDENT.lead}
          </h2>
          <div className={s.netGrid}>
            <figure className={s.diagram}>
              <svg viewBox="0 0 640 264" role="img" aria-labelledby="v4-diagram-title">
                <title id="v4-diagram-title">{`Diagram: ${INDEPENDENT.path.join(", then ")}.`}</title>
                <defs>
                  <pattern id="v4-dots" width="6" height="6" patternUnits="userSpaceOnUse">
                    <circle cx="3" cy="3" r="1.1" fill="var(--moss)" />
                  </pattern>
                </defs>
                <rect x="470" y="12" width="158" height="240" fill="url(#v4-dots)" opacity="0.55" />
                <rect x="470" y="12" width="158" height="240" fill="none" stroke="var(--moss)" />
                {RAILS.map((y, i) => (
                  <g key={y}>
                    <rect x="8" y={y - 12} width="96" height="24" fill="none" stroke="var(--text)" strokeOpacity="0.7" />
                    <path className={s.stream} d={`M104 ${y} H470`} stroke="var(--moss)" strokeWidth="1.2" strokeDasharray="6 6" fill="none" style={{ animationDelay: `${i * -0.7}s` }} />
                    <circle cx={190 + i * 38} cy={y} r="3.2" fill="var(--amber)" />
                  </g>
                ))}
                <g fontFamily="var(--lp4-mono)" fontSize="10" fill="var(--text)">
                  {RAILS.map((y) => (
                    <text key={y} x="18" y={y + 3.5}>
                      P00x · own db
                    </text>
                  ))}
                  <text x="549" y="136" textAnchor="middle">SEARCH VIEW</text>
                </g>
              </svg>
              <figcaption>Illustrative. Each pharmacy keeps its own database; changes are passed along and MedLink updates what search shows.</figcaption>
            </figure>
            <div className={s.netCopy}>
              {INDEPENDENT.body.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
          </div>
        </section>

        {/* Pharmacy staff */}
        <section id={IDS.staff} className={s.section} aria-labelledby="v4-staff">
          <p className={s.tag}>
            <span aria-hidden="true">// </span>write access
          </p>
          <h2 id="v4-staff" className={s.h2}>
            {STAFF.lead}
          </h2>
          <div className={s.staffCopy}>
            <p>{STAFF.body}</p>
            <Link href={ROUTES.portal} className={s.button}>
              {STAFF.cta} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </section>

        {/* Trust and limitations */}
        <section id={IDS.trust} className={s.section} aria-labelledby="v4-trust">
          <p className={s.tag}>
            <span aria-hidden="true">// </span>limits
          </p>
          <h2 id="v4-trust" className={s.h2}>
            What to keep in mind
          </h2>
          <ul className={s.limits}>
            {LIMITATIONS.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>

        {/* Final conversion */}
        <section id={IDS.find} className={s.final} aria-labelledby="v4-final">
          <p className={s.tag}>
            <span aria-hidden="true">// </span>query
          </p>
          <h2 id="v4-final" className={s.finalTitle}>
            See the whole <span>picture.</span>
          </h2>
          <div className={`${controls.search} ${s.search} ${s.finalSearch}`}>
            <LandingSearch visibleLabel label="Search a medicine" showTry={false} />
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
