import type { Db } from "@medlink/db";
import { hashPassword } from "./auth.js";

export type UserStatus = "pending" | "active" | "rejected";
export type UserRole = "STAFF" | "ADMIN";

export interface PortalUser {
  /** The account's number, as a string (it can be larger than a JavaScript number is exact for). */
  id: string;
  email: string;
  role: UserRole;
  /** null for an administrator. */
  pharmacyCode: string | null;
  status: UserStatus;
  requestedAt: Date;
  decidedAt: Date | null;
}

interface Row {
  id: string;
  email: string;
  role: UserRole;
  pharmacy_code: string | null;
  status: UserStatus;
  created_at: Date;
  decided_at: Date | null;
}
const COLUMNS = "id, email, role, pharmacy_code, status, created_at, decided_at";
const toUser = (r: Row): PortalUser => ({ id: r.id, email: r.email, role: r.role, pharmacyCode: r.pharmacy_code, status: r.status, requestedAt: r.created_at, decidedAt: r.decided_at });

/** Accounts oldest first, optionally of one status. Never includes password hashes. `total` counts every match, not just the page. */
export async function listAccounts(db: Db, filter: { status?: UserStatus; limit: number; offset: number }): Promise<{ items: PortalUser[]; total: number }> {
  const where = filter.status ? "WHERE status = $1" : "";
  const args = filter.status ? [filter.status] : [];
  const [{ rows }, { rows: count }] = await Promise.all([
    db.query<Row>(`SELECT ${COLUMNS} FROM pharmacy_users ${where} ORDER BY created_at, id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, filter.limit, filter.offset]),
    db.query<{ n: string }>(`SELECT count(*) AS n FROM pharmacy_users ${where}`, args),
  ]);
  return { items: rows.map(toUser), total: Number(count[0]!.n) };
}

/** Sign-up requests (default) or every account, oldest first (the operator CLI). */
export async function listUsers(db: Db, which: "pending" | "all" = "pending"): Promise<PortalUser[]> {
  return (await listAccounts(db, { status: which === "pending" ? "pending" : undefined, limit: 1000, offset: 0 })).items;
}

/** Approves or rejects a pending request. Throws if there is no pending request for that email, so a typo is not silent. */
export async function decide(db: Db, email: string, decision: "approve" | "reject"): Promise<PortalUser> {
  const status = decision === "approve" ? "active" : "rejected";
  const { rows } = await db.query<Row>(
    `UPDATE pharmacy_users SET status = $2, decided_at = now()
      WHERE lower(email) = lower($1) AND status = 'pending' AND role = 'STAFF'
      RETURNING ${COLUMNS}`,
    [email, status],
  );
  if (!rows[0]) throw new Error(`No pending request for ${email}`);
  return toUser(rows[0]);
}

export type AccountDecision = "approve" | "reject" | "revoke";
export class AccountDecisionError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "WRONG_STATE",
    message: string,
  ) {
    super(message);
  }
}

/**
 * An administrator's decision about one account, by id.
 *   approve / reject   only a PENDING staff request
 *   revoke             only an ACTIVE staff account (it becomes 'rejected'): this is how access is withdrawn, since a staff member's cookie stops
 *                      working the moment the account is not active (it is checked on every request)
 * Administrator accounts are never decided here (an administrator cannot revoke an administrator, so nobody can lock everyone out).
 */
export async function decideById(db: Db, id: string, decision: AccountDecision): Promise<PortalUser> {
  const from: UserStatus = decision === "revoke" ? "active" : "pending";
  const to: UserStatus = decision === "approve" ? "active" : "rejected";
  const { rows } = await db.query<Row>(
    `UPDATE pharmacy_users SET status = $3, decided_at = now()
      WHERE id = $1 AND status = $2 AND role = 'STAFF'
      RETURNING ${COLUMNS}`,
    [id, from, to],
  );
  if (rows[0]) return toUser(rows[0]);
  const { rows: existing } = await db.query<{ status: UserStatus; role: UserRole }>("SELECT status, role FROM pharmacy_users WHERE id = $1", [id]);
  if (!existing[0]) throw new AccountDecisionError("NOT_FOUND", "No such account.");
  if (existing[0].role === "ADMIN") throw new AccountDecisionError("WRONG_STATE", "Administrator accounts cannot be changed here.");
  throw new AccountDecisionError("WRONG_STATE", `This account is ${existing[0].status}, so it cannot be ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revoked"}.`);
}

export const MIN_ADMIN_PASSWORD = 12;

/**
 * Creates an ACTIVE administrator (no pharmacy). It never promotes an account that already exists: someone who signed up as staff stays staff.
 * This is the only way an administrator comes to exist, and it needs database access, so it is an operator action (`portal:users -- create-admin`).
 */
export async function createAdmin(db: Db, email: string, password: string): Promise<PortalUser> {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new Error("That does not look like an email address.");
  if (password.length < MIN_ADMIN_PASSWORD) throw new Error(`The password must be at least ${MIN_ADMIN_PASSWORD} characters.`);
  const { rows } = await db.query<Row>(
    `INSERT INTO pharmacy_users (email, password_hash, pharmacy_code, role, status, decided_at)
     VALUES ($1, $2, NULL, 'ADMIN', 'active', now())
     ON CONFLICT (lower(email)) DO NOTHING
     RETURNING ${COLUMNS}`,
    [e, await hashPassword(password)],
  );
  if (!rows[0]) throw new Error(`An account for ${e} already exists. It is not changed: administrators are created new, never promoted.`);
  return toUser(rows[0]);
}
