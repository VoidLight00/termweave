import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileRelayGateway } from "./gateway";
import { startMobileRelay } from "./serve";
const Socket=WebSocket as unknown as new(url:string,options:Bun.WebSocketOptions)=>WebSocket;
const token="v".repeat(43);
function req(path:string,body:unknown={}){return new Request("http://localhost/api/mobile-relay/"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});}
test("revoke cannot delete a configuration accepted later",async()=>{
 const root=mkdtempSync(join(tmpdir(),"tw-gateway-"));const relay=startMobileRelay({deviceToken:"d".repeat(43),viewerToken:token,expiresAt:Date.now()+60_000,port:0});
 const gateway=new MobileRelayGateway(root,()=>new Socket(`ws://127.0.0.1:${relay.server.port}/connect?role=viewer`,{headers:{Authorization:`Bearer ${token}`}}));
 try{
  expect((await gateway.handle(req("configure",{endpoint:"wss://old.invalid/connect?role=viewer",viewerToken:token}),false)).status).toBe(200);
  await gateway.handle(req("connect"),false);
  for(let i=0;i<100&&!gateway.overview().relayConnected;i++)await new Promise(r=>setTimeout(r,10));
  expect(gateway.overview().relayConnected).toBe(true);
  const revoke=gateway.handle(req("revoke"),false);
  const configure=gateway.handle(req("configure",{endpoint:"wss://new.invalid/connect?role=viewer",viewerToken:"n".repeat(43)}),false);
  expect((await revoke).status).toBe(200);expect((await configure).status).toBe(200);
  expect(gateway.overview().configured).toBe(true);expect(gateway.overview().endpoint).toBe("wss://new.invalid/connect?role=viewer");
  expect(JSON.parse(readFileSync(join(root,"mobile-relay.json"),"utf8")).viewerToken).toBe("n".repeat(43));
 }finally{gateway.dispose();relay.stop();rmSync(root,{recursive:true,force:true});}
});
