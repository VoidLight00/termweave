import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Users, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import "./OpenRigPanel.css";
import { OpenRigRecoveryPanel } from "./OpenRigRecoveryPanel.tsx";
import { OpenRigQueuePanel } from "./OpenRigQueuePanel.tsx";
import { OpenRigStarterPanel } from "./OpenRigStarterPanel.tsx";

import type { OpenRigRecord as Item, OpenRigOverview as Overview, OpenRigTeamDetail as Detail, OpenRigAbsent as SeatIssue, OpenRigPreview as Preview, OpenRigOpenResult as OpenResult } from "../../shared/openrig.ts";

function field(item: Item, ...keys: string[]): string {
  for (const key of keys) { const value = item[key]; if (typeof value === "string" && value.trim()) return value; if (typeof value === "number") return String(value); }
  return "";
}
async function request<T>(url: string, signal: AbortSignal, body?: unknown, timeout = 20000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

type Service = { enabled: boolean; running: boolean; available: boolean; busy: boolean; error?: string };

export function OpenRigPanel({ readOnly, canManageService = false, onClose, onOpened }: { readOnly: boolean; canManageService?: boolean; onClose: () => void; onOpened: () => void }) {
  const t = useT(); const id = useId(); const dialog = useRef<HTMLDialogElement>(null);
  const [service, setService] = useState<Service | null>(null);
  const [serviceError, setServiceError] = useState(false); const [servicePending, setServicePending] = useState(false); const [serviceUnknown, setServiceUnknown] = useState(false);
  const serviceAction = useRef(false); const [starterBusy, setStarterBusy] = useState(false);
  const serviceReady = service?.enabled === true && service.running && !service.busy && !serviceError && !servicePending;
  const [overview, setOverview] = useState<Overview | null>(null); const [overviewError, setOverviewError] = useState(false);
  const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true); const [now, setNow] = useState(Date.now());
  const [team, setTeam] = useState(""); const [detail, setDetail] = useState<Detail | null>(null); const [detailError, setDetailError] = useState(false); const [detailLoading, setDetailLoading] = useState(false);
  const [view, setView] = useState(""); const [preview, setPreview] = useState<Preview | null>(null); const [previewAt, setPreviewAt] = useState(0);
  const [pending, setPending] = useState<"preview" | "open" | null>(null); const [actionError, setActionError] = useState<"preview" | "open" | null>(null); const [uncertainView, setUncertainView] = useState(""); const [result, setResult] = useState<OpenResult | null>(null);
  const action = useRef<AbortController | null>(null); const requestId = useRef(""); const actionBusy = useRef(false);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const surface = dialog.current; surface?.showModal();
    return () => { surface?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 5000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    void request<Service>("/api/openrig/service", controller.signal).then(async (status) => {
      if (controller.signal.aborted) return;
      if ([status.enabled, status.running, status.available, status.busy].some(value => typeof value !== "boolean")) throw new Error("shape");
      setService(status); setServiceError(false); if (!status.busy) setServiceUnknown(false);
      if (!status.enabled || !status.running || status.busy) { setOverview(null); setTeam(""); setDetail(null); setPreview(null); return; }
      const data = await request<Overview>("/api/openrig", controller.signal);
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.teams) || !Array.isArray(data.views?.rigs) || !Array.isArray(data.views?.saved) || !data.provider) throw new Error("shape");
      setOverview(data); setOverviewError(false); setTeam((current) => data.teams.some((item) => item.rigId === current) ? current : "");
    }).catch(() => { if (!controller.signal.aborted) { setOverviewError(true); setServiceError(true); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  useEffect(() => {
    if (!serviceReady || !team) { setDetail(null); setDetailError(false); setDetailLoading(false); return; }
    const controller = new AbortController(); setDetail(current => current?.rigId === team ? current : null); setDetailLoading(true); setDetailError(false);
    void request<Detail>(`/api/openrig/teams/${encodeURIComponent(team)}`, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      if (data.rigId !== team || !Array.isArray(data.nodes) || !Array.isArray(data.queue?.items) || !Array.isArray(data.snapshots)) throw new Error("shape");
      setDetail(data);
    }).catch(() => { if (!controller.signal.aborted) setDetailError(true); }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
    return () => controller.abort();
  }, [team, refresh, serviceReady]);
  const toggleService = async () => {
    if (!canManageService || readOnly || !service || !service.available || service.busy || serviceAction.current || serviceUnknown || pending || starterBusy) return;
    serviceAction.current = true; setServicePending(true); setServiceError(false);
    action.current?.abort(); setPreview(null); setResult(null); setOverview(null); setDetail(null);
    const controller = new AbortController(); action.current = controller;
    try {
      const status = await request<Service>("/api/openrig/service", controller.signal, {enabled: !service.enabled}, 75000);
      if ([status.enabled, status.running, status.available, status.busy].some(value => typeof value !== "boolean")) throw new Error("shape");
      setService(status); setRefresh(value => value + 1);
    } catch { setServiceUnknown(true); setServiceError(true); }
    finally { serviceAction.current = false; setServicePending(false); }
  };
  const stale = !overview || !Number.isFinite(Date.parse(overview.checkedAt)) || now - Date.parse(overview.checkedAt) > 30000;
  const previewExpired = now - previewAt >= 300000;
  const connected = serviceReady && overview?.connected && overview.provider.alive && !overviewError;
  const views = overview ? [...overview.views.rigs.map((name) => ({ value: name, label: name })), ...overview.views.saved.map((saved) => ({ value: saved.id, label: saved.name ?? saved.id }))] : [];
  const changeView = (value: string) => { action.current?.abort(); setView(value); setPreview(null); setResult(null); setActionError(null); };
  const run = async (kind: "preview" | "open") => {
    if (!serviceReady || actionBusy.current || !views.some((item) => item.value === view) || (kind === "open" && (readOnly || uncertainView === view || !preview || previewExpired))) return;
    actionBusy.current = true; const controller = new AbortController(); action.current = controller;
    setPending(kind); setActionError(null); setResult(null);
    try {
      if (kind === "preview") {
        setPreview(null);
        const data = await request<Preview>(`/api/openrig/preview?view=${encodeURIComponent(view)}`, controller.signal);
        if (controller.signal.aborted) return;
        if (!data.planId || !Array.isArray(data.opened) || !Array.isArray(data.absent) || !Array.isArray(data.degraded)) throw new Error("shape");
        setPreview(data); setPreviewAt(Date.now()); requestId.current = crypto.randomUUID();
      } else {
        const data = await request<OpenResult>("/api/openrig/open", controller.signal, { view, expectedPlan: preview!.planId, requestId: requestId.current });
        if (controller.signal.aborted) return;
        if (!["complete", "partial", "failed"].includes(data.outcome) || !Array.isArray(data.opened) || !Array.isArray(data.absent) || !Array.isArray(data.degraded)) throw new Error("shape");
        setResult(data); setPreview(null); onOpened();
      }
    } catch { if (!controller.signal.aborted) { setActionError(kind); if (kind === "open") { setPreview(null); setUncertainView(view); } } }
    finally { actionBusy.current = false; if (!controller.signal.aborted) setPending(null); }
  };
  const issues = (items: SeatIssue[]) => <ul className="openrig-list">{items.map((item, index) => <li key={`${item.seat}-${index}`}><strong>{item.seat}</strong><span>{item.reason}</span>{item.host && <small>{item.host}</small>}</li>)}</ul>;
  // OpenRig seat attention (server/openrig/seat-attention.ts): a badge and its reason on the seat row
  const attentionOf = (item: Item): { reason: string; detail: string | null } | null => {
    const value = (item as Record<string, unknown>)["attention"] as { needed?: unknown; reason?: unknown; detail?: unknown } | undefined;
    return value?.needed === true && typeof value.reason === "string" ? { reason: value.reason, detail: typeof value.detail === "string" ? value.detail : null } : null;
  };
  const attentionLabel: Record<string, string> = { error: t("Error reported"), held: t("Held"), needs_input: t("Waiting for input"), failed: t("Startup failed"), attention_required: t("Needs attention") };
  const records = (items: Item[], kind: "nodes" | "tasks" | "snapshots") => <ul className="openrig-list">{items.map((item, index) => <li key={field(item, "nodeId", "qitemId", "id") || index} data-attention={kind === "nodes" && attentionOf(item) ? "true" : undefined}>
    <strong>{field(item, "summary", "logicalId", "canonicalSessionName", "id", "nodeId", "qitemId") || t("Unnamed record")}</strong>
    <span>{field(item, kind === "nodes" ? "role" : "status", "state", "sessionStatus", "lifecycleState") || t("Status not reported")}{kind === "nodes" && field(item, "sessionStatus", "lifecycleState") && field(item, "sessionStatus", "lifecycleState") !== field(item, kind === "nodes" ? "role" : "status", "state", "sessionStatus", "lifecycleState") ? ` · ${field(item, "sessionStatus", "lifecycleState")}` : ""}</span>
    {field(item, "runtime", "destinationSession", "createdAt", "tsUpdated") && <small>{field(item, "runtime", "destinationSession", "createdAt", "tsUpdated")}</small>}
    {kind === "nodes" && attentionOf(item) && <span className="openrig-attention" role="status"><b>{t("Needs help")}</b> {attentionLabel[attentionOf(item)!.reason] ?? attentionOf(item)!.reason}{attentionOf(item)!.detail ? ` · ${attentionOf(item)!.detail}` : ""}</span>}
  </li>)}</ul>;
  return createPortal(<dialog ref={dialog} className="openrig-dialog" aria-labelledby={`${id}-title`} onCancel={(event) => { event.preventDefault(); if (!pending && !servicePending && !starterBusy) onClose(); }}>
    <header className="openrig-header"><div><h2 id={`${id}-title`}>{t("OpenRig teams")}</h2><p>{t("Team roles, tasks, and saved state")}</p></div><button type="button" className="icon-button" aria-label={t("Close")} disabled={pending !== null || servicePending || starterBusy} onClick={onClose} autoFocus><X aria-hidden="true" /></button></header>
    <div className="openrig-body">
      <section className="openrig-service" aria-label={t("OpenRig service")}>
        <div className="openrig-service-control"><div><strong>{t("OpenRig service")}</strong><p className="openrig-muted">{t("Turning this off stops only the managed service. Existing agents and terminals keep running.")}</p></div><button type="button" className="btn" role="switch" aria-checked={service?.enabled ?? false} aria-label={t("Enable OpenRig service")} disabled={!service || !service.available || !canManageService || readOnly || servicePending || service.busy || serviceUnknown || pending !== null || starterBusy} onClick={() => void toggleService()}>{servicePending ? t("Applying service change…") : service?.enabled ? t("On") : t("Off")}</button></div>
        <p role="status">{servicePending || service?.busy ? t("Service change in progress") : !service ? t("Checking service status…") : !service.enabled ? (service.running ? t("Off requested, but the service is still running") : t("OpenRig is off")) : service.running ? t("Service is running") : t("Enabled, but service is not running")}</p>
        {(!canManageService || readOnly) && <p className="openrig-muted">{t("Control access is required to change the service setting.")}</p>}
        {!service?.available && service && <p className="openrig-notice">{t("The OpenRig executable is unavailable on this host.")}</p>}
        {(serviceError || service?.error) && <p role="alert">{serviceUnknown ? t("Service change could not be confirmed. Refresh its status before another change.") : t("Could not confirm service status. Check the host and refresh.")}</p>}
      </section>
      <div className="openrig-health" role="status"><span className={`openrig-dot ${connected ? "is-connected" : ""}`} aria-hidden="true" /><span>{loading ? t("Loading…") : connected ? t("Connected") : service?.enabled === false ? (service.running ? t("Off requested, but the service is still running") : t("OpenRig is off")) : t("OpenRig unavailable")}</span><button type="button" className="btn" disabled={loading || pending !== null || servicePending || starterBusy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} aria-hidden="true" />{t("Refresh")}</button></div>
      {overview && <p className="openrig-muted">{stale || overviewError ? t("Data may be out of date") : t("Recently checked")}{" · "}{Number.isFinite(Date.parse(overview.checkedAt)) ? new Date(overview.checkedAt).toLocaleTimeString() : t("Time not reported")}</p>}
      {overviewError && serviceReady && <p className="openrig-notice" role="alert">{t("Could not load OpenRig. Check the local service and retry.")}</p>}
      {readOnly && <p className="openrig-notice">{t("Watch access: viewing only")}</p>}
      {serviceReady && <OpenRigStarterPanel readOnly={readOnly || starterBusy} onBusy={setStarterBusy} onLaunched={() => {onOpened(); setRefresh(value => value + 1);}} />}
      {overview && serviceReady && <>
        {overview.teams.length === 0 ? <p className="openrig-empty">{t("No OpenRig teams are registered.")}</p> : <label className="openrig-field"><span>{t("Team")}</span><select aria-label={t("Team")} disabled={starterBusy || pending !== null} value={team} onChange={(event) => setTeam(event.target.value)}><option value="">{t("Select a team")}</option>{overview.teams.map((item, index) => { const value = item.rigId; return <option key={value || index} value={value} disabled={!value}>{item.name || item.rigName || item.rigId || t("Unnamed record")}</option>; })}</select></label>}
        {detailLoading && <p role="status">{t("Loading…")}</p>}{detailError && <p role="alert">{t("Could not load this team. Refresh to retry.")}</p>}
        {detail && <div className="openrig-sections">
          <OpenRigRecoveryPanel key={`recovery-${detail.rigId}`} rigId={detail.rigId} readOnly={readOnly || starterBusy} onBusy={setStarterBusy} onChanged={() => setRefresh(value => value + 1)} />
          <OpenRigQueuePanel key={detail.rigId} team={detail} readOnly={readOnly || starterBusy} onBusy={setStarterBusy} onChanged={() => setRefresh(value => value + 1)} />
          <section><h3>{t("Roles and nodes")}</h3>{detail.nodes.some(node => attentionOf(node as Item)) && <p className="openrig-attention-summary" role="status">{t("{n} seats need help", { n: detail.nodes.filter(node => attentionOf(node as Item)).length })}</p>}{detail.nodes.length ? records(detail.nodes, "nodes") : <p className="openrig-empty">{t("No roles reported")}</p>}<p className="openrig-muted">{t("P numbers are shown only when terminal identity is verified.")}</p></section>
          <section><h3>{t("Tasks")}</h3>{detail.queue.items.length ? records(detail.queue.items, "tasks") : <p className="openrig-empty">{t("No tasks reported")}</p>}{detail.queue.truncated && <p className="openrig-notice">{t("The task list is limited to {count} items.", { count: detail.queue.limit })}</p>}</section>
          {!!detail.attention?.items?.length && <section><h3>{t("Needs attention")}</h3>{records(detail.attention.items, "tasks")}{detail.attention.truncated && <p className="openrig-notice">{t("The task list is limited to {count} items.", { count: detail.attention.limit })}</p>}</section>}
          <section><h3>{t("Snapshots")}</h3>{detail.snapshots.length ? records(detail.snapshots, "snapshots") : <p className="openrig-empty">{t("No saved snapshots reported")}</p>}</section>
        </div>}
        <section className="openrig-view"><h3>{t("Open a team view")}</h3><p className="openrig-muted">{t("Preview the seats before opening. This does not create agents or restore conversations.")}</p>
          {views.length ? <div className="openrig-view-controls"><label className="openrig-field"><span>{t("View")}</span><select aria-label={t("View")} value={view} disabled={pending !== null} onChange={(event) => changeView(event.target.value)}><option value="">{t("Select a view")}</option>{views.map((item, index) => <option key={`${item.value}-${index}`} value={item.value}>{item.label}</option>)}</select></label><button type="button" className="btn" disabled={!views.some((item) => item.value === view) || pending !== null || !connected} onClick={() => void run("preview")}>{t("Preview")}</button></div> : <p className="openrig-empty">{t("No views are available")}</p>}
          {pending && <p role="status">{t(pending === "preview" ? "Loading preview…" : "Opening view…")}</p>}
          {actionError && <p role="alert">{t(actionError === "open" ? "Opening could not be confirmed. Check existing workspaces." : "Could not load the preview. Try previewing again.")}</p>}
          {preview && <div className="openrig-preview"><h4>{t("Seats to open")}</h4>{preview.opened.length ? <ul className="openrig-list">{preview.opened.map((seat) => <li key={seat.seat}><strong>{seat.label || seat.seat}</strong><span>{seat.seat}</span>{seat.readOnly && <small>{t("Read only")}</small>}</li>)}</ul> : <p>{t("No seats can be opened")}</p>}
            {!!preview.absent.length && <><h4>{t("Absent seats")}</h4>{issues(preview.absent)}</>}{!!preview.degraded.length && <><h4>{t("Limited availability")}</h4>{issues(preview.degraded)}</>}
            {previewExpired && <p role="status">{t("Preview expired. Preview again before opening.")}</p>}
            <button type="button" className="btn btn-primary" disabled={readOnly || uncertainView === view || pending !== null || previewExpired || !preview.available || !preview.opened.length || !connected} onClick={() => void run("open")}>{t("Open this view")}</button>
          </div>}
          {result && <div className="openrig-result" role="status"><h4>{t(result.outcome === "complete" ? "View opened" : result.outcome === "partial" ? "View partially opened" : "View opening could not be completed")}</h4><p>{t("Opened seats: {count}", { count: result.opened.length })}</p>{!!result.opened.length && <ul className="openrig-list">{result.opened.map((seat) => <li key={seat}>{seat}{result.terminalIdentities?.filter(identity => identity.seat === seat && Number.isSafeInteger(identity.paneNumber) && identity.paneNumber > 0 && [identity.paneId,identity.terminalId,identity.workspaceId,identity.tabId,identity.generation].every(value => typeof value === "string" && value.length > 0)).map(identity => <span key={identity.terminalId}>{t("{seat} → P{number} · verified when opened", {seat:identity.seat,number:identity.paneNumber})}</span>)}</li>)}</ul>}{!!result.absent.length && <><h4>{t("Absent seats")}</h4>{issues(result.absent)}</>}{!!result.degraded.length && <><h4>{t("Limited availability")}</h4>{issues(result.degraded)}</>}</div>}
        </section>
      </>}
    </div><footer className="openrig-footer"><Users size={14} aria-hidden="true" /><span>{t("Closing this panel leaves terminals running.")}</span></footer>
  </dialog>, document.body);
}
