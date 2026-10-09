type NumberedPane = { pane_id: string; global_pane_number?: number };
/** Never derive a global number from the session-local :pN suffix. */
export function paneNumber(pane: NumberedPane | string | undefined): string {
  if (!pane) return "—";
  if (typeof pane === "string") return pane;
  return Number.isSafeInteger(pane.global_pane_number) && pane.global_pane_number! > 0
    ? `P${pane.global_pane_number}` : pane.pane_id;
}
