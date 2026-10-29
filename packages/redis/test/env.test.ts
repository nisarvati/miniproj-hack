import { describe, expect, it } from "vitest";
import { redisOptionsFromEnv } from "../src/index.js";

describe("redisOptionsFromEnv", () => {
  it("is standalone by default and needs REDIS_URL", () => {
    expect(redisOptionsFromEnv({ REDIS_URL: "redis://x:1" })).toEqual({ url: "redis://x:1" });
    expect(() => redisOptionsFromEnv({})).toThrow(/REDIS_URL/);
  });

  it("ignores REDIS_CLUSTER_NODES unless REDIS_MODE=cluster", () => {
    expect(redisOptionsFromEnv({ REDIS_URL: "redis://x:1", REDIS_CLUSTER_NODES: "a:1" })).toEqual({ url: "redis://x:1" });
  });

  it("reads the seed nodes in cluster mode", () => {
    const o = redisOptionsFromEnv({ REDIS_MODE: "cluster", REDIS_CLUSTER_NODES: "a:7001, b:7002" });
    expect(o.cluster?.nodes).toEqual([{ host: "a", port: 7001 }, { host: "b", port: 7002 }]);
    expect(o.cluster?.natMap).toBeUndefined();
  });

  it("maps the compose node names to localhost with REDIS_CLUSTER_NAT=local", () => {
    const o = redisOptionsFromEnv({ REDIS_MODE: "cluster", REDIS_CLUSTER_NODES: "localhost:7001", REDIS_CLUSTER_NAT: "local" });
    expect(o.cluster?.natMap?.["redis-node-3:7003"]).toEqual({ host: "127.0.0.1", port: 7003 });
    expect(Object.keys(o.cluster!.natMap!)).toHaveLength(6);
  });

  it("rejects cluster mode without nodes, and malformed nodes", () => {
    expect(() => redisOptionsFromEnv({ REDIS_MODE: "cluster" })).toThrow(/REDIS_CLUSTER_NODES/);
    expect(() => redisOptionsFromEnv({ REDIS_MODE: "cluster", REDIS_CLUSTER_NODES: "nohost" })).toThrow(/host:port/);
  });
});
