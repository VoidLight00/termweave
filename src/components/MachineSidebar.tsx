import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, Monitor, Plus, Settings, SlidersHorizontal } from "lucide-react";
import type { Machine, MachineState, MachineUpdate } from "../../shared/machines.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { answerMachineSetup, machineRequest } from "../lib/api.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { Sidebar } from "./Sidebar.tsx";
import { NeedsInput } from "./NeedsInput.tsx";
import { UsageMeters, UsagePanel } from "./UsageMeters.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";

import { PRODUCT_LABEL } from "../../shared/product.ts";

/** The PC header's state word; "connected" is the quiet default and shows as a dot alone. */
export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

interface Props { machines: Machine[]; selectedMachineId: string; selectedPaneId: string | null; selectedWorkspaceId?: string | null; onSelectWorkspace?: (machine: string, workspace: string) => void; actions: AppActions; version: string | null; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onSetup(machine: Machine, update?: boolean): void }
export function MachineSidebar(props: Props) {
  const t = useT();
  const { canInstall, installed, install, help } = useInstallPrompt();
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  // no top bar: a session starts from its PC's header, and Add PC lives in Settings → Remote PCs
  return <div className="sidebar-shell">
    <UsagePanel />
    <div className="machine-list" aria-label={t("PCs and workspaces")}>
      <NeedsInput machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} onSelect={props.onSelect} />
      {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} />)}
      {!props.machines.length && <p className="tree-state" role="status">{t("Loading PCs…")}</p>}
    </div>
    <footer className="sidebar-footer">
      {/* browsers without an install prompt (iOS, plain HTTP) get the steps instead */}
      {!installed && <button className="btn btn-ghost sidebar-footer-action" aria-expanded={canInstall ? undefined : installHelpOpen} onClick={() => { if (canInstall) void install(); else setInstallHelpOpen(!installHelpOpen); }}><Download aria-hidden="true" />{t("Install app")}</button>}
      {!installed && !canInstall && installHelpOpen && <p className="sidebar-install-help" role="status">{help}</p>}
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action" title={t("Settings (⌘⇧,)")} onClick={props.actions.openSettings}><Settings aria-hidden="true" />{t("Settings")}</button>
        <UsageMeters />
      </div>
      <div className="sidebar-brandline">
        <img src="/icons/termweave-v2-64.png" alt="" width="20" height="20" className="brand-mark" />
        <span className="sidebar-app-name">{PRODUCT_LABEL}</span>
      </div>
    </footer>
  </div>;
}

function MachineGroup({ machine, ...props }: Props & { machine: Machine }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`termweave:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(machine.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  const mutate = async (method: string, body?: unknown) => {
    try { await machineRequest(`/${machine.id}`, method, body); setError(null); if (method === "DELETE" && props.selectedMachineId === machine.id) props.onSelect("local", null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const actions: AppActions = { ...props.actions, selectPane: (id) => props.onSelect(machine.id, id), openNewSession: () => props.onNew(machine.id) };
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(`termweave:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {}
  };
  return <section className={`machine-group${props.selectedMachineId === machine.id ? " is-current" : ""}`} aria-label={t("PC {name}", { name: machine.name })}>
    <header className="machine-header">
      <button className="machine-toggle" aria-expanded={!collapsed} onClick={toggle}>
        {collapsed ? <ChevronRight className="machine-caret" aria-hidden="true" /> : <ChevronDown className="machine-caret" aria-hidden="true" />}
        <Monitor className="machine-icon" aria-hidden="true" />
        <span className="machine-name">{machine.name}</span>
        {/* the computer this app's server runs on; on a phone "this PC" read as the phone */}
        {machine.kind === "local" && <span className="machine-kind" title={t("The computer this app runs on")}>{t("Host")}</span>}
        <span className={`machine-dot is-${machine.state}`} title={t(STATE_WORD[machine.state])} aria-hidden="true" />
      </button>
      <button className="sidebar-row-action" disabled={!online} aria-label={t("New folder session on {name}", { name: machine.name })} title={t("New folder session")} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
      {machine.kind === "ssh" && <button className="sidebar-row-action" aria-label={t("Manage {name}", { name: machine.name })} title={t("Manage PC")} aria-expanded={editing} onClick={() => { setEditing(!editing); setConfirmDelete(false); }}><SlidersHorizontal aria-hidden="true" /></button>}
    </header>
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    {machine.action_required || machine.updating ? <MachineActionNotice machine={machine} onSetup={props.onSetup} /> : <p className={`machine-state is-${machine.state}${online ? " visually-hidden" : ""}`} role="status" title={machine.error ?? undefined}>
      <span className="machine-state-word">{t(STATE_WORD[machine.state])}</span>
      {machine.error && <span className="machine-state-detail">{machine.error}</span>}
    </p>}
    {editing && <div className="machine-controls">
      <form onSubmit={(e) => { e.preventDefault(); void mutate("PATCH", { name }); }}><label className="field"><span className="field-label">{t("PC name")}</span><input className="input" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} /></label><button className="btn" type="submit">{t("Rename")}</button></form>
      <div className="machine-control-buttons"><button className="btn" onClick={() => void mutate("PATCH", { enabled: !machine.enabled })}>{t(machine.enabled ? "Disconnect" : "Connect")}</button><button className="btn" onClick={() => props.onSetup(machine)}>{t("Reconnect / setup")}</button><button className="btn" onClick={() => props.onSetup(machine, true)}>{t("Update bridge…")}</button><button className="btn btn-danger" onClick={() => { if (confirmDelete) void mutate("DELETE"); else setConfirmDelete(true); }}>{t(confirmDelete ? "Confirm remove PC" : "Remove PC")}</button></div>
      {confirmDelete && <p className="field-hint">{t("Removes this registration. Remote sessions keep running.")}</p>}
    </div>}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {!collapsed && <div className={online ? "" : "machine-offline"} {...(!online ? { inert: "" } : {})}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p> : <MachineContext.Provider value={machine.id}><Sidebar snapshot={machine.snapshot} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} selectedWorkspaceId={props.selectedMachineId === machine.id ? props.selectedWorkspaceId : null} onSelectWorkspace={id => props.onSelectWorkspace?.(machine.id, id)} actions={actions} /></MachineContext.Provider>}
    </div>}
  </section>;
}

