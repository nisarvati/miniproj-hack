import { randomUUID } from "node:crypto";
import { eventStreamKey, STREAM_EVENT_FIELD, streamRegistryKey, type InventoryEvent } from "@medlink/event-schema";
import { createRedis, deleteAll, redisOptionsFromEnv, scanKeys, type Redis } from "@medlink/redis";

export const GROUP = "inventory-sync";

export function connect(): Redis {
  // Standalone by default; REDIS_MODE=cluster runs the same tests against the compose cluster.
  return createRedis({ ...redisOptionsFromEnv(), onError: () => undefined });
}

/** Every test uses its own key prefix, so tests never touch each other's or development data. */
export const newPrefix = () => `test-${randomUUID().slice(0, 8)}`;

export async function deleteKeys(redis: Redis, prefix: string): Promise<void> {
  await deleteAll(redis, await scanKeys(redis, `${prefix}:*`));
}

let counter = 0;
export function makeEvent(over: Partial<Record<string, unknown>> = {}): InventoryEvent {
  counter++;
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    eventType: "SALE",
    pharmacyId: "P001",
    medicineId: "M001",
    quantityDelta: -1,
    quantityAfter: 10 + counter,
    price: 25,
    timestamp: new Date().toISOString(),
    ...over,
  } as InventoryEvent;
}

/** Writes an event the way a connector does: register the stream, then XADD the JSON. */
export async function publish(redis: Redis, prefix: string, event: InventoryEvent): Promise<string> {
  const key = eventStreamKey(event.pharmacyId, prefix);
  await redis.sadd(streamRegistryKey(prefix), key);
  return (await redis.xadd(key, "*", STREAM_EVENT_FIELD, JSON.stringify(event))) as string;
}

/** Writes an arbitrary (possibly broken) entry into a pharmacy's stream. */
export async function publishRaw(redis: Redis, prefix: string, pharmacyId: string, fields: string[]): Promise<string> {
  const key = eventStreamKey(pharmacyId, prefix);
  await redis.sadd(streamRegistryKey(prefix), key);
  return (await redis.xadd(key, "*", ...fields)) as string;
}

/** Entries delivered to a consumer but not yet acknowledged. */
export async function pendingCount(redis: Redis, key: string, group = GROUP): Promise<number> {
  try {
    const summary = (await redis.xpending(key, group)) as [number, ...unknown[]];
    return Number(summary[0]);
  } catch {
    return 0; // group (or stream) doesn't exist yet
  }
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
