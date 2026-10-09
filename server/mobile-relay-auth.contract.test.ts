import {expect,it} from "bun:test";
import {mkdtempSync,rmSync,lstatSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "./index";
import {DeviceStore} from "./devices";
import {DEVICE_COOKIE} from "./auth";
import {MobileRelayGateway} from "./mobile-relay/gateway";
import {startMobileRelay} from "./mobile-relay/serve";
const Socket=WebSocket as unknown as new(url:string,options:Bun.WebSocketOptions)=>WebSocket;
const D="d".repeat(43),V="v".repeat(43);
const sleep=(ms=20)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean){for(let n=0;n<150;n++){if(f())return;await sleep();}throw new Error("Missing mobile auth evidence");}
it("mobile stream uses app auth, rejects foreign origins, blocks watchers and detaches revoked devices",async()=>{
 const root=mkdtempSync(join(tmpdir(),"tw-lte-")),store=new DeviceStore(root);
 const watcher=store.pair(store.startPairing().code,"Synthetic LTE watcher","watch")!;
 const relay=startMobileRelay({deviceToken:D,viewerToken:V,expiresAt:Date.now()+60_000,port:0});
 const relayUrl=`ws://127.0.0.1:${relay.server.port}/connect`;
 const gateway=new MobileRelayGateway(root,c=>new Socket(relayUrl+"?role=viewer",{headers:{Authorization:`Bearer ${c.viewerToken}`}}));
 const app=createServer({port:0,stateDir:root,token:"synthetic-lte-owner",tailscaleOwner:null,machines:false,mobileRelay:gateway});
 const base=`http://127.0.0.1:${app.port}`,owner={authorization:"Bearer synthetic-lte-owner",origin:base,"content-type":"application/json"};
 const command=(path:string,body:unknown={})=>fetch(base+"/api/mobile-relay/"+path,{method:"POST",headers:owner,body:JSON.stringify(body)});
 let device:WebSocket|undefined,watch:WebSocket|undefined,drive:WebSocket|undefined;
 try{
  expect((await fetch(base+"/api/mobile-relay")).status).toBe(401);
  expect((await fetch(base+"/api/mobile-relay/connect",{method:"POST",headers:{...owner,origin:"https://foreign.invalid"}})).status).toBe(403);
  expect((await fetch(base+"/api/mobile-relay/stream",{headers:{...owner,origin:"https://foreign.invalid"}})).status).toBe(403);
  const configured=await command("configure",{endpoint:"wss://synthetic.invalid/connect?role=viewer",viewerToken:V});expect(configured.status).toBe(200);expect(await configured.text()).not.toContain(V);
  expect(lstatSync(join(root,"mobile-relay.json")).mode&0o777).toBe(0o600);expect(readFileSync(join(root,"mobile-relay.json"),"utf8")).toContain(V);
  const incoming:any[]=[],watchFrames:ArrayBuffer[]=[],watchState:any[]=[];
  device=new Socket(relayUrl+"?role=device",{headers:{Authorization:`Bearer ${D}`}});
  device.onmessage=e=>{if(typeof e.data!=="string")return;const d=JSON.parse(e.data);incoming.push(d);if(d.type==="session")device!.send(JSON.stringify({type:"status",sharing:true,inputAllowed:true}));};
  await until(()=>device!.readyState===WebSocket.OPEN);
  expect((await command("connect")).status).toBe(200);
  await until(()=>gateway.overview().sharing&&gateway.overview().connected);
  watch=new Socket(base.replace("http:","ws:")+"/api/mobile-relay/stream",{headers:{Origin:base,Cookie:`${DEVICE_COOKIE}=${watcher.token}`}});watch.binaryType="arraybuffer";
  watch.onmessage=e=>{if(e.data instanceof ArrayBuffer)watchFrames.push(e.data);else watchState.push(JSON.parse(String(e.data)));};
  await until(()=>watchState.length>0);
  const input={type:"input",streamId:gateway.overview().streamId,seq:1,expiresAt:Date.now()+1500,action:"home"};
  watch.send(JSON.stringify(input));await sleep(70);expect(incoming.filter(x=>x.type==="input")).toHaveLength(0);
  device.send(new Uint8Array([255,216,255,217]));await until(()=>watchFrames.length===1);
  drive=new Socket(base.replace("http:","ws:")+"/api/mobile-relay/stream",{headers:owner});await until(()=>drive!.readyState===WebSocket.OPEN);
  drive.send(JSON.stringify({...input,expiresAt:Date.now()+1500}));await until(()=>incoming.some(x=>x.type==="input"));
  const revoked=await fetch(base+"/api/devices/"+watcher.device.id,{method:"DELETE",headers:{...owner,"x-herdr-machine":"1"}});expect(revoked.status).toBe(204);
  await until(()=>watch!.readyState===WebSocket.CLOSED);const before=watchFrames.length;await sleep(170);device.send(new Uint8Array([255,216,255,217]));await sleep(70);expect(watchFrames.length).toBe(before);
  const result=await command("revoke");expect(result.status).toBe(200);expect((await result.json()).revocationConfirmed).toBe(true);
  expect(new MobileRelayGateway(root).overview().configured).toBe(false);
 }finally{device?.close();watch?.close();drive?.close();app.stop();relay.stop();rmSync(root,{recursive:true,force:true});}
});
