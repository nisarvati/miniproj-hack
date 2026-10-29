import pg from "pg";
import type { Queryable } from "./calendar/repo";

const holder = globalThis as { __medlinkWebPool?: pg.Pool };

/**
 * The web app's own connection to the central PostgreSQL, for the patient calendar only (the search API keeps its own). It is
 * created on first use and kept across hot reloads. `null` when DATABASE_URL is not set in the web app's environment, so the
 * calendar can say it is not set up instead of failing obscurely. Server code only: nothing in the browser bundle imports this.
 */
export function getCalendarDb(): Queryable | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!holder.__medlinkWebPool) {
    const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 });
    pool.on("error", () => undefined); // an idle client dropping must not take the server down; the next query reconnects
    holder.__medlinkWebPool = pool;
  }
  return holder.__medlinkWebPool;
}
