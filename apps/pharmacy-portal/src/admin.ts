import type { Db } from "@medlink/db";

export interface PortalUser {
  email: string;
  pharmacyCode: string;
  status: "pending" | "active" | "rejected";
  requestedAt: Date;
}

/** Sign-up requests (default) or every account, oldest first. Never includes password hashes. */
export async function listUsers(db: Db, which: "pending" | "all" = "pending"): Promise<PortalUser[]> {
  const { rows } = await db.query<{ email: string; pharmacy_code: string; status: PortalUser["status"]; created_at: Date }>(
    `SELECT email, pharmacy_code, status, created_at FROM pharmacy_users ${which === "pending" ? "WHERE status = 'pending'" : ""} ORDER BY created_at, id`,
  );
  return rows.map((r) => ({ email: r.email, pharmacyCode: r.pharmacy_code, status: r.status, requestedAt: r.created_at }));
}

/** Approves or rejects a pending request. Throws if there is no pending request for that email, so a typo is not silent. */
export async function decide(db: Db, email: string, decision: "approve" | "reject"): Promise<PortalUser> {
  const status = decision === "approve" ? "active" : "rejected";
  const { rows } = await db.query<{ email: string; pharmacy_code: string; status: PortalUser["status"]; created_at: Date }>(
    `UPDATE pharmacy_users SET status = $2, decided_at = now()
      WHERE lower(email) = lower($1) AND status = 'pending'
      RETURNING email, pharmacy_code, status, created_at`,
    [email, status],
  );
  const r = rows[0];
  if (!r) throw new Error(`No pending request for ${email}`);
  return { email: r.email, pharmacyCode: r.pharmacy_code, status: r.status, requestedAt: r.created_at };
}
