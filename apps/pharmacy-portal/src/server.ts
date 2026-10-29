import { createPool, loadPharmacyUrls } from "@medlink/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const pharmacies = Object.fromEntries(Object.entries(loadPharmacyUrls()).map(([code, url]) => [code, createPool(url)]));
const app = await buildApp({ db, pharmacies }, config);
if (!process.env.PORTAL_SESSION_SECRET) app.log.warn("PORTAL_SESSION_SECRET is not set: using the built-in development secret");

for (const pool of [db, ...Object.values(pharmacies)]) pool.on("error", (err) => app.log.error({ err }, "idle database client error"));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await Promise.all([db, ...Object.values(pharmacies)].map((p) => p.end()));
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
