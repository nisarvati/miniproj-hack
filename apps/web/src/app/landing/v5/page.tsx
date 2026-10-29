import type { Metadata } from "next";
import { V5Landing } from "../../../components/landing/v5/V5Landing";

export const metadata: Metadata = {
  title: "Direction 5 · Humanist utility",
  description: "Landing page exploration: humanist utility.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <V5Landing />;
}
