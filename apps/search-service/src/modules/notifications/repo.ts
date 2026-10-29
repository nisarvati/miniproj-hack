import type { Db } from "@medlink/db";
import { AppError } from "../../errors.js";

export interface Subscription {
  id: number;
  status: "ACTIVE" | "NOTIFIED" | "CANCELLED";
  medicine: { id: number; brandName: string; dosage: string };
  createdAt: string;
  notifiedAt: string | null;
}

export interface Notification {
  id: number;
  subscriptionId: number;
  medicineId: number;
  pharmacyId: number | null;
  channel: string;
  message: string;
  createdAt: string;
  deliveredAt: string | null;
}

interface SubscriptionRow {
  id: string;
  status: Subscription["status"];
  medicine_id: string;
  brand_name: string;
  dosage: string;
  created_at: Date;
  notified_at: Date | null;
}

const SUBSCRIPTION_SELECT = `
  SELECT s.id, s.status, s.medicine_id, m.brand_name, m.dosage, s.created_at, s.notified_at
  FROM restock_subscriptions s
  JOIN medicines m ON m.id = s.medicine_id`;

const toSubscription = (r: SubscriptionRow): Subscription => ({
  id: Number(r.id),
  status: r.status,
  medicine: { id: Number(r.medicine_id), brandName: r.brand_name, dosage: r.dosage },
  createdAt: r.created_at.toISOString(),
  notifiedAt: r.notified_at?.toISOString() ?? null,
});

/** There is no sign-in yet: a user is identified by email, and created the first time it is seen. */
async function userIdForEmail(db: Db, email: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    // The no-op update makes RETURNING work for an existing row too.
    `INSERT INTO users (name, email) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email.split("@")[0], email],
  );
  return Number(rows[0]!.id);
}

/** Subscribing again while a subscription is still waiting returns that one (`created: false`). */
export async function subscribe(db: Db, email: string, medicineId: number): Promise<{ subscription: Subscription; created: boolean }> {
  const userId = await userIdForEmail(db, email);
  // The waiting subscription we conflicted with can be fulfilled before we read it back; then simply try again.
  for (let attempt = 0; attempt < 3; attempt++) {
    let inserted: { id: string }[];
    try {
      ({ rows: inserted } = await db.query<{ id: string }>(
        `INSERT INTO restock_subscriptions (user_id, medicine_id) VALUES ($1, $2)
         ON CONFLICT (user_id, medicine_id) WHERE status = 'ACTIVE' DO NOTHING
         RETURNING id`,
        [userId, medicineId],
      ));
    } catch (err) {
      if ((err as { code?: string }).code === "23503") throw new AppError(404, "NOT_FOUND", "Unknown medicineId");
      throw err;
    }
    const created = inserted.length > 0;
    const { rows } = created
      ? await db.query<SubscriptionRow>(`${SUBSCRIPTION_SELECT} WHERE s.id = $1`, [inserted[0]!.id])
      : await db.query<SubscriptionRow>(
          `${SUBSCRIPTION_SELECT} WHERE s.user_id = $1 AND s.medicine_id = $2 AND s.status = 'ACTIVE'`,
          [userId, medicineId],
        );
    if (rows[0]) return { subscription: toSubscription(rows[0]), created };
  }
  throw new Error("could not create or find the restock subscription");
}

export async function listSubscriptions(db: Db, email: string): Promise<Subscription[]> {
  const { rows } = await db.query<SubscriptionRow>(
    `${SUBSCRIPTION_SELECT} WHERE s.user_id = (SELECT id FROM users WHERE email = $1) ORDER BY s.id DESC`,
    [email],
  );
  return rows.map(toSubscription);
}

/** Only the owner (by email) can cancel, and only while it is still waiting. */
export async function cancelSubscription(db: Db, id: number, email: string): Promise<Subscription | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE restock_subscriptions SET status = 'CANCELLED'
     WHERE id = $1 AND status = 'ACTIVE' AND user_id = (SELECT id FROM users WHERE email = $2)
     RETURNING id`,
    [id, email],
  );
  if (!rows[0]) return null;
  return toSubscription((await db.query<SubscriptionRow>(`${SUBSCRIPTION_SELECT} WHERE s.id = $1`, [id])).rows[0]!);
}

export async function listNotifications(db: Db, email: string, limit: number): Promise<Notification[]> {
  const { rows } = await db.query<{
    id: string; subscription_id: string; medicine_id: string; pharmacy_id: string | null;
    channel: string; message: string; created_at: Date; delivered_at: Date | null;
  }>(
    `SELECT id, subscription_id, medicine_id, pharmacy_id, channel, message, created_at, delivered_at
     FROM notifications
     WHERE user_id = (SELECT id FROM users WHERE email = $1)
     ORDER BY id DESC LIMIT $2`,
    [email, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    subscriptionId: Number(r.subscription_id),
    medicineId: Number(r.medicine_id),
    pharmacyId: r.pharmacy_id === null ? null : Number(r.pharmacy_id),
    channel: r.channel,
    message: r.message,
    createdAt: r.created_at.toISOString(),
    deliveredAt: r.delivered_at?.toISOString() ?? null,
  }));
}
