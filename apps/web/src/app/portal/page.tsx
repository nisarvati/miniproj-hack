import type { Metadata } from "next";
import { PortalPage } from "../../components/portal/PortalPage";

export const metadata: Metadata = { title: "Pharmacy portal" };

export default function Page() {
  return <PortalPage />;
}
