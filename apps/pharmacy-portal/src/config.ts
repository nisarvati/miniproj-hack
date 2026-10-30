import { z } from "zod";

const DEV_SECRET = "medlink-dev-only-session-secret-change-me";

const schema = z.object({
  PORTAL_PORT: z.coerce.number().int().min(1).max(65535).default(4200),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORTAL_SESSION_SECRET: z.string().min(16, "PORTAL_SESSION_SECRET must be at least 16 characters").optional(),
  PORTAL_SESSION_HOURS: z.coerce.number().positive().default(8),
  /** Units at or below which a medicine counts as low on stock. The same setting the search service uses for its "low stock" label. */
  LOW_STOCK_THRESHOLD: z.coerce.number().int().min(1).max(1_000_000).default(5),
  NODE_ENV: z.string().optional(),
  /** How many reverse proxies stand in front of the portal ("2": Vercel then Render). Unset or 0: none, req.ip is the connecting address. */
  TRUST_PROXY: z.string().regex(/^\d{1,2}$/, "TRUST_PROXY must be a number of proxy hops, such as 2").optional(),
});

export interface Config {
  PORT: number;
  HOST: string;
  DATABASE_URL: string;
  LOG_LEVEL: z.infer<typeof schema>["LOG_LEVEL"];
  corsOrigins: string[];
  sessionSecret: string;
  sessionMs: number;
  /** True in production: the session cookie is then also marked Secure. */
  secureCookies: boolean;
  /** LOW_STOCK_THRESHOLD: where low-stock alerts open, and the threshold the risk score is measured against. */
  lowStockThreshold: number;
  /** Passed to Fastify: a hop count, or false. It decides which address `req.ip` is, and so whom the login throttle counts. */
  trustProxy: number | false;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === "production";
  if (production && !e.PORTAL_SESSION_SECRET) throw new Error("Invalid configuration: PORTAL_SESSION_SECRET is required in production");
  // The built-in secret is public (it is in the source): fine for a portal only this machine can reach, never for one other machines can.
  if (!e.PORTAL_SESSION_SECRET && !["127.0.0.1", "localhost", "::1"].includes(e.HOST)) {
    throw new Error(`Invalid configuration: PORTAL_SESSION_SECRET is required when HOST is ${e.HOST} (anything but this machine). Set a secret of at least 16 characters.`);
  }
  return {
    PORT: e.PORTAL_PORT,
    HOST: e.HOST,
    DATABASE_URL: e.DATABASE_URL,
    LOG_LEVEL: e.LOG_LEVEL,
    corsOrigins: e.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    sessionSecret: e.PORTAL_SESSION_SECRET ?? DEV_SECRET,
    sessionMs: e.PORTAL_SESSION_HOURS * 3_600_000,
    secureCookies: production,
    lowStockThreshold: e.LOW_STOCK_THRESHOLD,
    trustProxy: e.TRUST_PROXY && Number(e.TRUST_PROXY) > 0 ? Number(e.TRUST_PROXY) : false,
  };
}
