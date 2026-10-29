import type { Redis } from "@medlink/redis";
import { DedupHandler, type DedupOptions } from "./dedup.js";
import type { EventHandler, HandlerContext } from "./handler.js";
import { SyncStatusHandler } from "./handler.js";
import type { CatalogueMirror } from "./mirror.js";
import type { InventoryEvent } from "@medlink/event-schema";
import { CompositeHandler, InventoryStateHandler } from "./state.js";

/**
 * The handler the sync service runs: duplicate protection around "record sync status, then apply to current state".
 * One place builds it, so the real service and anything that embeds the pipeline (the pharmacy simulator) behave alike.
 * `state` is returned too, for reading the current stock back.
 */
export function createSyncHandler(
  redis: Redis,
  { mirror, ...opts }: { keyPrefix?: string; mirror?: CatalogueMirror } & Partial<Omit<DedupOptions, "keyPrefix">> = {},
): { handler: DedupHandler; state: InventoryStateHandler } {
  const state = new InventoryStateHandler(redis, { keyPrefix: opts.keyPrefix });
  // State goes last: it commits the dedup marker in the same atomic step as the stock change.
  const inner = new CompositeHandler([new SyncStatusHandler(redis, opts.keyPrefix), mirror ? new MirroredState(state, mirror) : state]);
  const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));
  return { handler: new DedupHandler(redis, inner, defined), state };
}

/**
 * The state handler, followed by a copy of the item's resulting state into the catalogue database.
 * Copies even when the event changed nothing (stale or duplicate), which is idempotent and lets a missed copy heal.
 * Still commits the dedup marker atomically with the state change, as the state handler does.
 */
class MirroredState implements EventHandler {
  readonly commitsDedupMarker = true;

  constructor(
    private readonly state: InventoryStateHandler,
    private readonly mirror: CatalogueMirror,
  ) {}

  async handle(event: InventoryEvent, ctx: HandlerContext): Promise<void> {
    await this.state.apply(event, ctx.dedupMarker);
    const item = await this.state.getItem(event.pharmacyId, event.medicineId);
    if (item) await this.mirror.mirror(item);
  }
}
