import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { SimulatorError } from "@medlink/pharmacy-ops";
import { ZodError } from "zod";

/** An error whose message is safe to show to portal users. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS_FOR: Record<SimulatorError["code"], number> = {
  INVALID: 400,
  UNKNOWN_PHARMACY: 404,
  UNKNOWN_MEDICINE: 404,
  NOT_STOCKED: 404,
  ALREADY_STOCKED: 409,
  INSUFFICIENT_STOCK: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
};

function send(reply: FastifyReply, req: FastifyRequest, status: number, code: string, message: string, details?: unknown) {
  return reply.status(status).send({ error: { code, message, requestId: req.id, ...(details !== undefined && { details }) } });
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) return send(reply, req, err.status, err.code, err.message);
  if (err instanceof SimulatorError) return send(reply, req, STATUS_FOR[err.code], err.code, err.message);
  if (err instanceof ZodError) {
    return send(reply, req, 400, "VALIDATION_ERROR", "Invalid request", err.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
  }
  // The movement history needs the pharmacy schema's 003 migration: say what to do instead of a bare 500.
  if ((err as { code?: string }).code === "42P01" && /inventory_movements/.test(err.message)) {
    return send(reply, req, 503, "PHARMACY_SCHEMA_OUTDATED", "This pharmacy's database has not been updated yet. Ask MedLink to run the pharmacy migrations (npm run pharmacies:migrate).");
  }
  const status = (err as FastifyError).statusCode;
  if (status && status >= 400 && status < 500) return send(reply, req, status, "BAD_REQUEST", "Malformed request");
  req.log.error({ err }, "unhandled error");
  return send(reply, req, 500, "INTERNAL_ERROR", "Something went wrong");
}

export const notFoundHandler = (req: FastifyRequest, reply: FastifyReply) => send(reply, req, 404, "NOT_FOUND", "Route not found");
