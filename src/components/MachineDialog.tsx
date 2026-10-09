import { useEffect, useRef, useState } from "react";
import { Monitor, X } from "lucide-react";
import type { Machine, SetupAction, SetupJob } from "../../shared/machines.ts";
import { answerMachineSetup, fetchMachineSetup, startMachineSetup } from "../lib/api.ts";
import { sshOutputParts } from "../lib/sshOutput.ts";
import { BridgeUpdateProgress } from "./MachineSidebar.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";

export function MachineDialog({ machine, updateRemote = false, onClose, onConnected }: { machine?: Machine; updateRemote?: boolean; onClose(): void; onConnected(id: string): void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const destinationField = useRef<HTMLInputElement>(null);
  const [destination, setDestination] = useState(machine?.target?.destination ?? "");
  const [name, setName] = useState(machine?.name ?? "");
  const [port, setPort] = useState(String(machine?.target?.port ?? ""));
  const [key, setKey] = useState(machine?.target?.identity_file ?? "");
  const [session, setSession] = useState(machine?.target?.session ?? "");
  const [job, setJob] = useState<SetupJob | null>(null);
  const jobRef = useRef(job); jobRef.current = job;
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const finished = !!job && ["failed", "cancelled", "connected"].includes(job.phase);
  const secretAllowed = window.isSecureContext;

  // closing cancels a job that still waits on this dialog (a question, an approval); an
  // approved install keeps going on the server and shows in the sidebar
  // React's autoFocus runs at mount, while the dialog is still closed; showModal() then moves focus
  // to the first focusable element (Close), so the field is focused again once the dialog is open
  useEffect(() => { dialog.current?.showModal(); destinationField.current?.focus(); return () => { const current = jobRef.current; if (current && !["connected", "failed", "cancelled", "installing", "starting"].includes(current.phase)) void answerMachineSetup(current.id, { action: "cancel" }).catch(() => {}); }; }, []);
  const running = !!job && ["installing", "starting"].includes(job.phase);
  useEffect(() => {
    if (!job || finished) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      try { const next = await fetchMachineSetup(job.id); if (!cancelled) { setJob(next); setError(null); } }
      catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); }
      if (!cancelled) timer = window.setTimeout(poll, 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job?.id, finished]);
  useEffect(() => setSecret(""), [job?.challenge?.id]);

  const begin = async () => {
    setError(null); setPending(true);
    try { setJob(await startMachineSetup({ destination: destination.trim(), ...(name.trim() ? { name: name.trim() } : {}), ...(port ? { port: Number(port) } : {}), ...(key.trim() ? { identity_file: key.trim() } : {}), ...(session.trim() ? { session: session.trim() } : {}), ...(machine ? { machine_id: machine.id, update_remote: updateRemote } : {}) })); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  const act = async (action: SetupAction) => {
    if (!job || pending) return;
    setPending(true); setError(null); setSecret("");
    try { setJob(await answerMachineSetup(job.id, action)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  return <dialog ref={dialog} className="modal machine-dialog" aria-labelledby="machine-dialog-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header className="modal-header"><h2 id="machine-dialog-title" className="modal-title"><Monitor size={18} /> {t(updateRemote ? "Update remote bridge" : machine ? "Reconnect PC" : "Add PC")}</h2><button className="icon-button" aria-label={t("Close PC setup")} onClick={onClose}><X /></button></header>
    <div className="modal-body">
      {(!job || finished && job.phase !== "connected") && <form id="machine-connect-form" onSubmit={(e) => { e.preventDefault(); void begin(); }}>
        <label className="field"><span className="field-label">{t("SSH alias or user@address")}</span><input ref={destinationField} autoFocus className="input" required autoComplete="off" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="devbox or user@192.168.1.20" /></label>
        <label className="field"><span className="field-label">{t("PC name")}</span><input className="input" maxLength={100} value={name} placeholder={destination || t("Filled from the SSH address")} onChange={(e) => setName(e.target.value)} /></label>
        <details><summary>{t("Advanced settings")}</summary><div className="machine-advanced">
          <label className="field"><span className="field-label">{t("SSH port")}</span><input className="input" type="number" min="1" max="65535" placeholder={t("From SSH config (default 22)")} value={port} onChange={(e) => setPort(e.target.value)} /></label>
          <label className="field"><span className="field-label">{t("Private key path on this web server")}</span><input className="input" value={key} placeholder="~/.ssh/id_ed25519" onChange={(e) => setKey(e.target.value)} /></label>
          <label className="field"><span className="field-label">{t("herdr session name")}</span><input className="input" value={session} placeholder={t("Default session")} onChange={(e) => setSession(e.target.value)} /></label>
        </div></details>
        <p className="field-hint">{t("Uses the web server account’s SSH config and ssh-agent. Agent CLI tools and logins use the environment on the target PC.")}</p>
      </form>}
      {job && <div className="machine-progress" role="status">{running && job.progress ? <BridgeUpdateProgress update={{ job_id: job.id, step: job.step, progress: job.progress }} /> : <strong>{job.step}</strong>}{job.error && <p>{job.error}</p>}{job.ssh_output && <pre className="machine-ssh-output" aria-label={t("SSH output")}>{sshOutputParts(job.ssh_output).map((part, i) => part.type === "link" ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.value}</a> : part.value)}</pre>}</div>}
      {running && <p className="field-hint">{t("You can close this; the install keeps going and the sidebar shows it.")}</p>}
      {job?.phase === "approval" && <><ul className="machine-install-list">{job.installations.map((item) => <li key={item}>{item}</li>)}</ul><p className="field-hint">{t("Installs into your home directory. Existing herdr sessions keep running.")}</p></>}
      {job?.challenge && <div className="machine-challenge"><pre>{job.challenge.prompt}</pre>{job.challenge.kind === "host_key" ? <p className="field-hint">{t("Compare this fingerprint with the PC before accepting it.")}</p> : <form onSubmit={(e) => { e.preventDefault(); void act({ action: "answer", challenge_id: job.challenge!.id, answer: secret }); }}>
        <label className="field"><span className="field-label">{t("Password or key passphrase")}</span><input autoFocus className="input" type="password" autoComplete="off" value={secret} disabled={!secretAllowed || pending} onChange={(e) => setSecret(e.target.value)} /></label>
        {!secretAllowed && <p className="field-hint">{t("Open this app over HTTPS or localhost to enter a password.")}</p>}
        <button type="submit" className="btn btn-primary" disabled={!secretAllowed || pending || !secret}>{t("Continue")}</button>
      </form>}</div>}
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer">
      {job && !finished && <button className="btn" disabled={pending} onClick={() => void act({ action: "cancel" })}>{t(running ? "Cancel install" : "Cancel connection")}</button>}
      {running && <button className="btn btn-primary" onClick={onClose}>{t("Continue in background")}</button>}
      {job?.challenge?.kind === "host_key" && <><button className="btn" disabled={pending} onClick={() => void act({ action: "answer", challenge_id: job.challenge!.id, answer: "no" })}>{t("Reject")}</button><button className="btn btn-primary" disabled={pending} onClick={() => void act({ action: "answer", challenge_id: job.challenge!.id, answer: "yes" })}>{t("Trust fingerprint")}</button></>}
      {job?.phase === "approval" && <button className="btn btn-primary" disabled={pending} onClick={() => void act({ action: "approve" })}>{t("Install and connect")}</button>}
      {job?.phase === "connected" ? <button className="btn btn-primary" onClick={() => onConnected(job.machine_id)}>{t("Open PC")}</button> : (!job || finished) && <button className="btn btn-primary" form="machine-connect-form" type="submit" disabled={pending}>{t(pending ? "Connecting…" : job ? "Retry connection" : "Connect")}</button>}
    </footer>
  </dialog>;
}
