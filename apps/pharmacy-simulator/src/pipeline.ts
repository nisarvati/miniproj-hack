import type { Db } from "@medlink/db";
import { InventoryConnector, RedisStreamPublisher, silentLogger as connectorLogger } from "@medlink/inventory-connector";
import { CatalogueMirror, createSyncHandler, InventoryStateHandler, SyncService, silentLogger, type SyncOptions } from "@medlink/inventory-sync";
import { MockNotifier, NotificationService, type Notifier } from "@medlink/notification-service";
import { createRedis, redisOptionsFromEnv, type Redis } from "@medlink/redis";

export type Component = "connector" | "sync" | "notifications";

export interface EmbeddedPipeline {
  redis: Redis;
  state: InventoryStateHandler;
  notifier: MockNotifier | null;
  /** Starts one part (they are all started already, unless left out by `start`). Safe to call twice. */
  startComponent(component: Component): void;
  /** Stops one part, as if that service had gone down. Events wait in the stream/outbox and are caught up on restart. */
  stopComponent(component: Component): Promise<void>;
  stop(): Promise<void>;
}

export interface EmbeddedOptions {
  pharmacies: Record<string, Db>;
  /** Without the central database there is no notification service. */
  central?: Db;
  keyPrefix?: string;
  redis?: ReturnType<typeof redisOptionsFromEnv>;
  pollIntervalMs?: number;
  /** With `central`: also copy applied changes into its inventory table, as the sync service does when it has DATABASE_URL. */
  mirrorToCentral?: boolean;
  /** Overrides for the sync services (tests use short timings). */
  sync?: Partial<SyncOptions>;
  sweepIntervalMs?: number;
  /** The notification channel to use instead of the simulated one (a test passes an EmailNotifier with a fake SMTP transport). `pipeline.notifier` is then null. */
  notifier?: Notifier;
  /** Which parts to start now (default: all). Others can be started later with `startComponent`. */
  start?: Component[];
}

/**
 * The whole pipeline in this process, built from the same classes the real services use:
 * one connector per pharmacy, the sync service, and (with a central database) the notification service.
 * For a self-contained demo and for tests. In real life each runs on its own (npm run connector:start,
 * sync:start, notify:start) and the simulator only watches.
 */
export async function startEmbeddedPipeline(opts: EmbeddedOptions): Promise<EmbeddedPipeline> {
  const connection = opts.redis ?? redisOptionsFromEnv();
  const producer = createRedis({ ...connection, name: "simulator-connector", failFast: true, onError: () => undefined });
  const consumer = createRedis({ ...connection, name: "simulator-sync", onError: () => undefined });
  const publisher = new RedisStreamPublisher(producer, { keyPrefix: opts.keyPrefix });

  const connectors = Object.entries(opts.pharmacies).map(
    ([code, db]) => new InventoryConnector({ pharmacyId: code, db, publisher, logger: connectorLogger, pollIntervalMs: opts.pollIntervalMs ?? 50 }),
  );
  const { handler, state } = createSyncHandler(consumer, {
    keyPrefix: opts.keyPrefix,
    ...(opts.central && opts.mirrorToCentral && { mirror: new CatalogueMirror(opts.central) }),
  });
  const sync = new SyncService(consumer, handler, silentLogger, { keyPrefix: opts.keyPrefix, discoveryIntervalMs: 100, ...opts.sync });

  const mock = opts.central && !opts.notifier ? new MockNotifier(silentLogger) : null;
  const notifier = opts.notifier ?? mock;
  const notifications = opts.central
    ? new NotificationService(opts.central, consumer, notifier!, silentLogger, {
        keyPrefix: opts.keyPrefix,
        discoveryIntervalMs: 100,
        sweepIntervalMs: opts.sweepIntervalMs ?? 250,
        ...opts.sync,
      })
    : null;

  const running = new Set<Component>();
  const controls: Record<Component, { start(): void; stop(): Promise<void> } | null> = {
    connector: { start: () => connectors.forEach((c) => c.start()), stop: async () => void (await Promise.all(connectors.map((c) => c.stop()))) },
    sync: { start: () => sync.start(), stop: () => sync.stop() },
    notifications: notifications ? { start: () => notifications.start(), stop: () => notifications.stop() } : null,
  };
  const startComponent = (component: Component) => {
    if (running.has(component) || !controls[component]) return;
    running.add(component);
    controls[component]!.start();
  };
  const stopComponent = async (component: Component) => {
    if (!running.delete(component)) return;
    await controls[component]!.stop();
  };
  for (const component of opts.start ?? (["connector", "sync", "notifications"] as const)) startComponent(component);

  return {
    redis: consumer,
    state,
    notifier: mock,
    startComponent,
    stopComponent,
    async stop() {
      for (const component of [...running]) await stopComponent(component);
      producer.disconnect();
      consumer.disconnect();
    },
  };
}
