import { z } from "zod";
import { DEFAULT_WEIGHTS, normalizeWeights, type RankingConfig } from "./modules/ranking/config.js";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOW_STOCK_THRESHOLD: z.coerce.number().int().min(1).default(5),
  RANK_WEIGHT_AVAILABILITY: z.coerce.number().min(0).default(DEFAULT_WEIGHTS.availability),
  RANK_WEIGHT_DISTANCE: z.coerce.number().min(0).default(DEFAULT_WEIGHTS.distance),
  RANK_WEIGHT_PRICE: z.coerce.number().min(0).default(DEFAULT_WEIGHTS.price),
  RANK_WEIGHT_RELEVANCE: z.coerce.number().min(0).default(DEFAULT_WEIGHTS.relevance),
  RANK_MAX_DISTANCE_KM: z.coerce.number().positive().default(15),
});

type Env = z.infer<typeof schema>;
export type Config = Pick<Env, "PORT" | "HOST" | "DATABASE_URL" | "LOG_LEVEL" | "LOW_STOCK_THRESHOLD"> & {
  corsOrigins: string[];
  ranking: Pick<RankingConfig, "weights" | "maxDistanceKm">;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  let weights;
  try {
    weights = normalizeWeights({
      availability: e.RANK_WEIGHT_AVAILABILITY,
      distance: e.RANK_WEIGHT_DISTANCE,
      price: e.RANK_WEIGHT_PRICE,
      relevance: e.RANK_WEIGHT_RELEVANCE,
    });
  } catch (err) {
    throw new Error(`Invalid configuration: ${(err as Error).message}`);
  }
  return {
    PORT: e.PORT,
    HOST: e.HOST,
    DATABASE_URL: e.DATABASE_URL,
    LOG_LEVEL: e.LOG_LEVEL,
    LOW_STOCK_THRESHOLD: e.LOW_STOCK_THRESHOLD,
    corsOrigins: e.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    ranking: { weights, maxDistanceKm: e.RANK_MAX_DISTANCE_KM },
  };
}
