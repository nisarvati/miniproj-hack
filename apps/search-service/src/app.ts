import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Db } from "@medlink/db";
import type { Config } from "./config.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { inventoryRoutes } from "./modules/inventory/routes.js";
import { medicineRoutes } from "./modules/medicines/routes.js";
import { analyticsRoutes } from "./modules/analytics/routes.js";
import type { EventHistory } from "./modules/analytics/events.js";
import { nodeRoutes } from "./modules/nodes/routes.js";
import { getNodes, registryPharmacies, type NodeSources } from "./modules/nodes/service.js";
import type { StockFeed } from "./modules/stream/feed.js";
import { LiveHub } from "./modules/stream/hub.js";
import { streamRoutes } from "./modules/stream/routes.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { pharmacyRoutes } from "./modules/pharmacies/routes.js";
import type { LiveStock } from "./modules/live/live-stock.js";
import { searchRoutes } from "./modules/search/routes.js";

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface AppOptions {
  logger?: boolean;
  /** Live stock from the event pipeline's Redis state. Without it search uses the catalogue database only. */
  live?: LiveStock;
  /** Where GET /api/nodes reads sync status from. Without `sync` every node is reported "unknown". */
  nodes?: NodeSources;
  /** Where GET /api/analytics/network reads how many events each pharmacy's stream retains. Without it that part answers NOT_CONFIGURED. */
  events?: EventHistory;
  /** GET /api/stream. `stock` is where stock changes come from (without it the stream carries node status and heartbeats only);
   *  `hub` replaces the whole fan-out (tests). */
  stream?: { stock?: StockFeed; hub?: LiveHub };
}

const noStock: StockFeed = { poll: async () => [], stats: () => ({ malformed: 0, unconfirmed: 0 }) };

export async function buildApp(db: Db, config: Config, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.LOG_LEVEL },
    // Honour a well-formed incoming id so requests can be correlated across services.
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && SAFE_REQUEST_ID.test(h) ? h : randomUUID();
    },
  });

  await app.register(cors, { origin: config.corsOrigins, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    // This API only ever answers JSON or an error: nothing in it should be rendered, framed or sniffed as something else.
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  });
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  const health = async (_req: unknown, reply: import("fastify").FastifyReply) => {
    try {
      await db.query("SELECT 1");
      // Live stock is a bonus: search falls back to the database without it, so it never makes the service unhealthy.
      const live = opts.live ? { live: (await opts.live.ping()) ? "up" : "down" } : {};
      return { status: "ok", checks: { database: "up", ...live } };
    } catch (err) {
      app.log.error({ err }, "health check: database down");
      return reply.status(503).send({ status: "degraded", checks: { database: "down" } });
    }
  };
  app.get("/api/health", health);
  app.get("/health", health);

  medicineRoutes(app, db);
  const deps = { db, config, live: opts.live, log: app.log };
  pharmacyRoutes(app, deps);
  inventoryRoutes(app, db, config);
  searchRoutes(app, deps);
  notificationRoutes(app, db);
  nodeRoutes(app, opts.nodes ?? {});
  analyticsRoutes(app, { ...deps, events: opts.events, pharmacies: opts.nodes?.pharmacies ?? registryPharmacies, now: opts.nodes?.now });
  streamRoutes(app, opts.stream?.hub ?? new LiveHub({ stock: opts.stream?.stock ?? noStock, nodes: () => getNodes(opts.nodes ?? {}), log: app.log }));

  return app;
}
