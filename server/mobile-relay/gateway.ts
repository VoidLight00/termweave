import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Peer } from "./hub";
const AuthSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
type Config = { endpoint: string; viewerToken: string };
type Browser = Peer & { getBufferedAmount?: () => number };
export type MobileRelayState = { type: "mobile-relay-state"; configured: boolean; endpoint: string | null; connected: boolean; relayConnected: boolean; sharing: boolean; inputAllowed: boolean; streamId: string | null; error: string | null; revocationConfirmed: boolean };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
async function smallJson(request: Request): Promise<Record<string, unknown>> {
  const reader=request.body?.getReader();if(!reader)throw new Error("invalid_request");
  const chunks: Uint8Array[]=[];let size=0;
  try {for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>8192)throw new Error("request_too_large");chunks.push(next.value);}}
  finally {await reader.cancel();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid_request");return value;
}
export class MobileRelayGateway {
  private config: Config | null = null;
  private upstream: WebSocket | null = null;
  private peers = new Map<Browser, { readOnly: boolean; seq: number }>();
  private sequence = 0;
  private disposed = false;
  private mutations: Promise<unknown> = Promise.resolve();
  private file: string;
  private state: MobileRelayState = {type:"mobile-relay-state",configured:false,endpoint:null,connected:false,relayConnected:false,sharing:false,inputAllowed:false,streamId:null,error:null,revocationConfirmed:false};
  constructor(private stateDir: string, private connectSocket = (c:Config) => new AuthSocket(c.endpoint,{headers:{Authorization:`Bearer ${c.viewerToken}`}})) {
    this.file=join(stateDir,"mobile-relay.json");
    try {const stat=lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error();this.config=this.validate(JSON.parse(readFileSync(this.file,"utf8")));this.state.configured=true;this.state.endpoint=this.config.endpoint;}catch{this.config=null;}
  }
  private validate(body: Record<string, unknown>): Config {
    if(typeof body.endpoint!=="string"||typeof body.viewerToken!=="string")throw new Error("invalid_relay_config");
    let url:URL;try{url=new URL(body.endpoint);}catch{throw new Error("invalid_relay_config");}
    if(url.protocol!=="wss:"||url.username||url.password||url.hash||url.pathname!=="/connect"||url.search!=="?role=viewer"||!url.hostname||body.viewerToken.length<43||body.viewerToken.length>512||/[\s\r\n]/.test(body.viewerToken))throw new Error("invalid_relay_config");
    return {endpoint:url.toString(),viewerToken:body.viewerToken};
  }
  overview() {return {...this.state};}
  private broadcast(data: string | Uint8Array) {for(const p of this.peers.keys()){if((p.getBufferedAmount?.()??0)>1_048_576){p.close(1013,"Slow viewer");this.peers.delete(p);}else p.send(data);}}
  private publish(){this.broadcast(JSON.stringify(this.state));}
  attach(peer:Browser,readOnly:boolean){if(this.disposed){peer.close(1001,"Stopped");return;}this.peers.set(peer,{readOnly,seq:0});peer.send(JSON.stringify(this.state));}
  detach(peer:Browser){this.peers.delete(peer);}
  message(peer:Browser,raw:string|Uint8Array){
    const scope=this.peers.get(peer);if(!scope||scope.readOnly||typeof raw!=="string"||raw.length>2048||!this.state.sharing||!this.state.inputAllowed||!this.state.connected)return;
    try{const d=JSON.parse(raw),now=Date.now();if(d.type!=="input"||d.streamId!==this.state.streamId||!Number.isSafeInteger(d.seq)||d.seq<=scope.seq||!Number.isSafeInteger(d.expiresAt)||d.expiresAt<now||d.expiresAt>now+2000||!["tap","swipe","home","back"].includes(d.action))return;
      const fields=d.action==="tap"?["x","y"]:d.action==="swipe"?["x","y","x2","y2"]:[];
      for(const key of fields)if(!Number.isFinite(d[key])||d[key]<0||d[key]>1)return;
      scope.seq=d.seq;const command:Record<string,unknown>={type:"input",streamId:this.state.streamId,seq:++this.sequence,expiresAt:d.expiresAt,action:d.action};for(const key of fields)command[key]=d[key];
      if(this.upstream?.readyState===WebSocket.OPEN)this.upstream.send(JSON.stringify(command));
    }catch{/* Malformed input is never forwarded. */}
  }
  private disconnect(){const old=this.upstream;this.upstream=null;old?.close(1000,"Disconnected");this.state.connected=false;this.state.relayConnected=false;this.state.sharing=false;this.state.inputAllowed=false;this.state.streamId=null;this.publish();}
  connect(){
    if(!this.config||this.disposed)throw new Error("relay_not_configured");this.disconnect();this.state.error=null;this.state.revocationConfirmed=false;
    const ws=this.connectSocket(this.config);this.upstream=ws;ws.binaryType="arraybuffer";
    const closed=()=>{if(this.upstream!==ws)return;this.upstream=null;this.state.connected=false;this.state.relayConnected=false;this.state.sharing=false;this.state.inputAllowed=false;this.state.streamId=null;this.publish();};
    ws.addEventListener("open",()=>{if(this.upstream===ws){this.state.relayConnected=true;this.publish();}});
    ws.addEventListener("close",closed);ws.addEventListener("error",()=>{if(this.upstream===ws){this.state.error="relay_connection_failed";closed();ws.close();}});
    ws.addEventListener("message",e=>{if(this.upstream!==ws)return;
      if(typeof e.data!=="string"){if(this.state.sharing&&e.data instanceof ArrayBuffer&&e.data.byteLength<=1_048_576)this.broadcast(new Uint8Array(e.data));return;}
      if(e.data.length>4096)return;
      try{const d=JSON.parse(e.data);
        if(d.type==="session"&&typeof d.streamId==="string"&&d.streamId.length<=100){this.state.streamId=d.streamId;this.sequence=0;this.state.connected=d.connected===true;this.state.sharing=d.sharing===true;this.state.inputAllowed=false;for(const p of this.peers.values())p.seq=0;}
        else if(d.type==="status"){this.state.sharing=d.sharing===true;this.state.inputAllowed=d.inputAllowed===true;}
        else if(d.type==="revoked"){this.state.revocationConfirmed=true;}
        this.publish();
      }catch{/* Ignore unrecognized or invalid relay data. */}
    });this.publish();
  }
  handle(request:Request,readOnly:boolean):Promise<Response>{
    if(request.method!=="POST"||readOnly)return this.handleMutation(request,readOnly);
    const operation=this.mutations.then(()=>this.handleMutation(request,false));
    this.mutations=operation.catch(()=>{});
    return operation;
  }
  private async handleMutation(request:Request,readOnly:boolean):Promise<Response>{
    if(this.disposed)return json({error:"relay_stopped"},503);
    const path=new URL(request.url).pathname;
    if(path==="/api/mobile-relay"&&request.method==="GET")return json(this.overview());
    if(readOnly)return json({error:"read_only"},403);
    if(request.method!=="POST")return json({error:"not_found"},404);
    try{
      if(path==="/api/mobile-relay/configure"){
        const config=this.validate(await smallJson(request));mkdirSync(this.stateDir,{recursive:true,mode:0o700});
        const tmp=join(this.stateDir,`.mobile-relay-${randomUUID()}.tmp`);writeFileSync(tmp,JSON.stringify(config),{mode:0o600,flag:"wx"});renameSync(tmp,this.file);
        this.disconnect();this.config=config;this.state.configured=true;this.state.endpoint=config.endpoint;this.state.error=null;this.publish();return json(this.overview());
      }
      if(path==="/api/mobile-relay/connect"){this.connect();return json(this.overview());}
      if(path==="/api/mobile-relay/revoke"){
        this.state.revocationConfirmed=false;
        if(this.upstream?.readyState===WebSocket.OPEN){this.upstream.send(JSON.stringify({type:"revoke"}));await new Promise(resolve=>setTimeout(resolve,300));}
        this.disconnect();this.config=null;this.state.configured=false;this.state.endpoint=null;try{unlinkSync(this.file);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw new Error("relay_request_failed");}this.publish();return json(this.overview());
      }
      return json({error:"not_found"},404);
    }catch(e){const code=e instanceof Error&&["invalid_relay_config","request_too_large","relay_not_configured"].includes(e.message)?e.message:"relay_request_failed";return json({error:code},400);}
  }
  dispose(){this.disposed=true;this.disconnect();for(const p of this.peers.keys())p.close(1001,"Stopped");this.peers.clear();}
}
