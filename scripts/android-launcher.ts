/** Dock launcher: the server remains the sole owner of mirror subprocesses. */
import { spawn } from "node:child_process";
import type { AndroidOverview } from "../shared/android.ts";
const origin="http://127.0.0.1:7317";
const headers:Record<string,string>={Origin:origin,"Content-Type":"application/json"};
if(process.env.HERDR_WEB_TOKEN)headers.Authorization=`Bearer ${process.env.HERDR_WEB_TOKEN}`;
try {
 const response=await fetch(`${origin}/api/android`,{headers,signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error();
 const overview=await response.json() as AndroidOverview;
 const devices=overview.devices.filter(d=>d.registered&&d.state==="ready");
 if(devices.length!==1)throw new Error();
 const device=devices[0]!;
 if(overview.sessions.some(s=>s.deviceId===device.id&&["connecting","running"].includes(s.state)))throw new Error();
 const result=await fetch(`${origin}/api/android/mirror/start`,{method:"POST",headers,body:JSON.stringify({id:device.id,mode:"standard"}),signal:AbortSignal.timeout(20000)});
 if(!result.ok||(await result.json()).state!=="running")throw new Error();
}catch{
 // Missing registration, ambiguous selection and failure all go to explicit device controls.
 spawn("/usr/bin/open",["-a",`${process.env.HOME}/Applications/TermWeave.app`,"--args",`${origin}/?panel=android`],{stdio:"ignore",detached:true}).unref();
}
