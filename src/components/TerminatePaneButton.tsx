import { useState } from "react";
import { X, Trash2 } from "lucide-react";
import { closePane, fetchSession } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

export function TerminatePaneButton({ pane, machineId, disabled, onTerminated, compact = false, toolbar = false, dialogOnly = false, onClose }: {
  pane: { pane_id: string; terminal_id: string }; machineId: string; disabled?: boolean;
  onTerminated: () => void | Promise<void>; compact?: boolean; toolbar?: boolean; dialogOnly?: boolean; onClose?: () => void;
}) {
  const t = useT();
  const [target, setTarget] = useState<typeof pane | null>(dialogOnly?{...pane}:null);
  const terminate = async () => {
    if (!target) return;
    await closePane(target.pane_id, machineId, target.terminal_id);
    // Wait for native disappearance. Never hide optimistically or repeat a close automatically.
    for (let attempt = 0; attempt < 20; attempt++) {
      const snapshot = await fetchSession(machineId);
      if (!snapshot.panes.some(p => p.terminal_id === target.terminal_id)) {
        await onTerminated(); setTarget(null); onClose?.(); return;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(t("Terminal shutdown is not confirmed. Refresh the list before trying again."));
  };
  return <>
    {!dialogOnly&&<button type="button" className={toolbar ? "dock-delete" : compact ? "sidebar-row-action terminal-close" : undefined}
      disabled={disabled || !pane.terminal_id} aria-label={t("Terminate terminal {id}", { id: pane.pane_id })}
      title={t("Terminate terminal {id}", { id: pane.pane_id })}
      onClick={event => { event.stopPropagation(); setTarget({pane_id:pane.pane_id,terminal_id:pane.terminal_id}); }}>
      {toolbar ? <><Trash2 size={16} aria-hidden="true" />{t("Delete")}</> : compact ? <X aria-hidden="true" /> : t("Terminate terminal")}
    </button>}
    {target && <ConfirmDialog title={t("Terminate this terminal?")}
      body={t("The terminal and its running processes will stop. Unsaved work may be lost.")}
      confirmLabel={t("Terminate")} onConfirm={terminate} onClose={() => {setTarget(null);onClose?.();}} />}
  </>;
}
