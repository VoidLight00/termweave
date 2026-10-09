import { expect, test } from "bun:test";
import { startMobileRelay } from "./serve";
// Bun supports authenticated WebSocket headers; the shared TS configuration includes DOM types.
const AuthenticatedSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
const D="d".repeat(43),V="v".repeat(43);
const pause=()=>new Promise(r=>setTimeout(r,20));
async function until(f:()=>boolean){for(let n=0;n<100;n++){if(f())return;await pause();}throw new Error("Timed out waiting for relay evidence");}
test("real sockets enforce authentication, forward frames and close revoked peers",async()=>{
 const r=startMobileRelay({deviceToken:D,viewerToken:V,expiresAt:Date.now()+60_000,port:0});
 const base=`http://127.0.0.1:${r.server.port}`,wsBase=base.replace("http:","ws:");
 let d:WebSocket|undefined,v:WebSocket|undefined;
 try {
  expect((await fetch(base+"/connect?role=device")).status).toBe(401);
  expect((await fetch(base+"/connect?role=device",{headers:{Origin:"https://evil.invalid",Authorization:`Bearer ${D}`}})).status).toBe(404);
  const dm:any[]=[],vm:any[]=[];
  d=new AuthenticatedSocket(wsBase+"/connect?role=device",{headers:{Authorization:`Bearer ${D}`}});d.addEventListener("message",e=>dm.push(typeof e.data==="string"?JSON.parse(e.data):e.data));
  await until(()=>d!.readyState===WebSocket.OPEN);
  v=new AuthenticatedSocket(wsBase+"/connect?role=viewer",{headers:{Authorization:`Bearer ${V}`}});v.binaryType="arraybuffer";v.addEventListener("message",e=>vm.push(typeof e.data==="string"?JSON.parse(e.data):e.data));
  await until(()=>vm.some(m=>m.type==="session"&&m.connected));
  d.send(JSON.stringify({type:"status",sharing:true,inputAllowed:true}));await until(()=>vm.some(m=>m.type==="status"));
  d.send(new Uint8Array([255,216,255,217]));await until(()=>vm.some(m=>m instanceof ArrayBuffer));
  const session=[...vm].reverse().find(m=>m.type==="session");v.send(JSON.stringify({type:"input",streamId:session.streamId,seq:1,expiresAt:Date.now()+1500,action:"home"}));await until(()=>dm.some(m=>m.type==="input"));
  expect(dm.filter(m=>m.type==="input")).toHaveLength(1);
  r.hub.revoke();await until(()=>d!.readyState===WebSocket.CLOSED&&v!.readyState===WebSocket.CLOSED);
 }finally{d?.close();v?.close();r.stop();}
});
