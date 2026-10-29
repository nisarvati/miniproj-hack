import pino from "pino";
export { silentLogger, type Logger } from "@medlink/inventory-sync";
import type { Logger } from "@medlink/inventory-sync";

export const createLogger = (level = "info"): Logger => pino({ level, base: { service: "notification-service" } });