/** Seconds since the stage began, ticking on this device: install and restart have no bytes to show. */
function useStageSeconds(update: MachineUpdate): number {
  const key = `${update.job_id}:${update.progress?.stage ?? ""}`;
  const [start, setStart] = useState(() => ({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (start.key !== key) setStart({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }); }, [key]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return Math.max(0, Math.round((now - start.at) / 1000));
}

/** A bridge install in words and a bar: the step, the bytes, and roughly how long is left. */
export function BridgeUpdateProgress({ update }: { update: MachineUpdate }) {
  const view = describeProgress(update.progress);
  const seconds = useStageSeconds(update);
  if (!view) return <p className="bridge-progress-step">{update.step}</p>;
  return <div className="bridge-progress">
    <p className="bridge-progress-step"><span>{view.label}</span><span className="bridge-progress-count">{view.step}</span></p>
    <div className="bridge-progress-bar" role="progressbar" aria-label={view.label} aria-valuemin={0} aria-valuemax={100} {...(view.percent === null ? {} : { "aria-valuenow": view.percent })}>
      <span className={view.percent === null ? "is-indeterminate" : ""} style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
    </div>
    <p className="bridge-progress-detail">{view.detail ?? `${seconds} s`}</p>
  </div>;
}

/** Retrying can't reconnect this PC: say what the user has to do, with the button that does it. */
function MachineActionNotice({ machine, onSetup }: { machine: Machine; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await request(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (machine.updating) {
    const updating = machine.updating;
    return <div className="machine-action is-updating" role="status">
      <p className="machine-action-text"><strong>{t("Updating the bridge")}</strong><span>{t("You can keep using the app; this PC reconnects when it is done.")}</span></p>
      <BridgeUpdateProgress update={updating} />
      <button type="button" className="btn" disabled={busy} onClick={() => void run(() => answerMachineSetup(updating.job_id, { action: "cancel" }))}>{t("Cancel update")}</button>
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>;
  }
  const update = machine.action_required === "update_bridge";
  return <div className="machine-action" role="alert">
    <p className="machine-action-text">
      <strong>{t(update ? "Bridge update needed" : "Setup needed")}</strong>
      <span>{t(update ? "This PC runs a bridge from a different version of TermWeave. Update it to reconnect; herdr sessions keep running." : "Reconnecting needs your approval on this PC.")}</span>
      {update && machine.error && !/different version/.test(machine.error) && <span className="machine-action-reason">{machine.error}</span>}
    </p>
    {update ? <div className="machine-action-buttons">
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST"))}>{t("Update bridge")}</button>
      {/* a PC that needs a password or a new host key goes through its dialog */}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSetup(machine, true)}>{t("Sign in and update…")}</button>
    </div> : <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Set up…")}</button>}
    {error && <p className="machine-error" role="alert">{error}</p>}
  </div>;
}

/** The app-wide line for PCs that wait on the user, so a closed drawer on a phone still says so. */
export function MachineActionBanner({ machines, onSetup }: { machines: Machine[]; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  const running = machines.find((machine) => machine.updating);
  if (running?.updating) {
    const view = describeProgress(running.updating.progress);
    return <div className="update-notice" role="status">
      <span>{t("Updating the bridge on {name}", { name: running.name })}{view ? ` · ${t(view.label)}${view.percent === null ? "" : ` ${view.percent}%`}` : "…"}</span>
    </div>;
  }
  const waiting = machines.filter((machine) => machine.action_required);
  const first = waiting[0];
  if (!first) return null;
  const update = first.action_required === "update_bridge";
  const others = waiting.length > 1 ? t(" (+{n} more)", { n: waiting.length - 1 }) : "";
  return <div className="update-notice" role="status">
    <span>{t(update ? "{name} needs a bridge update to reconnect{others}." : "{name} needs setup approval to reconnect{others}.", { name: first.name, others })}</span>
    <button type="button" className="btn" onClick={() => update ? void machineRequest(`/${encodeURIComponent(first.id)}/update-bridge`, "POST").catch(() => onSetup(first, true)) : onSetup(first, false)}>{t(update ? "Update bridge" : "Set up…")}</button>
  </div>;
}
