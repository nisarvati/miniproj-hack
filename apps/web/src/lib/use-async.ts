"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> =
  | { status: "idle"; data: null; error: null }
  | { status: "loading"; data: T | null; error: null }
  | { status: "success"; data: T; error: null }
  | { status: "error"; data: T | null; error: Error };

/**
 * Runs `load` when `deps` change (and `enabled`), aborting the previous run. Keeps the last good data on screen
 * while the next run is loading, so lists don't flash empty on every change. Only the latest run may update state.
 */
export function useAsync<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], enabled = true): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: "idle", data: null, error: null });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle", data: null, error: null });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ status: "loading", data: s.data, error: null }));
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "success", data, error: null });
      },
      (err: unknown) => {
        if (controller.signal.aborted || (err as Error).name === "AbortError") return;
        setState((s) => ({ status: "error", data: s.data, error: err instanceof Error ? err : new Error(String(err)) }));
      },
    );
    return () => controller.abort();
    // `deps` is the caller's explicit dependency list.
  }, [...deps, enabled, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload } as AsyncState<T> & { reload: () => void };
}
