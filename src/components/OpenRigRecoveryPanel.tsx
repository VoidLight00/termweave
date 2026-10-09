import { useEffect, useRef, useState } from "react";
import type { OpenRigRecoveryPlan, OpenRigRestoreStarted, OpenRigRestoreStatus, OpenRigRecord } from "../../shared/openrig.ts";
import { useT } from "../lib/i18n.ts";
const text = (item: OpenRigRecord, key: string) => typeof item[key] === "string" ? item[key] as string : "";
async function request<T>(url: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.any([signal,AbortSignal.timeout(150000)]),...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
  if(!response.ok)throw Error("request_failed");return response.json() as Promise<T>;
}
export function OpenRigRecoveryPanel({rigId,readOnly,onBusy,onChanged}:{rigId:string;readOnly:boolean;onBusy:(busy:boolean)=>void;onChanged:()=>void}) {
  const t=useT();const [plan,setPlan]=useState<OpenRigRecoveryPlan|null>(null);const [pending,setPending]=useState(false);const [error,setError]=useState(false);const [uncertain,setUncertain]=useState(false);
  const [saved,setSaved]=useState<OpenRigRecord|null>(null);const [attempt,setAttempt]=useState<number|null>(null);const [status,setStatus]=useState<OpenRigRestoreStatus|null>(null);const [statusError,setStatusError]=useState(false);const [refresh,setRefresh]=useState(0);const [now,setNow]=useState(Date.now());
  const busy=useRef(false);const action=useRef<AbortController|null>(null);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>{clearInterval(timer);action.current?.abort();};},[]);
  useEffect(()=>{
    if(attempt===null)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{try{const value=await request<OpenRigRestoreStatus>(`/api/openrig/teams/${encodeURIComponent(rigId)}/restore/${attempt}`,controller.signal);if(controller.signal.aborted)return;if(value.rigId!==rigId||value.attemptId!==attempt||!["running","completed"].includes(value.status)||!Array.isArray(value.nodes))throw Error();setStatus(value);setStatusError(false);if(value.status==="running")timer=setTimeout(()=>void poll(),3000);}catch{if(!controller.signal.aborted)setStatusError(true);}};
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[attempt,rigId,refresh]);
  const outcomes:Record<string,string>={"resume-original":t("Resume original conversation"),resumed:t("Original conversation resumed"),rebuilt:t("Session rebuilt"),fresh:t("New conversation started"),"fresh-primed":t("New conversation with handoff context"),"awaiting-decision":t("Awaiting operator decision"),failed:t("Recovery failed"),attention_required:t("Operator attention required"),operator_recovered:t("Recovered by operator")};
  const outcome=(value:string)=>outcomes[value]||value||t("Status not reported");
  const valid=!!plan&&Number.isFinite(Date.parse(plan.expiresAt))&&now<Date.parse(plan.expiresAt);
  const run=async(kind:"plan"|"snapshot"|"restore")=>{
    if(busy.current||readOnly||uncertain||attempt!==null||(kind!=="plan"&&(!valid||(kind==="restore"&&!plan?.canRestore))))return;
    busy.current=true;setPending(true);onBusy(true);setError(false);const controller=new AbortController();action.current=controller;
    try{
      if(kind==="plan") {const value=await request<OpenRigRecoveryPlan>("/api/openrig/recovery/plan",controller.signal,{rigId});if(value.rigId!==rigId||!value.planId||!Array.isArray(value.nodes)||!Array.isArray(value.blockers))throw Error();if(!controller.signal.aborted){setPlan(value);setSaved(null);}}
      else if(kind==="snapshot") {const value=await request<OpenRigRecord>("/api/openrig/recovery/snapshot",controller.signal,{planId:plan!.planId,requestId:crypto.randomUUID()});if(!text(value,"id"))throw Error();if(!controller.signal.aborted){setSaved(value);setPlan(null);onChanged();}}
      else {const value=await request<OpenRigRestoreStarted>("/api/openrig/recovery/restore",controller.signal,{planId:plan!.planId,requestId:crypto.randomUUID()});if(value.status!=="started"||value.rigId!==rigId||!Number.isInteger(value.attemptId))throw Error();if(!controller.signal.aborted){setAttempt(value.attemptId);setPlan(null);onChanged();}}
    }catch{if(!controller.signal.aborted){setError(true);if(kind!=="plan")setUncertain(true);}}
    finally{busy.current=false;if(!controller.signal.aborted){setPending(false);onBusy(false);}}
  };
  return <details className="openrig-queue"><summary>{t("Saved state and recovery")}</summary><p className="openrig-muted">{t("A snapshot records team state, not a source-code backup. Restoring starts only the original saved conversations.")}</p>
    <button type="button" className="btn" disabled={readOnly||pending||uncertain||attempt!==null} onClick={()=>void run("plan")}>{t("Review recovery plan")}</button>
    {pending&&<p role="status">{t("Processing recovery request…")}</p>}
    {error&&<p role="alert">{uncertain?t("Recovery change could not be confirmed. Inspect existing team state before another operation."):t("Could not prepare recovery. Check the team and refresh.")}</p>}
    {plan&&<div><h4>{t("Recovery plan")}</h4>{plan.snapshot?<p>{plan.snapshot.id} · {plan.snapshot.kind} · {plan.snapshot.createdAt}</p>:<p>{t("No saved snapshots reported")}</p>}
      <ul className="openrig-list">{plan.nodes.map((node,index)=><li key={text(node,"nodeId")||index}><strong>{text(node,"logicalId")||text(node,"nodeId")}</strong><span>{outcome(text(node,"intendedAction"))}</span></li>)}</ul>
      {plan.blockers.length>0&&<ul>{plan.blockers.map((blocker,index)=><li key={index}>{blocker}</li>)}</ul>}
      {!valid&&<p role="status">{t("Recovery plan expired. Review a new plan.")}</p>}
      <div className="openrig-view-controls"><button type="button" className="btn" disabled={readOnly||pending||uncertain||!valid} onClick={()=>void run("snapshot")}>{t("Save current team state")}</button><button type="button" className="btn" disabled={readOnly||pending||uncertain||!valid||!plan.canRestore} onClick={()=>void run("restore")}>{t("Restore original conversations")}</button></div>
    </div>}
    {saved&&<p role="status">{t("Team state was saved.")} · {text(saved,"id")}</p>}
    {attempt!==null&&<div><p role="status">{status?.status==="completed"?t("Recovery attempt finished. Check each role outcome."):t("Recovery started; completion is not yet confirmed.")}</p>{statusError&&<p role="alert">{t("Could not read recovery progress. Refresh progress without starting another recovery.")}</p>}<button type="button" className="btn" onClick={()=>setRefresh(value=>value+1)}>{t("Refresh recovery progress")}</button>{status&&<><p>{status.verdict}</p><ul className="openrig-list">{status.nodes.map((node,index)=><li key={text(node,"nodeId")||index}><strong>{text(node,"logicalId")||text(node,"nodeId")}</strong><span>{outcome(text(node,"status"))}</span></li>)}</ul></>}</div>}
  </details>;
}
