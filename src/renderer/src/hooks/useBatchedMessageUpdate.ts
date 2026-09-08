import { useCallback, useEffect, useRef } from "react";

export function useBatchedMessageUpdate<T>(
  applyUpdate: (value: T) => void,
  intervalMilliseconds = 80,
) {
  const applyRef = useRef(applyUpdate);
  const pendingRef = useRef<T | null>(null);
  const timerRef = useRef<number | null>(null);
  applyRef.current = applyUpdate;

  const cancel = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending !== null) applyRef.current(pending);
  }, []);

  const schedule = useCallback(
    (value: T) => {
      pendingRef.current = value;
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(flush, intervalMilliseconds);
    },
    [flush, intervalMilliseconds],
  );

  useEffect(() => cancel, [cancel]);

  return { schedule, flush, cancel };
}
