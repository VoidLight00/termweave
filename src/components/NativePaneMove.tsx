import { useT } from "../lib/i18n.ts";
import { useState } from "react";
import type { HerdrPane } from "../../shared/protocol.ts";
import { moveTargets } from "../../shared/paneMove.ts";

interface Props {
  source: HerdrPane | undefined;
  panes: readonly HerdrPane[];
  busy: boolean;
  move: (source: HerdrPane, target: HerdrPane) => void;
}
/** Native herdr tabs are distinct from the browser's display-only dock groups. */
export function NativePaneMove({ source, panes, busy, move }: Props) {
  const t = useT();
  const [targetId, setTargetId] = useState("");
  const targets = moveTargets(panes, source);
  const target = targets.find(pane => pane.pane_id === targetId);
  return <details className="dock-keyboard"><summary>{t("Move native workspace or tab")}</summary>
    <p>{t("Move a running terminal to another native herdr tab on this PC, not only its visual layout.")}</p>
    <label>{t("Native destination workspace and tab")}<select aria-label={t("Native destination workspace and tab")} value={target ? targetId : ""}
      disabled={busy} onChange={event => setTargetId(event.target.value)}>
      <option value="">{t("Select destination")}</option>
      {targets.map(pane => <option key={pane.pane_id} value={pane.pane_id}>{pane.workspace_id} / {pane.tab_id} · {pane.label ?? pane.title ?? pane.pane_id}</option>)}
    </select></label>
    <button type="button" disabled={busy || !source || !target} onClick={() => { if (source && target) move(source, target); }}>
      {busy ? t("Moving…") : t("Move terminal")}
    </button>
    {!targets.length && <p>{t("No other destination tab. Open another workspace or native tab first.")}</p>}
  </details>;
}
