import { Cluster, Redis as IORedis } from "ioredis";

/**
 * The client type used everywhere. In cluster mode the real object is an ioredis `Cluster`. It has the same
 * command methods (and routes each command by its key), so callers don't care which one they hold. The cast is
 * the one place this is asserted.
 */
export type Redis = IORedis;

export interface RedisOptions {
  /** Standalone: a redis:// URL. Ignored when `cluster` is set. */
  url?: string;
  /** Cluster: seed nodes. One reachable node is enough, the rest is discovered. */
  cluster?: ClusterOptions;
  /** Shown in CLIENT LIST, to tell the services apart. */
  name?: string;
  /**
   * true  (producers): a command fails quickly when Redis is unreachable, so the caller can keep its work
   *                    queued upstream and retry.
   * false (consumers): keep reconnecting and retrying forever.
   */
  failFast?: boolean;
  /** A command that has not answered after this long fails (default: none). For callers that must not wait on Redis. */
  commandTimeoutMs?: number;
  /** Called for connection errors. Always attached: an unhandled 'error' event would crash the process. */
  onError?: (err: Error) => void;
}

export interface ClusterOptions {
  nodes: { host: string; port: number }[];
  /**
   * Cluster nodes tell clients to connect to the address they announce. In docker that is a name only the
   * compose network knows ("redis-node-1:7001"); this maps it to something reachable, e.g. 127.0.0.1:7001.
   * Not needed when nodes announce addresses the client can reach directly.
   */
  natMap?: Record<string, { host: string; port: number }>;
}

export function createRedis(opts: RedisOptions): Redis {
  const retryStrategy = (attempt: number) => Math.min(attempt * 200, 2000);
  const maxRetriesPerRequest = opts.failFast ? 1 : null;

  let client: Redis;
  if (opts.cluster) {
    client = new Cluster(opts.cluster.nodes, {
      natMap: opts.cluster.natMap,
      clusterRetryStrategy: retryStrategy,
      // MOVED / ASK redirections and failover are retried by the client; this bounds how long a command may wait.
      redisOptions: { connectionName: opts.name, maxRetriesPerRequest, commandTimeout: opts.commandTimeoutMs },
    }) as unknown as Redis;
  } else {
    if (!opts.url) throw new Error("createRedis needs `url` (standalone) or `cluster`");
    client = new IORedis(opts.url, { connectionName: opts.name, maxRetriesPerRequest, retryStrategy, commandTimeout: opts.commandTimeoutMs });
  }
  client.on("error", (err) => opts.onError?.(err));
  return client;
}

/** True if `client` is a cluster client. */
export const isCluster = (client: Redis): boolean => (client as unknown) instanceof Cluster;

/**
 * Reads the connection settings from the environment.
 *   REDIS_MODE=standalone (default)  uses REDIS_URL
 *   REDIS_MODE=cluster               uses REDIS_CLUSTER_NODES ("host:port,host:port"), and for a docker cluster
 *                                    REDIS_CLUSTER_NAT=local to map the announced node names to 127.0.0.1
 */
export function redisOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<RedisOptions, "url" | "cluster"> {
  if ((env.REDIS_MODE ?? "standalone") !== "cluster") {
    if (!env.REDIS_URL) throw new Error("REDIS_URL is not set (copy .env.example to .env and run `npm run infra:up`)");
    return { url: env.REDIS_URL };
  }
  const nodes = (env.REDIS_CLUSTER_NODES ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(parseNode);
  if (nodes.length === 0) throw new Error("REDIS_MODE=cluster needs REDIS_CLUSTER_NODES (host:port,host:port,...)");
  let natMap: ClusterOptions["natMap"];
  if (env.REDIS_CLUSTER_NAT === "local") {
    // The compose cluster: node i announces "redis-node-i:700i" and publishes 700i on localhost.
    natMap = {};
    for (let i = 1; i <= 6; i++) natMap[`redis-node-${i}:${7000 + i}`] = { host: "127.0.0.1", port: 7000 + i };
  }
  return { cluster: { nodes, natMap } };
}

function parseNode(s: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(s);
  if (!m) throw new Error(`invalid cluster node "${s}", expected host:port`);
  return { host: m[1]!, port: Number(m[2]) };
}

/**
 * The nodes that hold data: the one server for standalone, every master for a cluster.
 * A cluster client that has only just been created lists its seed addresses until it has learned the real topology,
 * and then closes those connections: asking for the nodes first would hand out handles that are about to be closed.
 * Any command waits until the client is ready, so one is sent first.
 */
async function dataNodes(client: Redis): Promise<Redis[]> {
  if (!isCluster(client)) return [client];
  await client.ping();
  return (client as unknown as Cluster).nodes("master") as unknown as Redis[];
}

/**
 * All keys matching `pattern`. Uses SCAN on every master (KEYS on a cluster client only asks one node, which would
 * silently miss most keys). Meant for tests and tools, not for hot paths.
 */
export async function scanKeys(client: Redis, pattern: string): Promise<string[]> {
  const found = new Set<string>();
  for (const node of await dataNodes(client)) {
    let cursor = "0";
    do {
      const [next, keys] = await node.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      for (const k of keys) found.add(k);
    } while (cursor !== "0");
  }
  return [...found];
}

/** Deletes keys one at a time, since the keys of a cluster live in different slots (a multi-key DEL would fail). */
export async function deleteAll(client: Redis, keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => client.del(k)));
}

/**
 * ioredis reports some failures (e.g. a refused connection) as errors with an empty message.
 * Falls back to the error code / name so logs always say something useful.
 */
export function describeError(err: unknown): string {
  const e = err as { message?: string; code?: string; name?: string; errors?: unknown[] };
  const nested = Array.isArray(e.errors) && e.errors.length ? ` (${e.errors.map(describeError).join(", ")})` : "";
  return (e.message || e.code || e.name || "unknown error") + nested;
}
