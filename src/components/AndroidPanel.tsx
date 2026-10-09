import { useCallback, useEffect, useRef, useState } from "react";
import type { AndroidOverview, MirrorMode } from "../../shared/android.ts";
import { useT } from "../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import "./AndroidPanel.css";
import { MobileRelayPanel } from "./MobileRelayPanel.tsx";

async function request<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(`/api/android${path}`, body === undefined ? {} : {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const data = await response.json();
  if(!response.ok) throw new Error(data.error?.code ?? "android_unavailable");
  return data as T;
}
export function AndroidPanel({ readOnly = false }: {readOnly?: boolean}) {
  const root=useRef<HTMLElement>(null);
  useEffect(()=>{if(new URLSearchParams(window.location.search).get("panel")==="android")root.current?.scrollIntoView({block:"start"});},[]);
  const t=useT();const [data,setData]=useState<AndroidOverview|null>(null);
  const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");
  const [endpoint,setEndpoint]=useState("");const [code,setCode]=useState("");
  const [mode,setMode]=useState<MirrorMode>("standard");const [forget,setForget]=useState<string|null>(null);
  const load=useCallback(async()=>{setData(await request<AndroidOverview>());},[]);
  useEffect(()=>{let live=true;const poll=()=>request<AndroidOverview>().then(x=>{if(live)setData(x);},()=>{if(live)setError("android_unavailable");});void poll();const timer=setInterval(poll,10000);return()=>{live=false;clearInterval(timer);};},[]);
  const run=async(path:string,body:unknown)=>{setBusy(true);setError("");setNotice("");try{await request(path,body);await load();setNotice(path==="/pair"?t("Pairing saved. Use the connection port to connect."):t("Device action completed."));}catch(e){setError(e instanceof Error?e.message:"android_unavailable");}finally{setCode("");setBusy(false);}};
  const errors:Record<string,string>={device_not_connected:t("Connect and authorize your phone, then refresh."),device_not_registered:t("Register this phone before mirroring."),mirror_already_running:t("This phone already has a mirror window."),pairing_failed:t("Pairing failed. Check the code and pairing port."),invalid_pairing_code:t("Enter the six-digit pairing code."),connection_failed:t("Connection failed. Check the phone's connection port."),private_wifi_endpoint_required:t("Enter a private Wi-Fi IPv4 address and port."),invalid_endpoint:t("Enter a private Wi-Fi IPv4 address and port."),stop_mirror_first:t("Stop the mirror before removing this phone."),mirror_stop_unconfirmed:t("The mirror has not confirmed shutdown."),android_unavailable:t("Android tools are unavailable. Check the host Mac."),adb_command_failed:t("The phone did not respond. Check its connection and authorization."),read_only:t("This device can only watch.")};
  return <section ref={root} className="android-panel" aria-label={t("My Android devices")}>
    <p>{t("Mirror windows open on the Mac running TermWeave, not on this browser's device.")}</p>
    <p className="settings-description">{t("USB and same-Wi-Fi mirroring need no Tailscale. Unattended LTE recovery is not verified.")}</p>
    {error&&<p role="alert">{errors[error]??t("Device action failed. Refresh and try again.")}</p>}
    {notice&&<p role="status">{notice}</p>}
    <button className="btn" disabled={busy} onClick={()=>{setError("");void load().catch(()=>setError("android_unavailable"));}}>{t("Refresh")}</button>
    {data&&(!data.available.adb||!data.available.scrcpy)&&<p>{t("Install ADB and scrcpy on the host Mac to enable mirroring.")}</p>}
    {data?.devices.length===0&&<p>{t("No Android device found. Connect over Wi-Fi below, or authorize USB debugging.")}</p>}
    <ul className="android-device-list">{data?.devices.map(device=>{
      const session=data.sessions.find(s=>s.deviceId===device.id&&["connecting","running"].includes(s.state));
      const failed=data.sessions.filter(s=>s.deviceId===device.id).at(-1)?.state==="error";
      return <li key={device.id}><div><strong>{device.name}</strong><span>{device.model} · {t("Android version {version}", {version:device.androidVersion})} · {device.state==="offline"?t("Offline"):device.transport==="usb"?"USB":"Wi-Fi"}</span></div>
        <div className="android-actions">
        {!device.registered?<button className="btn" disabled={busy||readOnly} onClick={()=>void run("/register",{id:device.id,name:device.name})}>{t("Register this phone")}</button>:<>
          {session?<button className="btn" disabled={busy||readOnly} onClick={()=>void run("/mirror/stop",{id:session.id})}>{t("Stop mirroring")}</button>:<button className="btn" disabled={busy||readOnly||device.state==="offline"||!data.available.scrcpy} onClick={()=>void run("/mirror/start",{id:device.id,mode})}>{t("Open phone screen")}</button>}
          <button className="btn" disabled={busy||readOnly||!!session} onClick={()=>setForget(device.id)}>{t("Remove registration")}</button>
        </>}
        </div>
        {session&&<p className="settings-description">{t("Mirror process is running. Verify the picture in its Mac window.")}</p>}
        {failed&&!session&&<p role="alert">{t("The mirror process failed. Check the host Mac and phone authorization.")}</p>}
      </li>;
    })}</ul>
    <label>{t("Mirror mode")}<select className="input" value={mode} disabled={busy||readOnly} onChange={e=>setMode(e.target.value as MirrorMode)}>
      <option value="standard">{t("Standard")}</option><option value="light">{t("Low bandwidth")}</option><option value="screen-off">{t("Turn phone screen off")}</option>
    </select></label>
    <details><summary>{t("Connect over Wi-Fi")}</summary><p>{t("Enable Wireless debugging on your phone. Pairing and connection use different ports. Pair first, then enter the connection port.")}</p>
      <form onSubmit={e=>{e.preventDefault();void run(code?"/pair":"/connect",code?{endpoint,code}:{endpoint});}}>
        <label>{t("Phone Wi-Fi address and port")}<input className="input" value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder="192.168.1.20:37000" autoComplete="off" spellCheck={false} required disabled={busy||readOnly}/></label>
        <label>{t("Pairing code (only for initial pairing)")}<input className="input" type="password" inputMode="numeric" maxLength={6} value={code} autoComplete="off" onChange={e=>setCode(e.target.value)} disabled={busy||readOnly}/></label>
        <button className="btn" type="submit" disabled={busy||readOnly}>{code?t("Pair phone"):t("Connect")}</button>
      </form>
    </details>
    {forget&&<ConfirmDialog title={t("Remove phone registration?")} body={t("This removes only the TermWeave registration. Revoke USB or wireless debugging separately on your phone.")} confirmLabel={t("Remove registration")} onClose={()=>setForget(null)} onConfirm={async()=>{await request("/forget",{id:forget});await load();setForget(null);}}/>}
    <MobileRelayPanel readOnly={readOnly}/>
  </section>;
}
