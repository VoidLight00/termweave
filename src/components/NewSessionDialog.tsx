import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { FolderOpen, X } from "lucide-react";

import "./NewSessionDialog.css";

import type { AgentKind } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";

export interface NewSessionDialogProps {
  open: boolean;
  machineName?: string;
  defaultCwd: string | null;
  onClose: () => void;
  onCreated: (paneId: string) => void;
}

function directoryBasename(value: string): string {
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? "";
}

export function NewSessionDialog({ open, defaultCwd, onClose, onCreated, machineName }: NewSessionDialogProps) {
  const t = useT();
  const machineId = useMachineId();
  const { createWorkspace, fetchAgentKinds } = useMachineApi();
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [agentKind, setAgentKind] = useState("");
  const [cwd, setCwd] = useState(defaultCwd ?? "");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPaneId, setCreatedPaneId] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const firstFieldRef = useRef<HTMLButtonElement>(null);
  const cwdRef = useRef<HTMLInputElement>(null);
  const defaultCwdRef = useRef(defaultCwd);
  defaultCwdRef.current = defaultCwd;

  useEffect(() => {
    if (!open) return;
    setCwd(defaultCwdRef.current ?? "");
    setName("");
    setError(null);
    setPending(false);
    setCreatedPaneId(null);
    setBrowsing(true);
    // A folder session starts as a plain shell; an agent is an explicit, optional choice.
    const stored = "";
    setAgentKind(stored);
    let cancelled = false;
    void fetchAgentKinds()
      .then((next) => {
        if (cancelled) return;
        setAgents(next);
        if (stored && !next.some((agent) => agent.kind === stored)) setAgentKind("");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    window.requestAnimationFrame(() => cwdRef.current?.focus());
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!pending) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, pending]);

  if (!open) return null;

  const selectedAgent = agents.find((agent) => agent.kind === agentKind);
  const pendingLabel = selectedAgent ? t("Starting {agent}… up to 60s", { agent: selectedAgent.label }) : t("Creating folder session…");
  const fieldsDisabled = pending || createdPaneId !== null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    if (createdPaneId !== null) { onCreated(createdPaneId); return; }
    setPending(true);
    setError(null);
    try {
      const result = await createWorkspace({
        cwd: cwd.trim() || null,
        label: name.trim() || null,
        agent: agentKind ? { kind: agentKind } : null,
      });
      if (agentKind && !result.agent_started && result.error?.message) {
        setPending(false);
        setError(result.error.message);
        setCreatedPaneId(result.pane_id);
        return;
      }
      onCreated(result.pane_id);
    } catch (reason: unknown) {
      setPending(false);
      if (reason instanceof ApiError && reason.code === "invalid_cwd") setError(t("Directory not found"));
      else setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const closeFromScrim = (event: MouseEvent<HTMLDivElement>): void => {
    if (!pending && event.target === event.currentTarget) onClose();
  };

  return (
    <div className="modal-scrim new-session-scrim" onMouseDown={closeFromScrim}>
      <form className="modal new-session-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onSubmit={(event) => void submit(event)}>
        <header className="modal-header">
          <h2 className="modal-title" id="new-session-title">{t("New folder session")} · {machineName ?? machineId}</h2>
          <button type="button" className="icon-button" aria-label={t("Close new session dialog")} disabled={pending} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body">
          <div className="field">
            <label className="field-label" htmlFor="new-session-cwd">{t("Directory")}</label>
            <div className="new-session-cwd">
              <input ref={cwdRef} id="new-session-cwd" className="input" value={cwd} disabled={fieldsDisabled} autoComplete="off" onChange={(event) => setCwd(event.target.value)} />
              <button type="button" className="btn" aria-expanded={browsing} disabled={fieldsDisabled} onClick={() => setBrowsing((open) => !open)}>
                <FolderOpen aria-hidden="true" />
                {t("Browse")}
              </button>
            </div>
            {browsing && <DirectoryBrowser start={cwd} onPick={(picked) => { setCwd(picked); setBrowsing(false); }} />}
            <span className="field-hint">{t("absolute path or ~/…")}</span>
          </div>
          <label className="field">
            <span className="field-label">{t("Name")}</span>
            <input
              className="input"
              value={name}
              disabled={fieldsDisabled}
              autoComplete="off"
              placeholder={directoryBasename(cwd)}
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field-hint">{t("Optional workspace label")}</span>
          </label>
          <div className="field">
            <span className="field-label" id="new-session-agent">{t("Start program (optional)")}</span>
            <AgentPicker ref={firstFieldRef} agents={agents} value={agentKind} disabled={fieldsDisabled} labelledBy="new-session-agent" onChange={setAgentKind} />
          </div>
          {pending && <p className="new-session-note" role="status">{pendingLabel}</p>}
          {error && <p className="field-hint new-session-error" role="alert">{error}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>{t("Cancel")}</button>
          <button type="submit" className="btn btn-primary" disabled={pending}>{t(pending ? "Starting…" : createdPaneId !== null ? "Open session" : "Create folder session")}</button>
        </footer>
      </form>
    </div>
  );
}
