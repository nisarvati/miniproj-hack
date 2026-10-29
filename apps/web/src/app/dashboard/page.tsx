import type { Metadata } from "next";
import { DashboardPage } from "../../components/dashboard/DashboardPage";

export const metadata: Metadata = { title: "Pharmacy sync status" };

export default function Page() {
  return <DashboardPage />;
}
