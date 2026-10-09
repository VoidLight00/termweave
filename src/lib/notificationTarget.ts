type Target = { machine_id: string; pane_id: string };
type Select = (target: Target) => void;
type MessageSource = { addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void };

/** Keep the newest target until App is ready, then deliver new selections directly. */
export function notificationTargets(source?: MessageSource): (select: Select) => () => void {
  let pending: Target | null = null;
  let consumer: Select | null = null;
  source?.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown; pane_id?: unknown; machine_id?: unknown } | null;
    if (data?.type !== "select-pane" || typeof data.pane_id !== "string") return;
    const target = { machine_id: typeof data.machine_id === "string" ? data.machine_id : "local", pane_id: data.pane_id };
    if (consumer) consumer(target);
    else pending = target;
  });
  return (select) => {
    consumer = select;
    const target = pending;
    pending = null;
    if (target) select(target);
    return () => { if (consumer === select) consumer = null; };
  };
}

// Browser messages can arrive after document loading but before React's effect.
// Install this listener while App's module loads, before creating its root.
export const onNotificationTarget = notificationTargets(
  typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
);
