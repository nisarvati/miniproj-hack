import type { Metadata } from "next";
import { V1Landing } from "../components/landing/v1/V1Landing";

export const metadata: Metadata = {
  title: { absolute: "MedLink: find your medicine. Know where to look." },
  description: "Find which nearby independent pharmacies list a medicine, compare price and distance, and see how recent the stock information is.",
  alternates: { canonical: "/" },
};

// The search app is at /search. Old search links (/?q=...) are redirected there in next.config.ts, so / is always the landing page.
export default function Page() {
  return <V1Landing />;
}
