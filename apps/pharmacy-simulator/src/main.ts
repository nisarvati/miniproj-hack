import { createInterface } from "node:readline";
import { createPool, loadPharmacyUrls, PHARMACY_CODES, type Db } from "@medlink/db";
import { InventoryStateHandler } from "@medlink/inventory-sync";
import { createRedis, describeError, redisOptionsFromEnv } from "@medlink/redis";
import { startEmbeddedPipeline, type EmbeddedPipeline } from "./pipeline.js";
import { Shell, HELP } from "./shell.js";
import { PharmacySimulator } from "./simulator.js";
import { FlowTracer } from "./tracer.js";

const args = process.argv.slice(2);
const embedded = args.includes("--embedded");
const words = args.filter((a) => a !== "--embedded");
const keyPrefix = process.env.REDIS_KEY_PREFIX;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let urls: Record<string, string>;
let connection: ReturnType<typeof redisOptionsFromEnv>;
try {
  urls = loadPharmacyUrls();
  connection = redisOptionsFromEnv();
} catch (err) {
  fail(`${(err as Error).message}\n(copy .env.example to .env, then: npm run infra:up && npm run pharmacies:setup)`);
}

const pharmacies: Record<string, Db> = Object.fromEntries(PHARMACY_CODES.map((code) => [code, createPool(urls[code])]));
const central = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : undefined;
for (const pool of [...Object.values(pharmacies), ...(central ? [central] : [])]) pool.on("error", () => undefined);

let pipeline: EmbeddedPipeline | null = null;
let redis = createRedis({ ...connection, name: "pharmacy-simulator", onError: (e) => console.error(`redis: ${describeError(e)}`) });
let state = new InventoryStateHandler(redis, { keyPrefix });
if (embedded) {
  pipeline = await startEmbeddedPipeline({ pharmacies, central, keyPrefix, redis: connection });
  redis.disconnect();
  redis = pipeline.redis;
  state = pipeline.state;
  console.log(`(embedded: the connectors, sync service${central ? " and notification service" : ""} run inside this process)`);
} else {
  console.log("(watching: the connector, sync service and notification service must be running in their own terminals)");
}

const timeoutMs = Number(process.env.SIM_TRACE_TIMEOUT_MS ?? 15_000);
const shell = new Shell({
  simulator: new PharmacySimulator(pharmacies),
  tracer: new FlowTracer({ pharmacies, redis, keyPrefix, central }),
  state,
  central,
  out: (line) => console.log(line),
  timing: { timeoutMs },
});

async function shutdown(code: number): Promise<never> {
  await pipeline?.stop();
  if (!pipeline) redis.disconnect();
  await Promise.all([...Object.values(pharmacies), ...(central ? [central] : [])].map((p) => p.end().catch(() => undefined)));
  process.exit(code);
}

try {
  if (words.length > 0) {
    // One command, e.g.  npm run simulator -- sell P001 crocin 2
    const result = await shell.run(words.join(" "));
    await shutdown(result.ok ? 0 : 1);
  }

  console.log(`MedLink pharmacy simulator. Type "demo" for a guided run, or "help".\n${HELP}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "pharmacy> " });
  rl.on("SIGINT", () => rl.close());
  rl.prompt();
  for await (const line of rl) {
    const result = await shell.run(line).catch((err: Error) => {
      console.error(`  ✗ ${err.message}`);
      return { ok: false, quit: false };
    });
    if (result.quit) break;
    rl.prompt();
  }
  await shutdown(0);
} catch (err) {
  console.error(describeError(err));
  await shutdown(1);
}
