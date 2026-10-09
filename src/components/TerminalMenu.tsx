import { useState } from "react";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { paneNumber } from "../lib/paneNumber.ts";
import { useT } from "../lib/i18n.ts";
import { RowMenu } from "./RowMenu.tsx";
import { RenamePaneButton } from "./RenamePaneButton.tsx";
import { TerminatePaneButton } from "./TerminatePaneButton.tsx";

type Pane = { pane_id: string; terminal_id: string; global_pane_number?: number; label?: string | null };
export function TerminalMenu({ pane, machineId, onRefresh, disabled = false }: {
  pane: Pane; machineId: string; onRefresh: () => void | Promise<void>; disabled?: boolean;
}) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [action, setAction] = useState<{ kind: "rename" | "delete"; pane: Pane } | null>(null);
  return <>
    <button type="button" className="sidebar-row-action terminal-menu-toggle" disabled={disabled || !pane.terminal_id}
      aria-label={`${paneNumber(pane)} ${t("Settings")}`} aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={event => { event.stopPropagation(); setAnchor(anchor ? null : event.currentTarget); }}>
      <Ellipsis aria-hidden="true" />
    </button>
    {anchor && <RowMenu anchor={anchor} title={`${paneNumber(pane)} ${t("Settings")}`} subtitle={pane.label || undefined}
      onClose={() => setAnchor(null)} items={[
        { id: "rename", label: t("Rename terminal"), icon: Pencil, run: () => setAction({ kind: "rename", pane: { ...pane } }) },
        { id: "delete", label: t("Delete"), icon: Trash2, danger: true, run: () => setAction({ kind: "delete", pane: { ...pane } }) },
      ]} />}
    {action?.kind === "rename" && <RenamePaneButton dialogOnly pane={action.pane} machineId={machineId} onRenamed={onRefresh} onClose={() => setAction(null)} />}
    {action?.kind === "delete" && <TerminatePaneButton dialogOnly pane={action.pane} machineId={machineId} onTerminated={onRefresh} onClose={() => setAction(null)} />}
  </>;
}
