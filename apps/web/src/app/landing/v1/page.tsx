import type { Metadata } from "next";
import { V1Landing } from "../../../components/landing/v1/V1Landing";

export const metadata: Metadata = {
  title: "Find your medicine. Know where to look.",
  description: "Find which nearby independent pharmacies list a medicine, compare price and distance, and see how recent the stock information is.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <V1Landing />;
}
