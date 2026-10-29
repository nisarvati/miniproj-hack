import { PIPELINE } from "../shared/content";
import p from "./pipeline.module.css";

/** Row centres of the five pharmacy boxes in the schematic. */
const ROWS = [22, 62, 102, 142, 182];

/**
 * "Under the surface": how a pharmacy's change reaches search. It sits on the same paper as the rest of the page and
 * reads V1's tokens (paper, ink, green); its own rules live in pipeline.module.css and do not reach the rest of the
 * page. Everything is conceptual: the pharmacy labels are placeholders and nothing here is a reading.
 *
 * The schematic is panoramic (about 4:1) so the whole section, schematic and stages included, fits one screen.
 */
export function Pipeline() {
  return (
    <section id="under-the-surface" className={p.band} aria-labelledby="v1-pipeline">
      <div className={p.inner}>
        <div className={p.head}>
          <div>
            <p className={p.eyebrow}>{PIPELINE.eyebrow}</p>
            <h2 id="v1-pipeline" className={p.title}>
              {PIPELINE.title}
            </h2>
          </div>
          <div className={p.copy}>
            <p className={p.lead}>{PIPELINE.lead}</p>
            <p className={p.plain}>{PIPELINE.plain}</p>
          </div>
        </div>

        <figure className={p.figure}>
          <div className={p.ruler} aria-hidden="true" />
          <svg viewBox="0 -28 1120 268" role="img" aria-labelledby="v1-pipeline-diagram" className={p.svg}>
            <title id="v1-pipeline-diagram">
              Illustrative schematic: pharmacy databases send changes as events through a synchronisation step into a searchable inventory state, which medicine search reads.
            </title>
            <defs>
              <pattern id="v1-pipeline-dots" width="6" height="6" patternUnits="userSpaceOnUse">
                <circle cx="3" cy="3" r="1.1" className={p.patternDot} />
              </pattern>
            </defs>

            {/* stage markers */}
            {[
              [110, 1],
              [376, 2],
              [578, 3],
              [840, 4],
              [1058, 5],
            ].map(([x, n]) => (
              <g key={n}>
                <circle cx={x} cy="-14" r="9" className={p.marker} />
                <text x={x} y="-10.5" textAnchor="middle" className={`${p.mono} ${p.markerText}`}>
                  {n}
                </text>
              </g>
            ))}

            {/* pharmacy databases, their lanes and events */}
            {ROWS.map((cy, i) => (
              <g key={cy}>
                <rect x="16" y={cy - 15} width="188" height="30" className={p.box} />
                <text x="26" y={cy + 4.5} className={`${p.mono} ${p.boxText}`}>
                  P00x · own database
                </text>
                <rect x="187" y={cy - 5} width="10" height="10" className={p.outbox} />
                <path d={`M204 ${cy} H548`} className={`${p.lane} ${p.laneIn}`} />
                <circle cx={270 + i * 52} cy={cy} r="3.5" className={p.event} />
                <path d={`M608 ${cy} C 670 ${cy}, 690 102, 740 102`} className={`${p.lane} ${p.laneOut}`} />
              </g>
            ))}

            {/* synchronisation */}
            <rect x="548" y="-2" width="60" height="208" className={p.gate} />
            <text transform="translate(573 102) rotate(-90)" textAnchor="middle" className={`${p.mono} ${p.gateText}`}>
              CHECK · ORDER
            </text>
            <text transform="translate(591 102) rotate(-90)" textAnchor="middle" className={`${p.mono} ${p.gateText}`}>
              DE-DUPLICATE
            </text>

            {/* searchable inventory state */}
            <rect x="740" y="22" width="200" height="160" fill="url(#v1-pipeline-dots)" className={p.stateFill} />
            <rect x="740" y="22" width="200" height="160" className={p.stateEdge} />
            <rect x="770" y="80" width="140" height="44" className={p.stateLabelBox} />
            <text x="840" y="98" textAnchor="middle" className={`${p.mono} ${p.stateText}`}>
              SEARCHABLE
            </text>
            <text x="840" y="114" textAnchor="middle" className={`${p.mono} ${p.stateText}`}>
              INVENTORY STATE
            </text>

            {/* discovery */}
            <path d="M940 102 H996" className={p.out} />
            <path d="M996 95 L1006 102 L996 109 Z" className={p.outHead} />
            <rect x="1008" y="78" width="100" height="48" className={p.search} />
            <text x="1058" y="99" textAnchor="middle" className={`${p.mono} ${p.searchText}`}>
              MEDICINE
            </text>
            <text x="1058" y="115" textAnchor="middle" className={`${p.mono} ${p.searchText}`}>
              SEARCH
            </text>

            {/* ruler and grid coordinates */}
            <path d="M16 218 H1104" className={p.axis} />
            {Array.from({ length: 69 }, (_, i) => (
              <path key={i} d={`M${16 + i * 16} 218 v${i % 5 === 0 ? 8 : 4}`} className={p.axis} />
            ))}
            {[
              [16, "A"],
              [204, "B"],
              [548, "C"],
              [740, "D"],
              [1008, "E"],
            ].map(([x, label]) => (
              <text key={label} x={x} y="240" className={`${p.mono} ${p.coord}`}>
                {label}
              </text>
            ))}
          </svg>
          <figcaption className={p.caption}>
            <strong>{PIPELINE.figure}</strong> {PIPELINE.footnote}
          </figcaption>
        </figure>

        <ol className={p.stages}>
          {PIPELINE.stages.map((stage, i) => (
            <li key={stage.title}>
              <span className={`${p.mono} ${p.stageNo}`} aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3>{stage.title}</h3>
              <p>{stage.body}</p>
              <span className={`${p.mono} ${p.note}`}>{stage.note}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
