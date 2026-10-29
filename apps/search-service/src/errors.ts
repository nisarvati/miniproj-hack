import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

/** An error whose message is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const CONNECTION_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "57P01", "57P03"]);

/** True for failures that mean "the database is unreachable" rather than "the query is wrong". */
export function isDbUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string; errors?: unknown[] };
  if (e.code && (CONNECTION_CODES.has(e.code) || e.code.startsWith("08"))) return true;
  // pg-pool timeouts / dropped connections have no code; AggregateError wraps per-address failures.
  if (Array.isArray(e.errors) && e.errors.some(isDbUnavailable)) return true;
  return /timeout exceeded when trying to connect|Connection terminated|connect ECONNREFUSED/i.test(e.message ?? "");
}

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown };
}

function send(reply: FastifyReply, req: FastifyRequest, status: number, code: string, message: string, details?: unknown) {
  const body: ErrorBody = { error: { code, message, requestId: req.id, ...(details !== undefined && { details }) } };
  return reply.status(status).send(body);
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return send(reply, req, err.status, err.code, err.message, err.details);
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ field: i.path.join("."), message: i.message }));
    return send(reply, req, 400, "VALIDATION_ERROR", "Invalid request", details);
  }
  if (isDbUnavailable(err)) {
    req.log.error({ err }, "database unavailable");
    return send(reply, req, 503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable");
  }
  const status = (err as FastifyError).statusCode;
  if (status && status >= 400 && status < 500) {
    // Fastify-level client errors (malformed JSON, payload too large, ...).
    return send(reply, req, status, "BAD_REQUEST", "Malformed request");
  }
  req.log.error({ err }, "unhandled error");
  return send(reply, req, 500, "INTERNAL_ERROR", "Something went wrong");
}

export function notFoundHandler(req: FastifyRequest, reply: FastifyReply) {
  return send(reply, req, 404, "NOT_FOUND", "Route not found");
}
