import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@medlink/db";
import type { ChangeResult, PharmacySimulator } from "@medlink/pharmacy-ops";
import { clearedCookie, COOKIE_NAME, createSessionToken, DUMMY_HASH, hashPassword, readCookie, readSessionToken, sessionCookie, verifyPassword, type Session } from "./auth.js";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";

const quantity = z.number().int().min(0).max(1_000_000);
const price = z.number().positive().max(1_000_000).multipleOf(0.01);
const medicineCode = z.string().regex(/^M\d{3,}$/, "medicine code must look like M001");

const loginBody = z.object({ email: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }).strict();
const signupBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10, "Password must be at least 10 characters").max(200),
    pharmacyCode: z.string().trim().toUpperCase().regex(/^P\d{3,}$/, "pharmacy code must look like P001"),
  })
  .strict();
/** Open requests allowed per pharmacy, so an unauthenticated form cannot fill the table. */
const MAX_PENDING_PER_PHARMACY = 20;
const addBody = z.object({ medicineCode, quantity, price }).strict();
const patchBody = z
  .object({ quantity: quantity.optional(), price: price.optional() })
  .strict()
  .refine((b) => b.quantity !== undefined || b.price !== undefined, "Provide quantity and/or price");
const codeParam = z.object({ code: medicineCode });

interface Deps {
  db: Db;
  pharmacies: Record<string, Db>;
  sim: PharmacySimulator;
  config: Config;
}

const summary = (c: ChangeResult) => ({ medicineCode: c.medicineCode, before: c.before, after: c.after, events: c.events.map((e) => e.eventType) });

