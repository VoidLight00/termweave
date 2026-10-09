import { useEffect, useRef, useState } from "react";
import type { OpenRigQueueDetail, OpenRigQueueResult, OpenRigQueueHandoffResult, OpenRigRecord, OpenRigTeamDetail } from "../../shared/openrig.ts";
import { useT } from "../lib/i18n.ts";
import "./OpenRigQueuePanel.css";
const text = (item: OpenRigRecord, key: string) => typeof item[key] === "string" ? item[key] as string : "";
export function OpenRigQueuePanel({ team, readOnly, onBusy, onChanged }: { team: OpenRigTeamDetail; readOnly: boolean; onBusy: (busy: boolean) => void; onChanged: () => void }) {
  const storageKey = `termweave:openrig:queue-uncertain:${team.rigId}`;
  const remembered = () => {try {const value=JSON.parse(sessionStorage.getItem(storageKey)||"null");return value&&typeof value.id==="string"&&["create","handoff"].includes(value.kind)?value:null;}catch{return null;}};
  const [held,setHeld]=useState<{id:string;kind:"create"|"handoff";qitemId?:string}|null>(remembered);
  const [capable,setCapable]=useState(false); const [handoffTo,setHandoffTo]=useState(""); const [handoffResult,setHandoffResult]=useState<OpenRigQueueHandoffResult|null>(null);
  const t = useT(); const [destination, setDestination] = useState(""); const [summary, setSummary] = useState(""); const [body, setBody] = useState(""); const [notify, setNotify] = useState(false); const [reconciled, setReconciled] = useState(false);
  const [pending, setPending] = useState(false); const [uncertain, setUncertain] = useState(!!held); const [result, setResult] = useState<OpenRigQueueResult | null>(null);
  const [selected, setSelected] = useState(""); const [detail, setDetail] = useState<OpenRigQueueDetail | null>(null); const [detailError, setDetailError] = useState(false); const [refresh, setRefresh] = useState(0);
  const active = useRef<AbortController | null>(null); const busy = useRef(false); const requestId = useRef(held?.id || crypto.randomUUID());
  const destinations = [...new Set(team.nodes.map(node => text(node, "canonicalSessionName")).filter(Boolean))];
  useEffect(() => {const controller=new AbortController();void fetch("/api/openrig/capabilities",{cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok)throw Error();const value=await response.json();if(!controller.signal.aborted)setCapable(value.humanHandoff===true);}).catch(()=>{});return()=>{controller.abort();active.current?.abort();};}, []);
  const reserve=(kind:"create"|"handoff",id:string,qitemId?:string)=>{const value={kind,id,qitemId};sessionStorage.setItem(storageKey,JSON.stringify(value));setHeld(value);};
  const release=()=>{sessionStorage.removeItem(storageKey);setHeld(null);setUncertain(false);};
  const reconcile=async()=>{
    if(!held||busy.current)return;busy.current=true;setPending(true);onBusy(true);const controller=new AbortController();active.current=controller;
    try {const response=await fetch(`/api/openrig/teams/${encodeURIComponent(team.rigId)}/${held.kind==="handoff"?"handoff-request":"queue-request"}/${encodeURIComponent(held.kind==="handoff"?(held.qitemId||""):held.id)}`,{cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});if(!response.ok)throw Error();const payload=await response.json();const value:OpenRigQueueDetail=held.kind==="handoff"?{item:payload.created,transitions:[],checkedAt:new Date().toISOString()}:payload;if(!value.item)throw Error();if(text(value.item,"sourceSession")!=="human@kernel"||!text(value.item,"qitemId"))throw Error();if(controller.signal.aborted)return;setSelected(text(value.item,"qitemId"));setDetail(value);setReconciled(true);setResult({item:value.item,actor:"human@kernel",provenance:"claimed:v1",delivery:"recorded_without_nudge"});release();onChanged();}catch{if(!controller.signal.aborted)setUncertain(true);}finally{busy.current=false;if(!controller.signal.aborted){setPending(false);onBusy(false);}}
  };
  useEffect(() => {
    setDetail(null); setDetailError(false); if (!selected) return;
    const controller = new AbortController();
    void fetch(`/api/openrig/teams/${encodeURIComponent(team.rigId)}/queue/${encodeURIComponent(selected)}`, {cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])}).then(async response => {if(!response.ok)throw Error(); const value = await response.json() as OpenRigQueueDetail; if(!Array.isArray(value.transitions) || text(value.item,"qitemId") !== selected)throw Error(); if(!controller.signal.aborted)setDetail(value);}).catch(()=>{if(!controller.signal.aborted)setDetailError(true);});
    return () => controller.abort();
  }, [selected, team.rigId, refresh]);
  const create = async () => {
    if (busy.current || readOnly || uncertain || result || !destinations.includes(destination) || !summary.trim() || !body.trim()) return;
    busy.current=true;setPending(true);onBusy(true);const controller=new AbortController();active.current=controller;
    try {
      reserve("create",requestId.current);
      const response=await fetch("/api/openrig/queue/create",{method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(75000)]),body:JSON.stringify({rigId:team.rigId,destinationSession:destination,summary:summary.trim(),body:body.trim(),notify,requestId:requestId.current})});
      if(!response.ok)throw Error();const value=await response.json() as OpenRigQueueResult;
      if(value.actor!=="human@kernel" || !["recorded_without_nudge","notification_requested","notification_failed"].includes(value.delivery) || !text(value.item,"qitemId"))throw Error();
      if(controller.signal.aborted)return;release();setReconciled(false);setResult(value);setSelected(text(value.item,"qitemId"));onChanged();
    } catch {if(!controller.signal.aborted)setUncertain(true);}
    finally {busy.current=false;if(!controller.signal.aborted){setPending(false);onBusy(false);}}
  };
  const handoff=async()=>{
    if(!capable||readOnly||busy.current||uncertain||!detail||text(detail.item,"destinationSession")!=="human@kernel"||!destinations.includes(handoffTo)||!text(detail.item,"tsUpdated")||!["pending","in-progress","blocked"].includes(text(detail.item,"state")))return;
    busy.current=true;setPending(true);onBusy(true);const controller=new AbortController();active.current=controller;const id=crypto.randomUUID();
    try {reserve("handoff",id,selected);const response=await fetch("/api/openrig/queue/handoff",{method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(75000)]),body:JSON.stringify({rigId:team.rigId,qitemId:selected,toSession:handoffTo,expectedState:text(detail.item,"state"),expectedUpdatedAt:text(detail.item,"tsUpdated"),requestId:id,summary:text(detail.item,"summary")})});if(!response.ok)throw Error();const value=await response.json() as OpenRigQueueHandoffResult;if(value.actor!=="human@kernel"||value.delivery!=="recorded_without_nudge"||!text(value.created,"qitemId"))throw Error();if(controller.signal.aborted)return;release();setReconciled(false);setHandoffResult(value);setResult({item:value.created,actor:value.actor,provenance:value.provenance,delivery:value.delivery});setSelected(text(value.created,"qitemId"));onChanged();}catch{if(!controller.signal.aborted)setUncertain(true);}finally{busy.current=false;if(!controller.signal.aborted){setPending(false);onBusy(false);}}
  };
  const tasks = result && !team.queue.items.some(item=>text(item,"qitemId")===text(result.item,"qitemId")) ? [...team.queue.items,result.item] : team.queue.items;
  return <details className="openrig-queue"><summary>{t("Task creation and history")}</summary>
    <p className="openrig-muted">{t("Tasks created here are recorded as a human request. Agent notification is optional.")}</p>
    <fieldset disabled={pending || readOnly || uncertain || !!result}><legend>{t("Create a task")}</legend>
      <label className="openrig-field"><span>{t("Destination role session")}</span><select aria-label={t("Destination role session")} value={destination} onChange={event=>setDestination(event.target.value)}><option value="">{t("Select a destination")}</option>{destinations.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
      {!destinations.length&&<p>{t("No verified destination sessions are available.")}</p>}
      <label className="openrig-field"><span>{t("Task summary")}</span><input maxLength={256} value={summary} onChange={event=>setSummary(event.target.value)}/></label>
      <label className="openrig-field"><span>{t("Task instructions")}</span><textarea maxLength={2048} rows={4} value={body} onChange={event=>setBody(event.target.value)}/></label>
      <label className="openrig-notify"><input type="checkbox" checked={notify} onChange={event=>setNotify(event.target.checked)}/><span>{t("Request a notification to the assigned agent")}</span></label>
      <button type="button" className="btn" disabled={!destinations.includes(destination)||!summary.trim()||!body.trim()} onClick={()=>void create()}>{t("Record this task")}</button>
    </fieldset>
    {pending&&<p role="status">{t("Recording task…")}</p>}
    {uncertain&&<p role="alert">{t("Task recording could not be confirmed. Inspect the task list; do not submit a duplicate.")}</p>}
    {uncertain&&held&&<button className="btn" type="button" disabled={pending} onClick={()=>void reconcile()}>{t("Check the previous task request")}</button>}
    {handoffResult&&<p role="status">{t("Human task handoff recorded. No terminal input was sent.")}</p>}
    {result&&<div role="status"><p>{reconciled?t("Task record confirmed. Notification delivery has not been verified."):t(result.delivery==="notification_requested"?"Task recorded; agent notification requested. Receipt and execution are not confirmed.":result.delivery==="notification_failed"?"Task recorded, but agent notification failed. Check the task list without resubmitting.":"Task recorded by you · no automatic terminal input")}</p><p>{text(result.item,"summary")}</p><button className="btn" type="button" disabled={readOnly||pending} onClick={()=>{setResult(null);setSummary("");setBody("");setNotify(false);setReconciled(false);requestId.current=crypto.randomUUID();}}>{t("Prepare another task")}</button></div>}
    <label className="openrig-field"><span>{t("Task history")}</span><select aria-label={t("Task history")} value={selected} onChange={event=>setSelected(event.target.value)}><option value="">{t("Select a task")}</option>{tasks.map(item=><option key={text(item,"qitemId")} value={text(item,"qitemId")}>{text(item,"summary")||text(item,"qitemId")}</option>)}</select></label>
    {selected&&<button type="button" className="btn" onClick={()=>setRefresh(value=>value+1)}>{t("Refresh task history")}</button>}
    {detailError&&<p role="alert">{t("Could not read task history. Refresh to check again.")}</p>}
    {detail&&<div><h4>{text(detail.item,"summary")}</h4><dl><dt>{t("Task state")}</dt><dd>{text(detail.item,"state")||t("Status not reported")}</dd><dt>{t("Recorded sender")}</dt><dd>{text(detail.item,"sourceSession")||t("Status not reported")}</dd><dt>{t("Destination role session")}</dt><dd>{text(detail.item,"destinationSession")||t("Status not reported")}</dd></dl><p className="openrig-muted">{t("Task state is not evidence that implementation or independent review passed.")}</p>{detail.transitions.length?<ol className="openrig-list">{detail.transitions.map((item,index)=><li key={text(item,"transitionId")||index}><strong>{text(item,"state")||t("Status not reported")}</strong><span>{text(item,"actorSession")}</span><small>{text(item,"ts")}</small>{text(item,"transitionNote")&&<p>{text(item,"transitionNote")}</p>}</li>)}</ol>:<p>{t("No state transitions reported")}</p>}</div>}
    {capable&&detail&&text(detail.item,"destinationSession")==="human@kernel"?<div><h4>{t("Hand off your task")}</h4><p className="openrig-muted">{t("Only a task currently assigned to you can be handed off here. Agent-owned tasks cannot be impersonated.")}</p><label className="openrig-field"><span>{t("New destination session")}</span><select aria-label={t("New destination session")} value={handoffTo} disabled={pending||readOnly||uncertain} onChange={event=>setHandoffTo(event.target.value)}><option value="">{t("Select a destination")}</option>{destinations.map(value=><option key={value} value={value}>{value}</option>)}</select></label><button type="button" className="btn" disabled={pending||readOnly||uncertain||!destinations.includes(handoffTo)||!text(detail.item,"tsUpdated")||!["pending","in-progress","blocked"].includes(text(detail.item,"state"))} onClick={()=>void handoff()}>{t("Confirm task handoff")}</button></div>:<p className="openrig-muted">{t("Task handoff is unavailable until ownership and concurrent changes can be verified safely.")}</p>}
  </details>;
}
