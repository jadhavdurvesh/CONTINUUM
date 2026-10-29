import { useCallback, useRef } from "react";

/** A callback with a stable identity that always calls the latest function (avoids effect re-runs on every parent render). */
export function useStable<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(((...args: any[]) => ref.current(...args)) as T, []);
}
