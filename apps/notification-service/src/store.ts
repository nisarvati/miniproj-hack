import { presentPharmacy, type Db } from "@medlink/db";
import type { Logger } from "./logger.js";
import type { Notifier, OutgoingNotification } from "./notifier.js";
import type { Restock } from "./restock.js";

export interface Fulfilled {
  notificationId: number;
  subscriptionId: number;
  userId: number;
}

/**
 * Turns every subscription waiting for this medicine into a notification, in ONE statement, so it is atomic:
 * a subscription is either still waiting, or notified with its notification stored. Never half of that.
 *
 * Why this is safe to call more than once for the same event (duplicate delivery, retry, two instances at once):
 *  - only ACTIVE subscriptions are taken, and the UPDATE flips them to NOTIFIED. A second caller finds nothing,
 *    or waits for the first one's row lock and then re-checks the status and skips it.
 *  - notifications.subscription_id is UNIQUE, a last line of defence.
 *
 * Only subscriptions that existed when the restock happened are fulfilled (`created_at <= occurredAt`). Without
 * that, a new subscriber would be told about an old restock whenever an old event is replayed (a stream backlog,
 * a service that was down, a consumer group read from the start), though the shelf may be empty again.
 */
export async function fulfilSubscriptions(db: Db, restock: Restock): Promise<Fulfilled[]> {
  const { rows: target } = await db.query<{
    medicine_id: string;
    brand_name: string;
    dosage: string;
    pharmacy_id: string | null;
    pharmacy_name: string | null;
    pharmacy_address: string | null;
    latitude: number | null;
    longitude: number | null;
  }>(
    `SELECT m.id AS medicine_id, m.brand_name, m.dosage, p.id AS pharmacy_id, p.name AS pharmacy_name, p.address AS pharmacy_address, p.latitude, p.longitude
     FROM medicines m
     LEFT JOIN pharmacies p ON p.code = $2
     WHERE m.code = $1`,
    [restock.medicineCode, restock.pharmacyCode],
  );
  const t = target[0];
  if (!t) return []; // a medicine this database doesn't know: nobody can be subscribed to it

  // The name a person sees elsewhere in MedLink (the directory identity, if the pharmacy has one).
  const shownName = t.pharmacy_name ? presentPharmacy({ code: restock.pharmacyCode, name: t.pharmacy_name, address: t.pharmacy_address ?? "", latitude: t.latitude ?? 0, longitude: t.longitude ?? 0 }).name : null;
  const where = shownName ? ` at ${shownName}` : "";
  const message = `${t.brand_name} ${t.dosage} is back in stock${where} (${restock.quantity} available).`;

  const { rows } = await db.query<{ id: string; subscription_id: string; user_id: string }>(
    `WITH due AS (
       UPDATE restock_subscriptions
       SET status = 'NOTIFIED', notified_at = now()
       WHERE medicine_id = $1 AND status = 'ACTIVE' AND created_at <= $2
       RETURNING id, user_id, medicine_id
     )
     INSERT INTO notifications (user_id, subscription_id, medicine_id, pharmacy_id, event_id, message)
     SELECT user_id, id, medicine_id, $3::bigint, $4::uuid, $5 FROM due
     RETURNING id, subscription_id, user_id`,
    [t.medicine_id, restock.occurredAt, t.pharmacy_id, restock.eventId, message],
  );
  return rows.map((r) => ({ notificationId: Number(r.id), subscriptionId: Number(r.subscription_id), userId: Number(r.user_id) }));
}

/**
 * Sends notifications that are stored but not yet delivered, oldest first. Called after each restock and on a timer,
 * so a notification stored just before a crash is still sent afterwards.
 *
 * One notification at a time: each is locked (FOR UPDATE SKIP LOCKED), sent, marked delivered and COMMITTED before the next
 * is taken. So several instances never send the same one, and a crash can only repeat the single notification that was in
 * flight, never a whole batch (which matters now that a send is a real email). Delivery is therefore at-least-once: a crash
 * after `send` but before the commit sends that one again. A failed send is logged, left pending (not retried within this
 * pass), and does not stop the others. `limit` caps how many are attempted per pass.
 */
export async function deliverPending(db: Db, notifier: Notifier, logger: Logger, limit = 100): Promise<number> {
  let delivered = 0;
  let attempted = 0;
  let after = 0;
  while (attempted < limit) {
    const client = await db.connect();
    let more = false;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<RestockRow>(
        `SELECT n.id, n.channel, n.message, u.email,
                m.brand_name, m.dosage,
                p.code AS pharmacy_code, p.name AS pharmacy_name, p.address AS pharmacy_address, p.latitude, p.longitude
         FROM notifications n
         JOIN users u ON u.id = n.user_id
         LEFT JOIN medicines m ON m.id = n.medicine_id
         LEFT JOIN pharmacies p ON p.id = n.pharmacy_id
         WHERE n.delivered_at IS NULL AND n.id > $1
         ORDER BY n.id LIMIT 1
         FOR UPDATE OF n SKIP LOCKED`,
        [after],
      );
      const r = rows[0];
      if (r) {
        more = true;
        attempted++;
        after = Number(r.id);
        let sent = true;
        try {
          await notifier.send(outgoing(r));
        } catch (err) {
          sent = false;
          logger.warn({ notificationId: Number(r.id), error: (err as Error).message }, "notification could not be sent; will retry");
        }
        // Outside the try: a database failure here aborts the pass (the message did go out; the notifier remembers it).
        if (sent) {
          await client.query("UPDATE notifications SET delivered_at = now() WHERE id = $1", [r.id]);
          delivered++;
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (!more) break;
  }
  return delivered;
}

interface RestockRow {
  id: string;
  channel: string;
  message: string;
  email: string;
  brand_name: string | null;
  dosage: string | null;
  pharmacy_code: string | null;
  pharmacy_name: string | null;
  pharmacy_address: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** The notification as a channel receives it: the stored sentence, plus the medicine and the pharmacy as MedLink presents them elsewhere. */
function outgoing(r: RestockRow): OutgoingNotification {
  const pharmacy =
    r.pharmacy_code && r.pharmacy_name
      ? presentPharmacy({ code: r.pharmacy_code, name: r.pharmacy_name, address: r.pharmacy_address ?? "", latitude: r.latitude ?? 0, longitude: r.longitude ?? 0 })
      : null;
  return {
    id: Number(r.id),
    channel: r.channel,
    to: r.email,
    message: r.message,
    restock: {
      medicine: r.brand_name ? { brandName: r.brand_name, dosage: r.dosage ?? "" } : null,
      pharmacy: pharmacy && { name: pharmacy.name, address: pharmacy.address, demo: pharmacy.demo, locationVerified: pharmacy.locationVerified, inventorySimulated: pharmacy.inventorySimulated },
    },
  };
}
