import type { NextConfig } from "next";

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
    if (process.env.NODE_ENV !== "development") return [];
    return [
      { source: "/api/:path*", destination: "http://localhost:4000/api/:path*" },
      { source: "/portal-api/portal/:path*", destination: "http://localhost:4200/portal/:path*" },
    ];
  },
};

export default config;
