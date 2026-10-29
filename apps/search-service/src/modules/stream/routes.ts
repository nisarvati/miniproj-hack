import type { OutgoingHttpHeaders } from "node:http";
import type { FastifyInstance } from "fastify";
import { AppError } from "../../errors.js";
import type { LiveHub } from "./hub.js";

/** A connection whose unsent data has grown past this is not keeping up: it is dropped (the browser reconnects and resyncs). */
const MAX_QUEUED_BYTES = 512 * 1024;

/**
 * GET /api/stream: Server-Sent Events. Open like the other /api routes (it carries the same public stock and node status the
 * JSON routes do, and no credentials or personal data). A browser's EventSource sends no custom headers, so there is nothing to
 * authenticate with and nothing secret is put in the URL.
 *
 * The response is taken over from Fastify (`hijack`) because it never ends; CORS headers that the cors plugin already set are
 * copied onto it. All real work lives in the shared LiveHub: this only connects the socket to it and cleans up when it closes.
 */
export function streamRoutes(app: FastifyInstance, hub: LiveHub) {
  // Close the open streams when the server shuts down, or app.close() would wait for them forever.
  app.addHook("preClose", async () => hub.stop());

  app.get("/api/stream", (req, reply) => {
    const lastEventId = req.headers["last-event-id"];
    const res = reply.raw;
    let remove: (() => void) | null = null;
    if (hub.clientCount >= hub.maxClients) {
      throw new AppError(503, "STREAM_FULL", "Too many live connections right now. Use the Refresh button instead.");
    }

    reply.hijack();
    res.writeHead(200, {
      ...(reply.getHeaders() as OutgoingHttpHeaders),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // a reverse proxy must not hold the stream back
      "x-request-id": req.id,
    });
    req.raw.socket.setNoDelay(true);
    req.raw.socket.setTimeout(0);
    res.write("retry: 3000\n\n"); // how long the browser waits before it reconnects

    // The browser went away: release the hub's slot and drop the socket. A connection that carried an endless stream is never reused.
    const cleanup = () => {
      remove?.();
      res.destroy();
    };
    remove = hub.connect(
      {
        send: (text) => !res.destroyed && !res.writableEnded && (res.write(text), res.writableLength <= MAX_QUEUED_BYTES),
        close: () => {
          if (!res.writableEnded) res.end();
        },
      },
      typeof lastEventId === "string" ? lastEventId : undefined,
    );
    if (!remove) {
      res.end();
      return;
    }
    req.raw.on("close", cleanup);
    res.on("error", cleanup);
  });
}
