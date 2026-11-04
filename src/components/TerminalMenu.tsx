import { useState } from "react";
import { ArrowDown, ArrowUp, Ellipsis, FolderInput, GitBranch, Pencil, Trash2 } from "lucide-react";
import type { WorktreeCreated, WorktreeOpened } from "../../shared/protocol.ts";
import { paneNumber } from "../lib/paneNumber.ts";
import { useT } from "../lib/i18n.ts";
import { RowMenu } from "./RowMenu.tsx";
import { RenamePaneButton } from "./RenamePaneButton.tsx";
import { TerminatePaneButton } from "./TerminatePaneButton.tsx";
import { WorktreeDialog } from "./WorktreeDialog.tsx";

type Pane = { pane_id: string; terminal_id: string; global_pane_number?: number; label?: string | null };
export function TerminalMenu({ pane, machineId, onRefresh, onMove, onMoveUp, onMoveDown, onWorktreeCreated, disabled = false }: {
  pane: Pane; machineId: string; onRefresh: () => void | Promise<void>; onMove?: () => void;
  onMoveUp?: () => void; onMoveDown?: () => void; onWorktreeCreated?: (created: WorktreeCreated | WorktreeOpened) => void | Promise<void>; disabled?: boolean;
}) {
  const t = useT();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [action, setAction] = useState<{ kind: "rename" | "worktree" | "delete"; pane: Pane } | null>(null);
  return <>
    <button type="button" className="sidebar-row-action terminal-menu-toggle" disabled={disabled || !pane.terminal_id}
      aria-label={`${paneNumber(pane)} ${t("Settings")}`} aria-haspopup="menu" aria-expanded={!!anchor}
      onClick={event => { event.stopPropagation(); setAnchor(anchor ? null : event.currentTarget); }}>
      <Ellipsis aria-hidden="true" />
    </button>
    {anchor && <RowMenu anchor={anchor} title={`${paneNumber(pane)} ${t("Settings")}`} subtitle={pane.label || undefined}
      onClose={() => setAnchor(null)} items={[
        { id: "rename", label: t("Rename terminal"), icon: Pencil, run: () => setAction({ kind: "rename", pane: { ...pane } }) },
        ...(onWorktreeCreated ? [{ id: "worktree", label: t("New terminal in worktree…"), icon: GitBranch, run: () => setAction({ kind: "worktree", pane: { ...pane } }) }] : []),
        ...(onMoveUp ? [{ id: "move-up", label: t("Move up"), icon: ArrowUp, run: onMoveUp }] : []),
        ...(onMoveDown ? [{ id: "move-down", label: t("Move down"), icon: ArrowDown, run: onMoveDown }] : []),
        ...(onMove ? [{ id: "move", label: t("Move to…"), icon: FolderInput, run: onMove }] : []),
        { id: "delete", label: t("Delete"), icon: Trash2, danger: true, run: () => setAction({ kind: "delete", pane: { ...pane } }) },
      ]} />}
    {action?.kind === "rename" && <RenamePaneButton dialogOnly pane={action.pane} machineId={machineId} onRenamed={onRefresh} onClose={() => setAction(null)} />}
    {action?.kind === "worktree" && onWorktreeCreated && <WorktreeDialog pane={action.pane} onCreated={onWorktreeCreated} onClose={() => setAction(null)} />}
    {action?.kind === "delete" && <TerminatePaneButton dialogOnly pane={action.pane} machineId={machineId} onTerminated={onRefresh} onClose={() => setAction(null)} />}
  </>;
}
