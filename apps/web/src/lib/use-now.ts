"use client";

import { useEffect, useState } from "react";

/** The current time, re-read every `everyMs`, so "updated 12 s ago" keeps counting without a refetch. */
export function useNow(everyMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
