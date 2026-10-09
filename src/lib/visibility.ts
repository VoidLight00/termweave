import { useEffect, useState } from "react";

/**
 * Is this page on screen? A hidden tab, a minimized window or a phone app in the
 * background reads "hidden": polls pause then and pick up at once on return.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const update = (): void => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}
