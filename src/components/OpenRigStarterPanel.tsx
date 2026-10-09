import { useEffect, useRef, useState } from "react";
import type { OpenRigReadiness, OpenRigStarterPlan, OpenRigStarterLaunch } from "../../shared/openrig.ts";
import { useT } from "../lib/i18n.ts";
import "./OpenRigStarterPanel.css";

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(`/api/openrig/starter/${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(path === "launch" ? 150000 : 75000)]), cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error("request_failed");
  return response.json() as Promise<T>;
}
export function OpenRigStarterPanel({ readOnly, onBusy, onLaunched }: { readOnly: boolean; onBusy: (busy: boolean) => void; onLaunched: () => void }) {
  const t = useT(); const [path, setPath] = useState(""); const [plan, setPlan] = useState<OpenRigStarterPlan | null>(null);
  const [readiness, setReadiness] = useState<OpenRigReadiness | null>(null); const [pending, setPending] = useState(false);
  const [error, setError] = useState(false); const [uncertain, setUncertain] = useState(false); const [result, setResult] = useState<OpenRigStarterLaunch | null>(null);
  const [now, setNow] = useState(Date.now()); const action = useRef<AbortController | null>(null); const busy = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void request<OpenRigReadiness>("readiness", controller.signal).then(value => { if (!controller.signal.aborted) setReadiness(value); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { controller.abort(); action.current?.abort(); clearInterval(timer); };
  }, []);
  const expires = plan ? Date.parse(plan.expiresAt) : NaN;
  const canLaunch = !!plan && plan.input.projectPath === path.trim() && Number.isFinite(expires) && now < expires && plan.readiness.ready && plan.readiness.providers.length > 0 && plan.readiness.providers.every(provider => provider.authenticated && provider.permissionsSupported) && plan.permissions.length > 0 && plan.permissions.every(item => item.verified) && !uncertain && !result && !readOnly;
  const run = async (kind: "plan" | "launch") => {
    if (busy.current || readOnly || uncertain || (kind === "plan" ? !path.trim() : !canLaunch)) return;
    busy.current = true; setPending(true); onBusy(true); setError(false);
    const controller = new AbortController(); action.current = controller;
    try {
      if (kind === "plan") {
        setPlan(null); setResult(null);
        const value = await request<OpenRigStarterPlan>("plan", controller.signal, {projectPath: path.trim()});
        if (controller.signal.aborted) return;
        if (!value.planId || !Array.isArray(value.permissions) || !Array.isArray(value.stages) || !value.readiness || typeof value.input?.projectPath !== "string" || !value.input.projectPath) throw new Error("shape");
        setPath(value.input.projectPath); setPlan(value); setReadiness(value.readiness);
      } else {
        const value = await request<OpenRigStarterLaunch>("launch", controller.signal, {planId: plan!.planId, requestId: crypto.randomUUID()});
        if (controller.signal.aborted) return;
        if (!["started", "attention", "failed"].includes(value.outcome)) throw new Error("shape");
        setResult(value); if (value.outcome !== "failed") onLaunched();
      }
    } catch { if (!controller.signal.aborted) { setError(true); if (kind === "launch") setUncertain(true); } }
    finally { busy.current = false; if (!controller.signal.aborted) { setPending(false); onBusy(false); } }
  };
  return <section className="openrig-starter"><h3>{t("Start an OpenRig team")}</h3>
    <p className="openrig-muted">{t("Review the project, provider authentication, and permissions before explicitly launching agents.")}</p>
    <label className="openrig-field"><span>{t("Project folder on this host")}</span><input value={path} disabled={pending || uncertain || readOnly} onChange={event => {setPath(event.target.value); setPlan(null); setResult(null);}} autoComplete="off" spellCheck={false} /></label>
    <button type="button" className="btn" disabled={!path.trim() || pending || uncertain || readOnly} onClick={() => void run("plan")}>{t("Review launch plan")}</button>
    {pending && <p role="status">{t("Processing team request…")}</p>}
    {error && <p role="alert">{uncertain ? t("Launch could not be confirmed. Check existing teams before any further launch.") : t("Could not prepare the team. Check the project and host readiness.")}</p>}
    {readiness && <div><h4>{t("Provider readiness")}</h4><ul className="openrig-list">{readiness.providers.map(provider => <li key={provider.runtime}><strong>{provider.runtime}</strong><span>{provider.authenticated ? t("Authentication verified") : t("Authentication not verified")}</span><span>{provider.permissionsSupported ? t("Permission controls supported") : t("Permission controls not verified")}</span>{provider.reason && <small>{provider.reason}</small>}</li>)}</ul>{!readiness.ready && <p role="status">{t("Launch is blocked until all readiness checks pass.")}</p>}{readiness.blockers.length > 0 && <ul>{readiness.blockers.map((item, index) => <li key={index}>{item}</li>)}</ul>}</div>}
    {plan && <div><h4>{t("Launch plan")}</h4><p>{plan.input.teamName}</p><p>{plan.input.projectPath}</p><ul className="openrig-list">{plan.stages.map((stage, index) => <li key={index}><strong>{stage.stage}</strong><span>{stage.status}</span></li>)}</ul><h4>{t("Agent permissions")}</h4><ul className="openrig-list">{plan.permissions.map(item => <li key={item.seat}><strong>{item.seat}</strong><span>{item.mode}</span><span>{item.verified ? t("Permission verified") : t("Permission not verified")}</span></li>)}</ul>{plan.warnings.length > 0 && <ul>{plan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}{(!Number.isFinite(expires) || now >= expires) && <p role="status">{t("Launch plan expired. Review a new plan.")}</p>}<button type="button" className="btn btn-primary" disabled={!canLaunch || pending} onClick={() => void run("launch")}>{t("Launch this team")}</button></div>}
    {result && <p role="status">{t(result.outcome === "started" ? "Team launch was reported. Inspect its actual state in the team list." : result.outcome === "attention" ? "Team launch needs attention. Inspect the team list." : "Team launch did not complete.")}{result.rigId && <span> · {result.rigId}</span>}</p>}
  </section>;
}
