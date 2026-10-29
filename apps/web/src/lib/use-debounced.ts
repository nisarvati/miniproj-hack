"use client";

import { useEffect, useState } from "react";

/** `value`, but only after it has stopped changing for `ms`: so typing does not fire a request per keystroke. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
