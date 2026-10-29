import { notFound } from "next/navigation";
import { PharmacyPage } from "../../../components/pharmacies/PharmacyPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) notFound();
  return <PharmacyPage id={n} />;
}
