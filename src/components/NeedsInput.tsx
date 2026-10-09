import { paneNumber } from "../lib/paneNumber.ts";
import type { Machine } from "../../shared/machines.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { panesNeedingInput } from "../lib/needsInput.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import "./NeedsInput.css";

export function NeedsInput({ machines, selectedMachineId, selectedPaneId, onSelect }: {
  machines: Machine[];
  selectedMachineId: string;
  selectedPaneId: string | null;
  onSelect(machineId: string, paneId: string): void;
}) {
  const t = useT();
  const waiting = panesNeedingInput(machines);
  return <>
    <p className="visually-hidden" role="status">{t("Panes waiting for input: {n}", { n: waiting.length })}</p>
    {waiting.length > 0 && <section className="needs-input" aria-label={t("Needs you")}>
    <h2 className="needs-input-heading">{t("Needs you")} <span className="pill">{waiting.length}</span></h2>
    <ul className="pane-list">
      {waiting.map(({ machine, pane, workspace }) => {
        const selected = machine.id === selectedMachineId && pane.pane_id === selectedPaneId;
        return <li className={`needs-input-item${selected ? " is-selected" : ""}`} key={paneStorageId(machine.id, pane.pane_id)}>
          <button type="button" className="pane-select needs-input-select" aria-current={selected ? "true" : undefined} onClick={() => onSelect(machine.id, pane.pane_id)}>
            <span className="agent-mark-holder"><AgentMark agent={pane.agent ?? ""} size={22} /></span>
            <span className="pane-copy">
              <span className="pane-title"><span className="pane-number">{paneNumber(pane)}</span> {displayPaneTitle(pane)}</span>
              <span className="pane-meta"><StatusBadge status={pane.agent_status} /><span className="pane-subtitle">{machine.name} · {workspace.label}</span></span>
            </span>
          </button>
        </li>;
      })}
    </ul>
    </section>}
  </>;
}
