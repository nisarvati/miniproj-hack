export { SyncService, DEFAULT_SYNC_OPTIONS, type SyncOptions } from "./service.js";
export { SyncStatusHandler, type EventHandler, type HandlerContext } from "./handler.js";
export { silentLogger, type Logger } from "./logger.js";
export { DedupHandler, EventInFlightError, DEFAULT_DEDUP_OPTIONS, type DedupOptions } from "./dedup.js";
export { InventoryStateHandler, CompositeHandler, type InventoryItem, type ApplyResult } from "./state.js";
export { createSyncHandler } from "./handlers.js";
export { CatalogueMirror } from "./mirror.js";
