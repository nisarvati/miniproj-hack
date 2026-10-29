import pino from "pino";

/** The subset of pino's API the service uses, so tests can pass a stub. */
export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const createLogger = (level = "info"): Logger => pino({ level, base: { service: "inventory-sync" } });

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
