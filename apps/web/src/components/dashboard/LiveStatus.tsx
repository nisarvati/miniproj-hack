import type { LiveState } from "../../lib/live";
import { LiveDot } from "../ui/primitives";

const LABEL: Record<LiveState, { text: string; hint: string }> = {
  connecting: { text: "Connecting…", hint: "Opening the live connection" },
  connected: { text: "Live", hint: "Updates arrive as MedLink processes changes; they can lag, and Refresh always reads the current state" },
  reconnecting: { text: "Reconnecting…", hint: "The live connection dropped and is being retried; the numbers may be behind. Use Refresh to read the current state" },
  disconnected: { text: "Live updates off", hint: "No live connection. Use Refresh to read the current state" },
};

/** The connection state as a word (never colour alone), announced politely when it changes. */
export function LiveStatus({ state }: { state: LiveState }) {
  const { text, hint } = LABEL[state];
  return (
    <p aria-live="polite" title={hint} className="flex items-center gap-2 text-sm text-muted" data-live-state={state}>
      {state === "connected" ? <LiveDot /> : <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full border border-muted" />}
      <span className="sr-only">Live updates: </span>
      {text}
    </p>
  );
}
