import type { Metadata } from "next";
import { PharmaciesPage } from "../../components/pharmacies/PharmaciesPage";

export const metadata: Metadata = { title: "Pharmacies" };

export default function Page() {
  return <PharmaciesPage />;
}
