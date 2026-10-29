import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@medlink/db";
import { AppError } from "../../errors.js";
import { cancelSubscription, listNotifications, listSubscriptions, subscribe } from "./repo.js";

const email = z.string().trim().toLowerCase().email("A valid email address is required").max(254);
const id = z.coerce.number().int().positive();

const createBody = z.object({ email, medicineId: id }).strict();
const emailQuery = z.object({ email });
const notificationsQuery = z.object({ email, limit: z.coerce.number().int().min(1).max(100).default(20) });

/**
 * Restock notifications. There is no sign-in yet, so the email is the caller's identity: anyone who knows an
 * address can read and cancel its subscriptions. Fine for the simulated notifications of this milestone; real
 * delivery needs real authentication first.
 */
export function notificationRoutes(app: FastifyInstance, db: Db) {
  app.post("/api/restock-subscriptions", async (req, reply) => {
    const body = createBody.parse(req.body);
    const { subscription, created } = await subscribe(db, body.email, body.medicineId);
    if (created) req.log.info({ subscriptionId: subscription.id, medicineId: body.medicineId }, "restock subscription created");
    return reply.status(created ? 201 : 200).send({ data: subscription, meta: { created } });
  });

  app.get("/api/restock-subscriptions", async (req) => {
    const { email: address } = emailQuery.parse(req.query);
    const data = await listSubscriptions(db, address);
    return { data, meta: { count: data.length } };
  });

  app.delete("/api/restock-subscriptions/:id", async (req) => {
    const { id: subscriptionId } = z.object({ id }).parse(req.params);
    const { email: address } = emailQuery.parse(req.query);
    const cancelled = await cancelSubscription(db, subscriptionId, address);
    // Same answer for "no such subscription" and "not yours": don't reveal which ids exist.
    if (!cancelled) throw new AppError(404, "NOT_FOUND", "No active subscription found for this email");
    return { data: cancelled };
  });

  app.get("/api/notifications", async (req) => {
    const q = notificationsQuery.parse(req.query);
    const data = await listNotifications(db, q.email, q.limit);
    return { data, meta: { count: data.length } };
  });
}
