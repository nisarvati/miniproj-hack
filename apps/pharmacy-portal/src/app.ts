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

export async function buildApp({ db, pharmacies }: AppDeps, config: Config, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL, redact: ["req.headers.cookie", "req.headers.authorization"] },
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && SAFE_REQUEST_ID.test(h) ? h : randomUUID();
    },
  });

  // Cookies cross from the web app's origin, so the origin must be listed and credentials allowed.
  await app.register(cors, { origin: config.corsOrigins, credentials: true, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  app.get("/health", async () => ({ status: "ok" }));
  // This is the API. Someone who opens its address in a browser belongs on the portal page of the web app.
  app.get("/", async (_req, reply) => reply.redirect(`${config.corsOrigins[0] ?? "http://localhost:3000"}/portal`));
  portalRoutes(app, { db, pharmacies, sim: new PharmacySimulator(pharmacies), config });
  return app;
}
