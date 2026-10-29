import { defineConfig } from "vitest/config";

// Load .env (if present) so DB tests see DATABASE_URL.
try {
  process.loadEnvFile(".env");
} catch {
  /* no .env: rely on the ambient environment */
}

export default defineConfig({
  // Component tests (apps/web/**/*.test.tsx) use JSX; each opts into the browser-like environment with
  // `// @vitest-environment jsdom` at the top of the file, so server tests stay in plain Node.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/web/src/**/*.test.tsx", "tests/**/*.test.ts"],
    // DB tests share one database; run files serially.
    fileParallelism: false,
    // next-auth imports `next/server` without an extension, which Node's own ESM loader rejects: let Vite resolve it.
    server: { deps: { inline: [/next-auth/, /@auth\/core/] } },
  },
});
