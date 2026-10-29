"use client";

import type { Location, MedicineRef } from "../../lib/api";
import { Card } from "../ui/primitives";
import { AlertIcon } from "../ui/icons";
import { NotifyMe } from "./NotifyMe";
import { SubstitutesPanel } from "./SubstitutesPanel";

/** A medicine that is out of stock at every pharmacy we found: be told when it's back, or see what else works. */
export function UnavailableMedicine({ medicine, pharmacyCount, location }: { medicine: MedicineRef; pharmacyCount: number; location: Location }) {
  return (
    <Card className="border-warn/40 p-4 sm:p-5">
      <h2 className="flex items-start gap-2 font-semibold">
        <AlertIcon size={18} className="mt-0.5 shrink-0 text-warn-icon" />
        <span>
          {medicine.brandName} {medicine.dosage} is out of stock {pharmacyCount === 1 ? "at the pharmacy we found" : `at all ${pharmacyCount} pharmacies we found`}
        </span>
      </h2>
      <div className="mt-4 space-y-5">
        <NotifyMe medicine={medicine} />
        <SubstitutesPanel medicine={medicine} location={location} />
      </div>
    </Card>
  );
}
