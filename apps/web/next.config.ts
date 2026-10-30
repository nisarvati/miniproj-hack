import type { NextConfig } from "next";
import { webRewrites } from "./src/server/portal-upstream";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  async redirects() {
    return [
      // The old landing-page chooser is gone; V1 is the homepage. /landing/v1..v5 are unchanged.
      { source: "/landing", destination: "/", permanent: false },
      // The search app moved from / to /search. Searches that were bookmarked or shared as /?q=... keep working.
      { source: "/", has: [{ type: "query", key: "q" }], destination: "/search", permanent: false },
    ];
  },
  async rewrites() {
    // The same-origin pharmacy-portal proxy (and, in development, the search API): see src/server/portal-upstream.ts.
    return webRewrites({ NODE_ENV: process.env.NODE_ENV, PORTAL_UPSTREAM_URL: process.env.PORTAL_UPSTREAM_URL });
  },
};

export default config;
