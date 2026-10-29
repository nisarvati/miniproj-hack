import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dedupKey,
  eventStreamKey,
  inventoryIndexKey,
  inventoryItemKey,
  medicineIndexKey,
  syncStatusKey,
} from "@medlink/event-schema";
import { createRedis, isCluster, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";
import { connect, deleteKeys, newPrefix } from "./helpers.js";

// These only mean something against a real cluster: REDIS_MODE=cluster (see docs/redis-streams.md).
const clusterMode = process.env.REDIS_MODE === "cluster";

let redis: Redis;
let prefix: string;
beforeEach(() => {
  redis = connect();
  prefix = newPrefix();
});
afterEach(async () => {
  await deleteKeys(redis, prefix);
  redis.disconnect();
});

const slot = async (key: string) => Number(await redis.cluster("KEYSLOT", key));

describe.skipIf(!clusterMode)("Redis Cluster", () => {
  it("is really talking to a cluster", async () => {
    expect(isCluster(redis)).toBe(true);
    expect(String(await redis.cluster("INFO"))).toContain("cluster_state:ok");
  });

  it("keeps every key of one pharmacy in one slot, so the atomic scripts work", async () => {
    for (const p of ["P001", "P002", "P003", "P004", "P005"]) {
      const slots = await Promise.all(
        [
          eventStreamKey(p, prefix),
          syncStatusKey(p, prefix),
          dedupKey(p, "5d3c1c4e-0000-4000-8000-000000000000", prefix),
          inventoryItemKey(p, "M001", prefix),
          inventoryItemKey(p, "M999", prefix),
          inventoryIndexKey(p, prefix),
        ].map(slot),
      );
      expect(new Set(slots).size, `pharmacy ${p}`).toBe(1);
    }
  });

  it("spreads pharmacies over several masters", async () => {
    const owners = new Set<string>();
    for (const p of ["P001", "P002", "P003", "P004", "P005"]) {
      const s = await slot(eventStreamKey(p, prefix));
      owners.add(String(Math.floor(s / 5462))); // 3 masters own about a third of 16384 slots each
    }
    expect(owners.size).toBeGreaterThanOrEqual(2);
  });

  it("puts the medicine index in a different slot than the pharmacy's keys (why it is not in the atomic script)", async () => {
    expect(await slot(medicineIndexKey("M001", prefix))).not.toBe(await slot(inventoryItemKey("P001", "M001", prefix)));
  });

  it("scanKeys works on a client that was created a moment ago (before it has learned the cluster's nodes)", async () => {
    const writer = connect();
    await Promise.all(["a", "b", "c", "d", "e", "f"].map((k) => writer.set(`${prefix}:${k}`, "1"))); // spread over the shards
    const fresh = createRedis({ ...redisOptionsFromEnv(), onError: () => undefined });
    try {
      expect((await scanKeys(fresh, `${prefix}:*`)).sort()).toEqual(["a", "b", "c", "d", "e", "f"].map((k) => `${prefix}:${k}`));
    } finally {
      fresh.disconnect();
      writer.disconnect();
    }
  });

  it("rejects a script that mixes slots, which is why every pharmacy key shares a hash tag", async () => {
    await expect(
      redis.eval("return redis.call('GET', KEYS[1])", 2, `${prefix}:a`, `${prefix}:b`),
    ).rejects.toThrow(/CROSSSLOT|same slot/i);
  });
});
