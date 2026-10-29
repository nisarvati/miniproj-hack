import type { MedicineRef } from "../../lib/api";
import { Card } from "../ui/primitives";
import { SearchIcon } from "../ui/icons";

const name = (m: MedicineRef) => `${m.brandName} ${m.dosage} ${m.form}`;

/**
 * Medicines the search matched that are in the MedLink catalogue but that no pharmacy has listed. Being in the catalogue
 * says the medicine exists; it says nothing about stock, so this never offers prices, quantities or "notify me".
 */
export function UnlistedMedicines({ medicines, alsoFound = false }: { medicines: MedicineRef[]; alsoFound?: boolean }) {
  if (!medicines.length) return null;
  return (
    <Card variant="quiet" className="p-4 sm:p-5">
      <h2 className="flex items-start gap-2 font-semibold">
        <SearchIcon size={18} className="mt-0.5 shrink-0 text-muted" />
        <span>{alsoFound ? "Also in the MedLink catalogue, but not listed by any pharmacy yet" : "No pharmacy has listed this medicine yet"}</span>
      </h2>
      <p className="mt-2 text-sm text-muted">
        {alsoFound
          ? "These match your search, but no pharmacy has told MedLink it carries them:"
          : medicines.length === 1
            ? "It is in the MedLink catalogue, so it exists, but no pharmacy has told MedLink it carries it. That is not the same as being out of stock."
            : "These match your search and are in the MedLink catalogue, but no pharmacy has told MedLink it carries them. That is not the same as being out of stock."}
      </p>
      <ul className="mt-3 space-y-1 text-sm" aria-label="Catalogue medicines no pharmacy has listed">
        {medicines.map((m) => (
          <li key={m.id}>
            <span className="font-medium">{name(m)}</span> <span className="text-muted">({m.genericName})</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
