import { collectStatus, exitCodeFor, formatStatus } from "./lib/status.js";

/**
 * npm run services:status [-- --json]
 *
 * Reports each MedLink component's state, using the most accurate check available (a health endpoint where one exists, a bounded
 * TCP/PING probe otherwise). It only reads: it never starts, stops or restarts anything, writes to no database or Redis, and prints
 * no connection string, credential or email address. A process merely existing is never reported as "healthy".
 */
const rows = await collectStatus(process.env, process.cwd());
if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
else {
  console.log(formatStatus(rows));
  console.log("\n✓ healthy = answered a check that exercises its dependencies   • running = answers, but that does not prove readiness   ? unknown = cannot be checked");
}
process.exit(exitCodeFor(rows));
