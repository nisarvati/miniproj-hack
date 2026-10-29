import type { Db } from "@medlink/db";
import { dedupKey } from "@medlink/event-schema";
import type { Redis } from "@medlink/redis";
import type { ChangeResult, RecordedEvent } from "./simulator.js";

/**
 * The journey of one change, as the system itself records it. Nothing here is simulated or assumed:
 *
 *   RECORDED   the pharmacy database wrote an outbox row (we hold its event id from the same transaction)
 *   PUBLISHED  the outbox row has `published_at`: the connector put the event on the Redis stream
 *   SYNCED     the dedup marker for the event id is "done": inventory-sync applied it to the Redis state
 *   NOTIFIED   a notification row exists for the event id: the notification service fulfilled waiting users
 */
export type Stage = "RECORDED" | "PUBLISHED" | "SYNCED" | "NOTIFIED";

export interface StageUpdate {
  eventId: string;
  eventType: string;
  stage: Stage;
  /** Milliseconds since the change was committed. */
  atMs: number;
  detail?: string;
}

export interface Hint {
  eventId: string;
  /** The stage it is stuck before. */
  waitingFor: Stage;
  message: string;
}

export interface EventTrace {
  eventId: string;
  eventType: string;
  reached: Partial<Record<Stage, number>>;
  /** Notifications stored for this event. */
  notifications: number;
  /** The connector could not turn the outbox row into a valid event, so it parked it. */
  failure?: string;
  complete: boolean;
  /** The first stage that never happened, when not complete. */
  stuckBefore?: Stage;
}

export interface FollowOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** After this long stuck at a stage, say what is probably not running. */
  hintAfterMs?: number;
  /** How many users were waiting for this medicine before the change (see `waitingFor`). */
  waiting?: number;
  onStage?: (update: StageUpdate) => void;
  onHint?: (hint: Hint) => void;
}

export interface TracerDeps {
  pharmacies: Record<string, Db>;
  redis: Redis;
  keyPrefix?: string;
  /** The central MedLink database. Without it the NOTIFIED stage is not observed. */
  central?: Db;
}

const HINTS: Record<Stage, string> = {
  RECORDED: "",
  PUBLISHED: "not published yet: is the inventory connector running? (npm run connector:start)",
  SYNCED: "published but not applied yet: is the sync service running? (npm run sync:start)",
  NOTIFIED: "nobody has been notified yet: is the notification service running? (npm run notify:start)",
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FlowTracer {
  constructor(private readonly deps: TracerDeps) {}

  /** Call BEFORE a restock: how many users are waiting for this medicine, i.e. how many notifications to expect. */
  async waitingFor(medicineCode: string): Promise<number> {
    if (!this.deps.central) return 0;
    const { rows } = await this.deps.central.query<{ n: string }>(
      `SELECT count(*) AS n FROM restock_subscriptions s JOIN medicines m ON m.id = s.medicine_id
       WHERE m.code = $1 AND s.status = 'ACTIVE'`,
      [medicineCode],
    );
    return Number(rows[0]!.n);
  }

  /** Follows every event of a change until each is fully through the pipeline, fails, or the timeout passes. */
  async follow(change: ChangeResult, opts: FollowOptions = {}): Promise<EventTrace[]> {
    const started = Date.now();
    return Promise.all(change.events.map((event) => this.followOne(change, event, started, opts)));
  }

  private async followOne(change: ChangeResult, event: RecordedEvent, started: number, opts: FollowOptions): Promise<EventTrace> {
    const { timeoutMs = 15_000, pollMs = 25, hintAfterMs = 4000, waiting = 0 } = opts;
    const trace: EventTrace = { eventId: event.eventId, eventType: event.eventType, reached: {}, notifications: 0, complete: false };
    const expectNotification = event.eventType === "RESTOCK" && !!this.deps.central && waiting > 0;
    const hinted = new Set<Stage>();

    const reach = (stage: Stage, detail?: string) => {
      if (trace.reached[stage] !== undefined) return;
      const atMs = Date.now() - started;
      trace.reached[stage] = atMs;
      opts.onStage?.({ eventId: event.eventId, eventType: event.eventType, stage, atMs, detail });
    };
    reach("RECORDED");

    let lastProgress = Date.now();
    while (Date.now() - started < timeoutMs) {
      const before = Object.keys(trace.reached).length;

      if (trace.reached.PUBLISHED === undefined) {
        const { rows } = await this.deps.pharmacies[change.pharmacyCode]!.query<{ published_at: Date | null; failed_at: Date | null; error: string | null }>(
          "SELECT published_at, failed_at, error FROM outbox WHERE event_id = $1",
          [event.eventId],
        );
        const row = rows[0];
        if (row?.failed_at) {
          trace.failure = row.error ?? "the connector could not turn the change into a valid event";
          return trace;
        }
        if (row?.published_at) reach("PUBLISHED");
      }

      if (trace.reached.SYNCED === undefined && (await this.deps.redis.get(dedupKey(change.pharmacyCode, event.eventId, this.deps.keyPrefix))) === "done") {
        reach("SYNCED");
      }

      if (expectNotification && trace.reached.NOTIFIED === undefined) {
        const { rows } = await this.deps.central!.query<{ email: string }>(
          "SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.event_id = $1",
          [event.eventId],
        );
        trace.notifications = rows.length;
        if (rows.length >= waiting) reach("NOTIFIED", rows.map((r) => r.email).join(", "));
      }

      const done = trace.reached.PUBLISHED !== undefined && trace.reached.SYNCED !== undefined && (!expectNotification || trace.reached.NOTIFIED !== undefined);
      if (done) {
        trace.complete = true;
        return trace;
      }

      if (Object.keys(trace.reached).length > before) lastProgress = Date.now();
      if (Date.now() - lastProgress >= hintAfterMs) {
        const stuck = nextStage(trace, expectNotification);
        if (stuck && !hinted.has(stuck)) {
          hinted.add(stuck);
          opts.onHint?.({ eventId: event.eventId, waitingFor: stuck, message: HINTS[stuck] });
        }
      }
      await sleep(pollMs);
    }

    trace.stuckBefore = nextStage(trace, expectNotification);
    return trace;
  }
}

function nextStage(trace: EventTrace, expectNotification: boolean): Stage | undefined {
  if (trace.reached.PUBLISHED === undefined) return "PUBLISHED";
  if (trace.reached.SYNCED === undefined) return "SYNCED";
  if (expectNotification && trace.reached.NOTIFIED === undefined) return "NOTIFIED";
  return undefined;
}
