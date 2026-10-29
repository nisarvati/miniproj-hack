import type { Metadata } from "next";
import { V4Landing } from "../../../components/landing/v4/V4Landing";

export const metadata: Metadata = {
  title: "Direction 4 · Signal and stream",
  description: "Landing page exploration: signal and stream.",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <V4Landing />;
}
