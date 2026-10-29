import type { Metadata } from "next";
import { V3Landing } from "../../../components/landing/v3/V3Landing";

export const metadata: Metadata = {
  title: "Direction 3 · Urban pharmacy atlas",
  description: "Landing page exploration: urban pharmacy atlas.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <V3Landing />;
}
