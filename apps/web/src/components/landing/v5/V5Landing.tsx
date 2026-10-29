import Link from "next/link";
import { AvailabilitySample } from "../shared/AvailabilitySample";
import { FOOTER_LINKS, FOOTER_NOTE, HERO_DECK, IDS, INDEPENDENT, LIMITATIONS, NAV_LINKS, PRIMARY_CTA, ROUTES, SECONDARY_CTA, STAFF, STEPS } from "../shared/content";
import controls from "../shared/controls.module.css";
import { HeroSlot } from "../shared/HeroSlot";
import { LandingSearch } from "../shared/LandingSearch";
import { sans, serif } from "./fonts";
import s from "./v5.module.css";

/** Direction 5: humanist utility. Warm off-white, dark ink, forest green and one terracotta; the person comes first. */
export function V5Landing() {
  return (
    <div className={`${serif.variable} ${sans.variable} ${s.page}`}>
      <a className={s.skip} href={`#${IDS.main}`}>
        Skip to content
      </a>

      <header className={s.header}>
        <Link href="/landing/v5" className={s.mark} aria-label="MedLink, direction 5 home">
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
        <section className={s.hero} aria-labelledby="v5-title">
          <div className={s.heroText}>
            <p className={s.lead}>Need a medicine today?</p>
            <h1 id="v5-title" className={s.title}>
              <span>Less searching.</span> <span className={s.accent}>More certainty.</span>
            </h1>
            <p className={s.deck}>{HERO_DECK}</p>
            <div id={IDS.search} className={`${controls.search} ${s.search}`}>
              <LandingSearch visibleLabel label="Which medicine are you looking for?" />
            </div>
            <a href={`#${IDS.how}`} className={s.secondary}>
              {SECONDARY_CTA} <span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className={s.heroArt}>
            <HeroSlot
              className={s.slot}
              width={1600}
              height={2000}
              label="Editorial illustration of a person searching for a medicine, nearby pharmacies as processed linework with subtle data annotations"
            />
            <p className={s.caption} aria-hidden="true">
              A person, a question, and the pharmacies around them.
            </p>
          </div>
        </section>

        {/* How it works */}
        <section id={IDS.how} className={s.section} aria-labelledby="v5-how">
          <h2 id="v5-how" className={s.h2}>
            A short errand, planned
          </h2>
          <ol className={s.steps}>
            {STEPS.map((step, i) => (
              <li key={step.title}>
                <span className={s.num} aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Availability */}
        <section id={IDS.availability} className={s.section} aria-labelledby="v5-avail">
          <h2 id="v5-avail" className={s.h2}>
            What you will see
          </h2>
          <p className={s.intro}>Pharmacies near you, with what each one reports, what it charges, how far away it is and how fresh the information is.</p>
          <div className={`${controls.avail} ${s.avail}`}>
            <AvailabilitySample />
          </div>
        </section>

        {/* Independent pharmacies */}
        <section id={IDS.network} className={`${s.section} ${s.network}`} aria-labelledby="v5-net">
          <div className={s.netCopy}>
            <h2 id="v5-net" className={s.h2}>
              {INDEPENDENT.lead}
            </h2>
            {INDEPENDENT.body.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          <figure className={s.diagram}>
            <svg viewBox="0 0 420 300" role="img" aria-labelledby="v5-diagram-title">
              <title id="v5-diagram-title">{`Diagram: ${INDEPENDENT.path.join(", then ")}.`}</title>
              <g fill="none" stroke="var(--forest)" strokeWidth="1.4">
                {[
                  [60, 50],
                  [60, 150],
                  [60, 250],
                ].map(([x, y]) => (
                  <g key={y}>
                    <rect x={Number(x) - 28} y={Number(y) - 22} width="76" height="44" />
                    <path d={`M${Number(x) + 48} ${y} C 170 ${y}, 190 150, 262 150`} strokeDasharray="4 5" />
                  </g>
                ))}
                <circle cx="320" cy="150" r="58" stroke="var(--terracotta)" strokeWidth="2" />
              </g>
              <g fontFamily="var(--lp5-sans)" fontSize="11" fill="var(--ink)">
                {[50, 150, 250].map((y) => (
                  <text key={y} x="36" y={y + 4}>
                    Own records
                  </text>
                ))}
                <text x="320" y="146" textAnchor="middle" fontSize="13">
                  MedLink
                </text>
                <text x="320" y="164" textAnchor="middle" fontSize="11">
                  search view
                </text>
              </g>
            </svg>
            <figcaption>Illustrative. Each pharmacy keeps its own records; MedLink reads what they pass along.</figcaption>
          </figure>
        </section>

        {/* Pharmacy staff */}
        <section id={IDS.staff} className={`${s.section} ${s.staff}`} aria-labelledby="v5-staff">
          <h2 id="v5-staff" className={s.h2}>
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
        <section id={IDS.trust} className={`${s.section} ${s.trust}`} aria-labelledby="v5-trust">
          <h2 id="v5-trust" className={s.h2}>
            Good to know
          </h2>
          <ul className={s.limits}>
            {LIMITATIONS.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </section>

        {/* Final conversion */}
        <section id={IDS.find} className={s.final} aria-labelledby="v5-final">
          <h2 id="v5-final" className={s.finalTitle}>
            Check <span>before you go.</span>
          </h2>
          <div className={`${controls.search} ${s.search} ${s.finalSearch}`}>
            <LandingSearch visibleLabel label="Which medicine are you looking for?" showTry={false} />
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
