import { useCallback, useLayoutEffect, useMemo, useState } from "react";

/** Each request belongs to one immutable pane/history/tool target. Aborting saves
 * work; identity checks also reject responses whose transport ignores cancellation. */
export function useWholeOutput(url: string | null, scope: string) {
  const owner = useMemo(() => ({ controller: null as AbortController | null, active: true }), [url, scope]);
  const [result, setResult] = useState<{ owner: typeof owner; text: string | null; state: "idle" | "loading" | "failed" } | null>(null);
  useLayoutEffect(() => {
    owner.active = true;
    return () => { owner.active = false; owner.controller?.abort(); owner.controller = null; };
  }, [owner]);
  const load = useCallback(() => {
    if (url === null || !owner.active || owner.controller) return;
    const controller = new AbortController();
    owner.controller = controller;
    const current = () => owner.active && owner.controller === controller && !controller.signal.aborted;
    setResult({ owner, text: null, state: "loading" });
    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        const text = await response.text();
        if (current()) setResult({ owner, text, state: "idle" });
      } catch {
        if (current()) setResult({ owner, text: null, state: "failed" });
      } finally {
        if (owner.controller === controller) owner.controller = null;
      }
    })();
  }, [url, owner]);
  return { text: result?.owner === owner ? result.text : null, state: result?.owner === owner ? result.state : "idle", load };
}
