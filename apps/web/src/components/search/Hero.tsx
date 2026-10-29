import { Chip } from "../ui/primitives";
import { SearchForm } from "./SearchForm";

const ESSENTIALS = [
  { title: "Fever & pain", searches: ["Paracetamol", "Crocin", "Dolo 650"] },
  { title: "Cold & allergy", searches: ["Cetzine", "Allegra", "Otrivin"] },
  { title: "Digestive & acidity", searches: ["Digene", "Pan-D", "ENO"] },
  { title: "Pain relief & first aid", searches: ["Volini", "Betadine", "Band-Aid"] },
];

/** What a visitor sees before searching: the one thing to do, and a few common medicines to start from. */
export function Hero({ onSearch }: { onSearch: (q: string) => void }) {
  return (
    <div className="mx-auto max-w-3xl pt-2 sm:pt-6">
      <h1 className="editorial-title text-3xl leading-tight sm:text-4xl">Find your medicine</h1>
      <p className="mt-1.5 text-muted">See which nearby pharmacies list it, and compare price and stock.</p>
      <div className="mt-5">
        <SearchForm initial="" onSearch={onSearch} />
      </div>

      <section className="mt-8" aria-labelledby="essentials-title">
        <h2 id="essentials-title" className="ui-mono text-[0.72rem] font-medium uppercase tracking-[0.12em] text-muted">Common essentials</h2>
        <ul className="mt-2 border-b border-line">
          {ESSENTIALS.map(({ title, searches }) => (
            <li key={title} className="flex flex-col gap-2 border-t border-line py-3 sm:flex-row sm:items-center sm:gap-4">
              <h3 className="text-sm font-semibold text-ink sm:w-44 sm:shrink-0">{title}</h3>
              <div className="flex flex-wrap gap-2" role="group" aria-label={`Search ${title}`}>
                {searches.map((medicine) => (
                  <Chip key={medicine} onClick={() => onSearch(medicine)}>
                    {medicine}
                  </Chip>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
