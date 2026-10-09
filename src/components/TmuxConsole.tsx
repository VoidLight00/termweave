import { useCallback, useEffect, useRef, useState } from "react";
import { TMUX_LAYOUTS, type TmuxAction, type TmuxState, type TmuxPaneState } from "../../shared/tmux.ts";
import { useT } from "../lib/i18n.ts";
import { TmuxScreen } from "./TmuxScreen.tsx";
import { TmuxMetadata } from "./TmuxMetadata.tsx";
import "./TmuxConsole.css";

interface Reply { state: TmuxState | null; available?: boolean; readOnly?: boolean }
const SESSION_KEY = "termweave:tmux:selected-session";
function savedSession(state: TmuxState | null): string | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (saved?.generation === state?.generation && saved?.socket === state?.socket && typeof saved?.sessionId === "string") return saved.sessionId;
  } catch { /* Storage is optional; server identities are not. */ }
}
async function request(path = "", payload?: unknown): Promise<Reply> {
  const response = await fetch(`/api/tmux${path}`, { method: payload === undefined ? "GET" : "POST",
    headers: payload === undefined ? undefined : {"content-type":"application/json"},
    body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(15000), cache:"no-store" });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `HTTP ${response.status}`);
  return value;
}

export function TmuxConsole() {
  const t = useT();
  const [state, setState] = useState<TmuxState | null>(null);
  const [available, setAvailable] = useState(false);
  const [readOnly, setReadOnly] = useState(true);
  const [session, setSession] = useState("");
  const [name, setName] = useState("");
  const [other, setOther] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); const mounted = useRef(false); const version = useRef(0);
  const apply = useCallback((reply: Reply) => {
    setState(reply.state);
    if (reply.available !== undefined) setAvailable(reply.available);
    if (reply.readOnly !== undefined) setReadOnly(reply.readOnly);
    setSession(old => {
      const wanted = old || savedSession(reply.state);
      return reply.state?.panes.some(p => p.sessionId === wanted) ? wanted! : reply.state?.panes[0]?.sessionId ?? "";
    });
  }, []);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    const id = ++version.current;
    try { const reply = await request(); if (mounted.current && id === version.current) { apply(reply); setError(""); } }
    catch (error) { if (mounted.current && id === version.current) setError(error instanceof Error ? error.message : "tmux_failed"); }
  }, [apply]);
  useEffect(() => {
    mounted.current = true; void load();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 2000);
    return () => { mounted.current = false; ++version.current; clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    if (!state || !session) return;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({socket:state.socket,generation:state.generation,sessionId:session})); } catch { /* optional preference */ }
  }, [state?.socket, state?.generation, session]);
  const mutate = async (path: string, payload: unknown) => {
    if (inFlight.current || readOnly) return;
    inFlight.current = true; ++version.current; setBusy(true); setError("");
    try { const reply = await request(path, payload); if (mounted.current) { apply(reply); return reply; } }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "tmux_failed"); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
    return false;
  };
  const panes = state?.panes.filter(p => p.sessionId === session) ?? [];
  const target = panes.find(p => p.windowActive && p.active) ?? panes[0];
  const sessions = [...new Set(state?.panes.map(p => p.sessionId) ?? [])];
  const act = (action: TmuxAction, pane: TmuxPaneState | undefined = target) => { if (pane) void mutate("/action", {target:pane,action}); };
  return <main className="tmux-console">
    <header className="tmux-header"><a href="/"><span aria-hidden="true">← </span>TermWeave</a><h1>{t("tmux workspace")}</h1><span>{t("Local machine")}</span></header>
    <div className="tmux-intro"><p>{t("Native tmux sessions keep running when this page closes. Each pane shows its server-wide ID and window-local index.")}</p>
      <p><kbd>Ctrl+b</kbd> → <kbd>q</kbd> {t("Pane numbers")} · <kbd>[</kbd> {t("Copy mode")} · <kbd>:</kbd> {t("tmux command prompt")} · <kbd>d</kbd> {t("Detach")}</p></div>
    {error && <p className="tmux-error" role="alert">{t("tmux request failed. Refresh state before repeating an operation.")} <code>{error}</code> <button className="btn" onClick={() => void load()}>{t("Refresh page")}</button></p>}
    <form className="tmux-create" onSubmit={event => { event.preventDefault(); void mutate("/session", {name}).then(reply => { if (reply) { setSession(reply.state?.panes.find(p => p.sessionName === name)?.sessionId ?? ""); setName(""); } }); }}>
      <label>{t("tmux session name")}<input className="input" value={name} onChange={event => setName(event.target.value)} pattern="[A-Za-z0-9_-]{1,80}" maxLength={80} required placeholder="project-1" /></label>
      <button className="btn" disabled={!available || readOnly || busy}>{t("Create tmux session")}</button>
      {!available && <span>{t("tmux is not available on this server.")}</span>}
      {readOnly && available && <span>{t("Read only")}</span>}
    </form>
    <nav className="tmux-sessions" aria-label={t("tmux sessions")}>{sessions.map(id => <button key={id} className="btn" aria-pressed={session === id} onClick={() => setSession(id)}>{state?.panes.find(p => p.sessionId === id)?.sessionName} <code>{id}</code></button>)}</nav>
    <div className="tmux-pane-list" aria-label={t("Pane numbers")}>{panes.map(p => <button key={`${p.sessionId}:${p.paneId}`} className="btn" disabled={readOnly || busy} aria-pressed={target?.paneId === p.paneId}
      data-tmux-pane={p.paneId} onClick={() => act({type:"select"}, p)} title={`${p.sessionName} / ${p.windowName} — ${p.sessionId}:${p.windowIndex}.${p.paneIndex} (${p.windowId}, ${p.paneId})`}>
      {p.windowIndex}.{p.paneIndex} <code>{p.paneId}</code>{p.zoomed ? " ⊙" : ""}{p.dead ? " ×" : ""}</button>)}</div>
    {target && <>
      <fieldset className="tmux-tools" disabled={busy || readOnly} aria-busy={busy}>
        <legend>{t("Pane controls")} {target.paneId}</legend>
        <button className="btn" onClick={() => act({type:"split",direction:"horizontal"})}>{t("Split left/right")}</button>
        <button className="btn" onClick={() => act({type:"split",direction:"vertical"})}>{t("Split top/bottom")}</button>
        <button className="btn" onClick={() => act({type:"zoom"})}>{t("Toggle pane zoom")}</button>
        <button className="btn" onClick={() => act({type:"new-window"})}>{t("New tmux window")}</button>
        <label>{t("Layout")}<select className="input" value="" onChange={e => { if (e.target.value) act({type:"layout",layout:e.target.value as typeof TMUX_LAYOUTS[number]}); }}><option value="">{t("Choose layout")}</option>{TMUX_LAYOUTS.map(layout => <option key={layout}>{layout}</option>)}</select></label>
        <label><input type="checkbox" checked={target.synchronized} onChange={e => { if (!e.target.checked || window.confirm(t("Send future typing to every pane in this window?"))) act({type:"synchronize",enabled:e.target.checked}); }} />{t("Synchronize panes")}</label>
        <details><summary>{t("More pane controls")}</summary><div className="tmux-extra">
          {(["L","R","U","D"] as const).map((direction, i) => <button className="btn" key={direction} aria-label={t("Resize pane {direction}",{direction})} onClick={() => act({type:"resize",direction,cells:5})}>{["←","→","↑","↓"][i]} 5</button>)}
          <button className="btn" onClick={() => act({type:"break"})}>{t("Move pane to new window")}</button>
          <select className="input" aria-label={t("Other pane")} value={other} onChange={e => setOther(e.target.value)}><option value="">{t("Other pane")}</option>{[...new Map(state?.panes.filter(p => p.paneId !== target.paneId).map(p => [p.paneId,p])).values()].map(p => <option key={p.paneId}>{p.paneId}</option>)}</select>
          <button className="btn" disabled={!other} onClick={() => act({type:"swap",otherPaneId:other})}>{t("Swap panes")}</button>
          <button className="btn" disabled={!other} onClick={() => act({type:"join",otherPaneId:other})}>{t("Join pane here")}</button>
          <button className="btn" onClick={() => act({type:"copy-mode"})}>{t("Copy mode")}</button>
          <button className="btn" onClick={() => act({type:"paste-buffer"})}>{t("Paste tmux buffer")}</button>
          <button className="btn" onClick={() => { if (window.confirm(t("Close this pane and end its running process?"))) act({type:"close"}); }}>{t("Close pane")}</button>
        </div></details>
      </fieldset>
      <TmuxMetadata key={`${target.generation}:${target.paneId}`} target={target} />
      <TmuxScreen key={`${target.generation}:${session}`} target={target} />
    </>}
  </main>;
}