export function portalRoutes(app: FastifyInstance, { db, pharmacies, sim, config }: Deps) {
  /** The session behind the request's cookie. Always the source of the pharmacy: a request can never name one. */
  const requireSession = async (req: FastifyRequest): Promise<Session & { email: string }> => {
    const session = readSessionToken(readCookie(req.headers.cookie, COOKIE_NAME), config.sessionSecret);
    if (!session) throw new AppError(401, "UNAUTHENTICATED", "Please sign in");
    // The cookie is stateless, so check the account still exists, is approved and still belongs to this pharmacy on every request.
    const { rows } = await db.query<{ email: string }>("SELECT email FROM pharmacy_users WHERE id = $1 AND pharmacy_code = $2 AND status = 'active'", [session.userId, session.pharmacyCode]);
    if (!rows[0]) throw new AppError(401, "UNAUTHENTICATED", "Please sign in");
    return { ...session, email: rows[0].email };
  };
  const pharmacyDb = (code: string): Db => {
    const pool = pharmacies[code];
    if (!pool) throw new AppError(404, "UNKNOWN_PHARMACY", "No database is configured for your pharmacy");
    return pool;
  };
  const pharmacyName = async (code: string) =>
    ((await db.query<{ name: string }>("SELECT name FROM pharmacies WHERE code = $1", [code])).rows[0]?.name ?? code);

  /**
   * Asks for staff access to one pharmacy. The account is created 'pending' and cannot sign in until an administrator
   * approves it (npm run portal:users). The answer is the same whether or not the email is already registered, so the
   * form cannot be used to find out which emails have accounts.
   */
  app.post("/portal/signup", async (req, reply) => {
    const { email, password, pharmacyCode } = signupBody.parse(req.body);
    const known = await db.query("SELECT 1 FROM pharmacies WHERE code = $1", [pharmacyCode]);
    if (!known.rows[0]) throw new AppError(404, "UNKNOWN_PHARMACY", "No pharmacy has that code");
    const { rows: open } = await db.query<{ n: string }>("SELECT count(*) AS n FROM pharmacy_users WHERE pharmacy_code = $1 AND status = 'pending'", [pharmacyCode]);
    if (Number(open[0]!.n) >= MAX_PENDING_PER_PHARMACY) {
      throw new AppError(429, "TOO_MANY_REQUESTS", "This pharmacy has too many requests waiting. Please contact MedLink.");
    }
    // Hash before looking at the table, so a taken email takes as long as a new one.
    const hash = await hashPassword(password);
    const { rowCount } = await db.query(
      "INSERT INTO pharmacy_users (email, password_hash, pharmacy_code, status) VALUES ($1, $2, $3, 'pending') ON CONFLICT (lower(email)) DO NOTHING",
      [email, hash, pharmacyCode],
    );
    req.log.info({ pharmacy: pharmacyCode, created: rowCount === 1 }, "portal signup requested");
    return reply.status(202).send({ data: { status: "pending" } });
  });

  app.post("/portal/login", async (req, reply) => {
    const { email, password } = loginBody.parse(req.body);
    const { rows } = await db.query<{ id: string; email: string; password_hash: string; pharmacy_code: string; status: string }>(
      "SELECT id, email, password_hash, pharmacy_code, status FROM pharmacy_users WHERE lower(email) = lower($1)",
      [email],
    );
    const user = rows[0];
    // Verify even when there is no such account, so the response time does not reveal which emails exist.
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new AppError(401, "INVALID_CREDENTIALS", "Wrong email or password");
    // Said only after the password is right, so it does not reveal which emails have requested access.
    if (user.status === "pending") throw new AppError(403, "ACCOUNT_PENDING", "Your request is waiting for approval. You can sign in once MedLink has approved it.");
    if (user.status !== "active") throw new AppError(403, "ACCOUNT_NOT_APPROVED", "This request was not approved. Please contact MedLink.");
    const token = createSessionToken({ userId: Number(user.id), pharmacyCode: user.pharmacy_code, exp: Date.now() + config.sessionMs }, config.sessionSecret);
    reply.header("set-cookie", sessionCookie(token, config.sessionMs, config.secureCookies));
    req.log.info({ userId: Number(user.id), pharmacy: user.pharmacy_code }, "portal login");
    return { data: { email: user.email, pharmacy: { code: user.pharmacy_code, name: await pharmacyName(user.pharmacy_code) } } };
  });

  app.post("/portal/logout", async (_req, reply) => {
    reply.header("set-cookie", clearedCookie(config.secureCookies));
    return reply.status(204).send();
  });

  app.get("/portal/me", async (req) => {
    const s = await requireSession(req);
    return { data: { email: s.email, pharmacy: { code: s.pharmacyCode, name: await pharmacyName(s.pharmacyCode) } } };
  });

  /** What the pharmacy holds, from its own database: the source of truth the pipeline copies from. */
  app.get("/portal/stock", async (req) => {
    const { pharmacyCode } = await requireSession(req);
    const { rows } = await pharmacyDb(pharmacyCode).query<{ medicine_code: string; quantity: number; price: string; updated_at: Date }>(
      "SELECT medicine_code, quantity, price, updated_at FROM inventory ORDER BY medicine_code",
    );
    const { rows: meds } = await db.query<{ code: string; brand_name: string; generic_name: string; dosage: string; form: string }>(
      "SELECT code, brand_name, generic_name, dosage, form FROM medicines WHERE code = ANY($1)",
      [rows.map((r) => r.medicine_code)],
    );
    const byCode = new Map(meds.map((m) => [m.code, m]));
    const items = rows
      .map((r) => {
        const m = byCode.get(r.medicine_code);
        return {
          medicineCode: r.medicine_code,
          brandName: m?.brand_name ?? r.medicine_code,
          genericName: m?.generic_name ?? "",
          dosage: m?.dosage ?? "",
          form: m?.form ?? "",
          quantity: r.quantity,
          price: Number(r.price),
          updatedAt: r.updated_at.toISOString(),
        };
      })
      .sort((a, b) => a.brandName.localeCompare(b.brandName) || a.dosage.localeCompare(b.dosage));
    return { data: items };
  });

  /** Catalogue medicines this pharmacy does not carry yet, for "add a medicine". */
  app.get("/portal/catalogue", async (req) => {
    const { pharmacyCode } = await requireSession(req);
    const { rows: stocked } = await pharmacyDb(pharmacyCode).query<{ medicine_code: string }>("SELECT medicine_code FROM inventory");
    const { rows } = await db.query<{ code: string; brand_name: string; generic_name: string; dosage: string; form: string }>(
      "SELECT code, brand_name, generic_name, dosage, form FROM medicines WHERE NOT (code = ANY($1)) ORDER BY brand_name, dosage",
      [stocked.map((r) => r.medicine_code)],
    );
    return { data: rows.map((m) => ({ medicineCode: m.code, brandName: m.brand_name, genericName: m.generic_name, dosage: m.dosage, form: m.form })) };
  });

  /** Counts the shelf and/or sets the price. The pharmacy database's trigger records the events; the pipeline does the rest. */
  app.patch("/portal/stock/:code", async (req) => {
    const { pharmacyCode } = await requireSession(req);
    const { code } = codeParam.parse(req.params);
    const patch = patchBody.parse(req.body);
    const changes: ChangeResult[] = [];
    if (patch.quantity !== undefined) changes.push(await sim.setQuantity(pharmacyCode, code, patch.quantity));
    if (patch.price !== undefined) changes.push(await sim.changePrice(pharmacyCode, code, patch.price));
    const first = changes[0]!;
    const last = changes.at(-1)!;
    req.log.info({ pharmacy: pharmacyCode, medicine: code, ...patch }, "portal stock updated");
    return { data: { medicineCode: code, before: first.before, after: last.after, events: changes.flatMap((c) => c.events.map((e) => e.eventType)) } };
  });

  app.post("/portal/stock", async (req, reply) => {
    const { pharmacyCode } = await requireSession(req);
    const body = addBody.parse(req.body);
    const change = await sim.addMedicine(pharmacyCode, body.medicineCode, body.quantity, body.price);
    req.log.info({ pharmacy: pharmacyCode, medicine: body.medicineCode }, "portal medicine added");
    return reply.status(201).send({ data: summary(change) });
  });

  app.delete("/portal/stock/:code", async (req) => {
    const { pharmacyCode } = await requireSession(req);
    const { code } = codeParam.parse(req.params);
    const change = await sim.removeMedicine(pharmacyCode, code);
    req.log.info({ pharmacy: pharmacyCode, medicine: code }, "portal medicine removed");
    return { data: summary(change) };
  });
}
