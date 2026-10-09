import { useEffect, useRef, useState } from "react";
import type { MobileRelayState } from "../../server/mobile-relay/gateway.ts";
import { useT } from "../lib/i18n.ts";
import "./MobileRelayPanel.css";
export function MobileRelayPanel({readOnly=false}:{readOnly?:boolean}) {
  const t=useT();const [state,setState]=useState<MobileRelayState|null>(null);
  const [endpoint,setEndpoint]=useState("");const [credential,setCredential]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
  const [revocation,setRevocation]=useState<""|"confirmed"|"unconfirmed">("");
  const [frame,setFrame]=useState("");const [control,setControl]=useState(false);
  const socket=useRef<WebSocket|null>(null),url=useRef(""),seq=useRef(0),epoch=useRef<string|null>(null);
  const down=useRef<{x:number;y:number}|null>(null);
  useEffect(()=>{
    let live=true;
    const accept=(s:MobileRelayState)=>{if(!live)return;if(epoch.current!==s.streamId){epoch.current=s.streamId;seq.current=0;setControl(false);}setState(s);if(!s.sharing){if(url.current)URL.revokeObjectURL(url.current);url.current="";setFrame("");setControl(false);}};
    void fetch("/api/mobile-relay",{cache:"no-store"}).then(r=>{if(!r.ok)throw new Error();return r.json();}).then(accept).catch(()=>{if(live)setError(true);});
    const address=new URL("/api/mobile-relay/stream",location.href);address.protocol=location.protocol==="https:"?"wss:":"ws:";
    const ws=new WebSocket(address);socket.current=ws;ws.binaryType="arraybuffer";
    ws.onmessage=e=>{if(!live)return;if(typeof e.data==="string"){try{const s=JSON.parse(e.data);if(s.type==="mobile-relay-state")accept(s);}catch{}return;}
      if(e.data instanceof ArrayBuffer&&e.data.byteLength<=1_048_576){const next=URL.createObjectURL(new Blob([e.data],{type:"image/jpeg"}));if(url.current)URL.revokeObjectURL(url.current);url.current=next;setFrame(next);}
    };
    ws.onclose=()=>{if(live){setControl(false);setFrame("");setError(true);}};
    return()=>{live=false;ws.close();socket.current=null;if(url.current)URL.revokeObjectURL(url.current);};
  },[]);
  async function action(path:string,body:unknown={}){
    setBusy(true);setError(false);setRevocation("");try{const r=await fetch(`/api/mobile-relay/${path}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw new Error();const result=await r.json();setState(result);if(path==="revoke")setRevocation(result.revocationConfirmed?"confirmed":"unconfirmed");}catch{setError(true);}finally{setCredential("");setBusy(false);}
  }
  const enabled=!readOnly&&control&&state?.connected&&state.sharing&&state.inputAllowed;
  function send(actionName:"tap"|"swipe"|"home"|"back",coords:Record<string,number>={}){if(!enabled||socket.current?.readyState!==WebSocket.OPEN)return;socket.current.send(JSON.stringify({type:"input",streamId:state?.streamId,seq:++seq.current,expiresAt:Date.now()+1500,action:actionName,...coords}));}
  function point(e:React.PointerEvent<HTMLImageElement>){const r=e.currentTarget.getBoundingClientRect(),img=e.currentTarget,scale=Math.min(r.width/img.naturalWidth,r.height/img.naturalHeight),w=img.naturalWidth*scale,h=img.naturalHeight*scale;const x=(e.clientX-r.left-(r.width-w)/2)/w,y=(e.clientY-r.top-(r.height-h)/2)/h;return Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&x<=1&&y>=0&&y<=1?{x,y}:null;}
  const status=!state?.configured?t("Relay not configured"):!state.relayConnected?t("Relay disconnected"):state.sharing?t("Phone sharing"):t("Waiting for phone consent");
  return <section className="mobile-relay-panel" aria-label={t("LTE companion")}>
    <h4>{t("LTE companion")}</h4><p role="status">{status}</p>
    <p>{t("Relay setup is required. LTE device control has not been verified.")}</p>
    {revocation&&<p role="status">{revocation==="confirmed"?t("Relay enrollment revoked."):t("Relay revocation was not confirmed. Disable the enrollment on your relay server.")}</p>}
    {error&&<p role="alert">{t("Device action failed. Refresh and try again.")}</p>}
    <details><summary>{t("Configure secure relay")}</summary>
      <form onSubmit={e=>{e.preventDefault();void action("configure",{endpoint,viewerToken:credential});}}>
        <label>{t("Relay WebSocket address")}<input type="url" required value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder={t("Secure relay URL, e.g. {url}",{url:"wss://relay.example/connect?role=viewer"})} disabled={readOnly||busy}/></label>
        <label>{t("Viewer credential")}<input type="password" required autoComplete="off" spellCheck={false} value={credential} onChange={e=>setCredential(e.target.value)} disabled={readOnly||busy}/></label>
        <p>{t("Enter the viewer credential issued by your relay. It stays on this Mac.")}</p>
        <button className="btn" disabled={readOnly||busy||!credential}>{t("Save relay settings")}</button>
      </form>
    </details>
    <div className="mobile-relay-actions"><button className="btn" disabled={readOnly||busy||!state?.configured} onClick={()=>void action("connect")}>{t("Connect relay")}</button><button className="btn" disabled={readOnly||busy||!state?.configured} onClick={()=>void action("revoke")}>{t("Revoke relay connection")}</button></div>
    {readOnly?<p>{t("Control is disabled for watch-only access.")}</p>:<label className="mobile-relay-control"><input type="checkbox" checked={control} disabled={!state?.sharing||!state.inputAllowed} onChange={e=>setControl(e.target.checked)}/>{t("Remote input")}</label>}
    {frame?<><img className={enabled?"mobile-relay-image interactive":"mobile-relay-image"} src={frame} alt={t("Phone sharing")} draggable={false} onPointerDown={e=>{if(!enabled)return;down.current=point(e);e.currentTarget.setPointerCapture(e.pointerId);}} onPointerUp={e=>{const a=down.current,b=point(e);down.current=null;if(!a||!b)return;if(Math.hypot(a.x-b.x,a.y-b.y)>.025)send("swipe",{x:a.x,y:a.y,x2:b.x,y2:b.y});else send("tap",b);}} onPointerCancel={()=>{down.current=null;}}/><div className="mobile-relay-actions"><button className="btn" disabled={!enabled} onClick={()=>send("home")}>{t("Home")}</button><button className="btn" disabled={!enabled} onClick={()=>send("back")}>{t("Back")}</button></div></>:<p>{t("Start sharing in the Android app")}</p>}
  </section>;
}
