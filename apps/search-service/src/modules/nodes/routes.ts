import type { FastifyInstance } from "fastify";
import { getNodes, type NodeSources } from "./service.js";

/**
 * GET /api/nodes: one entry per active pharmacy with its synchronization status. Read-only; reads Redis sync status (and the
 * connector's health endpoint when reachable), never a pharmacy database. Open like the other /api routes: it carries counts,
 * timestamps and public pharmacy names only. When Redis cannot be read the answer is still 200, with every status "unknown" and every
 * counter null, and `meta.redis` says why (an error status would hide the pharmacy list the page still needs).
 */
export function nodeRoutes(app: FastifyInstance, sources: NodeSources) {
  app.get("/api/nodes", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return getNodes(sources);
  });
}
