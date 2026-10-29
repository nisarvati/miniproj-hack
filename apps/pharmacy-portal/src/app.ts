import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "@medlink/db";
import { PharmacySimulator } from "@medlink/pharmacy-ops";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { portalRoutes } from "./routes.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface AppDeps {
  /** MedLink's central database: staff accounts and the medicine catalogue. */
  db: Db;
  /** Each pharmacy's OWN database, by code. The portal changes stock only here; the pipeline does the rest. */
  pharmacies: Record<string, Db>;
}

export async function buildApp({ db, pharmacies }: AppDeps, config: Config, opts: { logger?: boolean; now?: () => number } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL, redact: ["req.headers.cookie", "req.headers.authorization"] },
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && SAFE_REQUEST_ID.test(h) ? h : randomUUID();
    },
  });

  // Cookies cross from the web app's origin, so the origin must be listed and credentials allowed.
  // `exposedHeaders`: the web page is on another origin, and can read a CSV download's filename and whether it was cut short only if these are exposed.
  await app.register(cors, { origin: config.corsOrigins, credentials: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], exposedHeaders: ["content-disposition", "x-export-truncated"] });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
    // This API only ever answers JSON, CSV or an error: nothing in it should be rendered, framed or sniffed as something else.
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.get("/health", async () => ({ status: "ok" }));
  // This is the API. Someone who opens its address in a browser belongs on the portal page of the web app.
  app.get("/", async (_req, reply) => reply.redirect(`${config.corsOrigins[0] ?? "http://localhost:3000"}/portal`));
  // Low-stock alerts follow every change made here. A problem with them is logged, never allowed to fail a sale.
  const sim = new PharmacySimulator(pharmacies, { lowStockThreshold: config.lowStockThreshold, onAlertError: (err) => app.log.warn({ err }, "low-stock alerts could not be updated; the next read repairs them") });
  portalRoutes(app, { db, pharmacies, sim, config, now: opts.now });
  return app;
}
