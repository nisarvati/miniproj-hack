import type { Metadata } from "next";
import { V2Landing } from "../../../components/landing/v2/V2Landing";

export const metadata: Metadata = {
  title: "Direction 2 · Clinical precision",
  description: "Landing page exploration: clinical precision.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <V2Landing />;
}
