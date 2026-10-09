import { useEffect } from "react";
import { usePageVisible } from "./visibility.ts";

/** A request may finish after the pane closes or the tab hides; release that late lock too. */
export function holdScreenWakeLock(wakeLock: Pick<WakeLock, "request">): () => void {
  let cancelled = false;
  let sentinel: WakeLockSentinel | null = null;
  const release = (lock: WakeLockSentinel) => { void lock.release().catch(() => undefined); };
  void wakeLock.request("screen").then((lock) => {
    if (cancelled) release(lock);
    else sentinel = lock;
  }).catch(() => {
    // Power saving, browser policy or permission may refuse it. Retry on the next visit.
  });
  return () => {
    cancelled = true;
    if (sentinel) { release(sentinel); sentinel = null; }
  };
}

export function useScreenWakeLock(enabled: boolean): void {
  const visible = usePageVisible();
  useEffect(() => {
    if (!enabled || !visible || !window.isSecureContext || !navigator.wakeLock) return;
    return holdScreenWakeLock(navigator.wakeLock);
  }, [enabled, visible]);
}
