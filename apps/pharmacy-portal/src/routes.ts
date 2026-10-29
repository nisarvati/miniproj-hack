import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { presentPharmacy, type Db } from "@medlink/db";
import { assessStockRisk, type ChangeResult, type Movement, type MovementResult, type PharmacySimulator, type RiskAssessment, type StockAlert } from "@medlink/pharmacy-ops";
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
const alertsQuery = z.object({
  state: z.enum(["ACTIVE", "RESOLVED", "ALL"]).default("ACTIVE"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const riskQuery = z.object({
  level: z.enum(["LOW", "MODERATE", "HIGH", "CRITICAL"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const transactionBody = z.object({ medicineCode, quantity: z.number().int().min(1).max(1_000_000) }).strict();
/** Extra query parameters are ignored, never trusted: the pharmacy always comes from the session. */
const historyQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(100_000).default(0) });

interface Deps {
  db: Db;
  pharmacies: Record<string, Db>;
  sim: PharmacySimulator;
  config: Config;
}

/** What the portal shows about the signed-in pharmacy. `registeredName` is MedLink's own label for the account, shown only when it differs from the listed name. */
export interface PharmacyIdentity {
  code: string;
  name: string;
  address: string | null;
  registeredName: string | null;
}

/** The movement as the API shows it: the pharmacy's own record, with no staff identity beyond "was it you". */
function movementView(m: Movement, names: Map<string, string>, userId: number) {
  return {
    movementId: m.movementId,
    pharmacyCode: m.pharmacyCode,
    medicineCode: m.medicineCode,
    medicineName: names.get(m.medicineCode) ?? m.medicineCode,
    operation: m.operation,
    source: m.source,
    /** Units sold or received (always positive); `quantityDelta` carries the sign. */
    quantity: Math.abs(m.quantityDelta),
    quantityDelta: m.quantityDelta,
    quantityBefore: m.quantityBefore,
    quantityAfter: m.quantityAfter,
    occurredAt: m.occurredAt.toISOString(),
    byYou: m.actorUserId === userId,
    eventId: m.eventId,
    idempotencyKey: m.idempotencyKey,
  };
}

function alertView(a: StockAlert, names: Map<string, string>, threshold: number) {
  return {
    alertId: a.alertId,
    pharmacyCode: a.pharmacyCode,
    medicineCode: a.medicineCode,
    medicineName: names.get(a.medicineCode) ?? a.medicineCode,
    type: a.type,
    state: a.state,
    quantityAtCreation: a.quantityAtCreation,
    /** The threshold the alert was opened under. */
    threshold: a.threshold,
    riskScoreAtCreation: a.riskScoreAtCreation,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    resolvedReason: a.resolvedReason,
    quantityAtResolution: a.quantityAtResolution,
    /** Today's assessment of an active alert, against the threshold in force now. Resolved alerts keep only what was true then. */
    current: a.state === "ACTIVE" && a.currentQuantity !== null ? riskView(assessStockRisk({ quantity: a.currentQuantity, threshold })) : null,
  };
}

/** The risk assessment as the API shows it. The threshold is always there, so the score can be checked against it. */
const riskView = (a: RiskAssessment) => ({
  score: a.score,
  level: a.level,
  quantity: a.quantity,
  threshold: a.threshold,
  belowThreshold: a.belowThreshold,
  summary: a.summary,
  factors: a.factors,
});

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
  /** "Crocin 500mg" for each medicine code, from the central catalogue. A code it does not know is shown as the code. */
  const medicineNames = async (codes: string[]): Promise<Map<string, string>> => {
    if (codes.length === 0) return new Map();
    const { rows } = await db.query<{ code: string; brand_name: string; dosage: string }>("SELECT code, brand_name, dosage FROM medicines WHERE code = ANY($1)", [codes]);
    return new Map(rows.map((m) => [m.code, `${m.brand_name} ${m.dosage}`.trim()]));
  };
  /** The optional Idempotency-Key header. Its format is checked where it is used. */
  const idempotencyKey = (req: FastifyRequest): string | undefined => {
    const h = req.headers["idempotency-key"];
    if (h === undefined) return undefined;
    if (typeof h !== "string") throw new AppError(400, "INVALID_IDEMPOTENCY_KEY", "Send one Idempotency-Key header");
    return h;
  };

  /**
   * Who the pharmacy is, read from the central pharmacies table for the code in the session (never from the request), and shown the
   * same way shoppers see it (presentPharmacy). With no row there is nothing to show but the code, so that is all it says.
   */
  const pharmacyIdentity = async (code: string): Promise<PharmacyIdentity> => {
    const row = (await db.query<{ name: string; address: string; latitude: number; longitude: number }>("SELECT name, address, latitude, longitude FROM pharmacies WHERE code = $1", [code])).rows[0];
    if (!row) return { code, name: `Pharmacy ${code}`, address: null, registeredName: null };
    const shown = presentPharmacy({ code, ...row });
    return { code, name: shown.name, address: shown.address || null, registeredName: row.name !== shown.name ? row.name : null };
  };

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
    return { data: { email: user.email, pharmacy: await pharmacyIdentity(user.pharmacy_code) } };
  });

  app.post("/portal/logout", async (_req, reply) => {
    reply.header("set-cookie", clearedCookie(config.secureCookies));
    return reply.status(204).send();
  });

  app.get("/portal/me", async (req) => {
    const s = await requireSession(req);
    return { data: { email: s.email, pharmacy: await pharmacyIdentity(s.pharmacyCode) } };
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
    const { pharmacyCode, userId } = await requireSession(req);
    const { code } = codeParam.parse(req.params);
    const patch = patchBody.parse(req.body);
    const changes: ChangeResult[] = [];
    if (patch.quantity !== undefined) changes.push((await sim.recordCount(pharmacyCode, code, patch.quantity, { actorUserId: userId })).change!);
    if (patch.price !== undefined) changes.push(await sim.changePrice(pharmacyCode, code, patch.price));
    const first = changes[0]!;
    const last = changes.at(-1)!;
    req.log.info({ pharmacy: pharmacyCode, medicine: code, ...patch }, "portal stock updated");
    return { data: { medicineCode: code, before: first.before, after: last.after, events: changes.flatMap((c) => c.events.map((e) => e.eventType)) } };
  });

  /**
   * Records a sale (dispensing). The pharmacy is the one in the session. The stock change, the outbox event and the movement-history
   * row are one transaction in that pharmacy's own database; the row lock means concurrent sales cannot oversell. With an
   * Idempotency-Key header a retried request returns the original result (200, meta.replayed) instead of selling twice; the same key
   * with a different request is refused (422). Not enough stock: 409 INSUFFICIENT_STOCK, and nothing is recorded.
   */
  app.post("/portal/sales", async (req, reply) => {
    const { pharmacyCode, userId } = await requireSession(req);
    const body = transactionBody.parse(req.body);
    const done = await sim.recordSale(pharmacyCode, body.medicineCode, body.quantity, { actorUserId: userId, idempotencyKey: idempotencyKey(req) });
    return transactionReply(reply, req, done, "sale", userId);
  });

  /** Records stock received. Same guarantees as a sale: one transaction, the outbox event, a history row, safe retries. */
  app.post("/portal/restocks", async (req, reply) => {
    const { pharmacyCode, userId } = await requireSession(req);
    const body = transactionBody.parse(req.body);
    const done = await sim.recordRestock(pharmacyCode, body.medicineCode, body.quantity, { actorUserId: userId, idempotencyKey: idempotencyKey(req) });
    return transactionReply(reply, req, done, "restock", userId);
  });

  const transactionReply = async (reply: FastifyReply, req: FastifyRequest, done: MovementResult, kind: string, userId: number) => {
    const movement = done.movement!; // a sale or restock of at least one unit always changes the quantity
    const names = await medicineNames([movement.medicineCode]);
    if (!done.replayed) req.log.info({ pharmacy: movement.pharmacyCode, medicine: movement.medicineCode, kind, movement: movement.movementId }, "portal transaction recorded");
    return reply.status(done.replayed ? 200 : 201).send({ data: movementView(movement, names, userId), meta: { replayed: done.replayed } });
  };

  /** The pharmacy's own movement history, newest first, bounded (limit 1 to 100, default 20) with an offset. */
  app.get("/portal/history", async (req) => {
    const { pharmacyCode, userId } = await requireSession(req);
    const { limit, offset } = historyQuery.parse(req.query);
    const { items, total } = await sim.history(pharmacyCode, { limit, offset });
    const names = await medicineNames([...new Set(items.map((m) => m.medicineCode))]);
    return { data: items.map((m) => movementView(m, names, userId)), meta: { total, limit, offset, hasMore: offset + items.length < total } };
  });

  // ---- Stock risk and low-stock alerts. Staff only, and always the signed-in pharmacy's own. ----
  // Each read first makes the alerts match the stock, which also catches stock changed outside the portal and a changed threshold. That is safe to
  // repeat and to run at the same time as anything else (see evaluateAlerts); the alerts are derived from stock and never decide it.

  /**
   * Every medicine the pharmacy stocks with its stock-risk score (0 to 100, an operational indicator and not a forecast), the threshold it was
   * measured against, the factors behind it and its active alert, riskiest first. `level` keeps one level; the list is paged (limit 1 to 200).
   */
  app.get("/portal/risk", async (req) => {
    const { pharmacyCode } = await requireSession(req);
    const { level, limit, offset } = riskQuery.parse(req.query);
    await sim.reconcileAlerts(pharmacyCode);
    const all = (await sim.stockRisk(pharmacyCode)).filter((r) => !level || r.assessment.level === level);
    const page = all.slice(offset, offset + limit);
    const names = await medicineNames(page.map((r) => r.medicineCode));
    return {
      data: page.map((r) => ({
        medicineCode: r.medicineCode,
        medicineName: names.get(r.medicineCode) ?? r.medicineCode,
        ...riskView(r.assessment),
        alert: r.alert && { alertId: r.alert.alertId, state: "ACTIVE" as const, createdAt: r.alert.createdAt.toISOString() },
      })),
      meta: { total: all.length, limit, offset, hasMore: offset + page.length < all.length, threshold: config.lowStockThreshold, thresholdSetting: "LOW_STOCK_THRESHOLD", formulaVersion: page[0]?.assessment.formulaVersion ?? 1, salesSpeedUsed: false },
    };
  });

  /** The risk explanation for one medicine of this pharmacy. 404 NOT_STOCKED for one it does not carry, even if another pharmacy does. */
  app.get("/portal/risk/:code", async (req) => {
    const { pharmacyCode } = await requireSession(req);
    const { code } = codeParam.parse(req.params);
    await sim.reconcileAlerts(pharmacyCode);
    const found = (await sim.stockRisk(pharmacyCode)).find((r) => r.medicineCode === code);
    if (!found) throw new AppError(404, "NOT_STOCKED", `${pharmacyCode} does not carry ${code}`);
    const names = await medicineNames([code]);
    return {
      data: { medicineCode: code, medicineName: names.get(code) ?? code, ...riskView(found.assessment), alert: found.alert && { alertId: found.alert.alertId, state: "ACTIVE" as const, createdAt: found.alert.createdAt.toISOString() } },
      meta: { threshold: config.lowStockThreshold, thresholdSetting: "LOW_STOCK_THRESHOLD", salesSpeedUsed: false },
    };
  });

  /** The pharmacy's low-stock alerts, newest first: `state` ACTIVE (default), RESOLVED or ALL. An active alert also carries today's risk assessment. */
  app.get("/portal/alerts", async (req) => {
    const { pharmacyCode } = await requireSession(req);
    const { state, limit, offset } = alertsQuery.parse(req.query);
    await sim.reconcileAlerts(pharmacyCode);
    const { items, total } = await sim.alertHistory(pharmacyCode, { state, limit, offset });
    const names = await medicineNames([...new Set(items.map((a) => a.medicineCode))]);
    return {
      data: items.map((a) => alertView(a, names, config.lowStockThreshold)),
      meta: { total, limit, offset, hasMore: offset + items.length < total, state, threshold: config.lowStockThreshold },
    };
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
