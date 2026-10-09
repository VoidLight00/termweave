import { seatAttention } from "./seat-attention.ts";
import {verifyTerminalIdentities,type OpenRigNativeSnapshot} from './terminal-identities.ts';
import {OpenRigRecovery} from './recovery.ts';
import {createHash} from 'node:crypto';
import {OpenRigStarter,type StarterOptions} from './starter.ts';
import {Database} from 'bun:sqlite';
import {mkdirSync,chmodSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import type {OpenRigOverview, OpenRigTeamDetail, OpenRigPreview, OpenRigOpenResult, OpenRigRecord, OpenRigAbsent,OpenRigQueueCreate,OpenRigQueueResult,OpenRigQueueDetail,OpenRigQueueHandoff,OpenRigQueueHandoffResult} from '../../shared/openrig.ts';
export class OpenRigError extends Error {constructor(public code: string, public status = 503) {super(code);}}
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const object = (v: unknown): OpenRigRecord => {if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OpenRigError('invalid_upstream_response',502); return v as OpenRigRecord;};
const records = (v: unknown): OpenRigRecord[] => {if (!Array.isArray(v)) throw new OpenRigError('invalid_upstream_response',502); return v.map(object);};
const str = (v: unknown): string => {if(typeof v !== 'string') throw new OpenRigError('invalid_upstream_response',502);return v;};
const count=(v:unknown):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new OpenRigError('invalid_upstream_response',502);return v;};
const project=(row:OpenRigRecord,keys:string[]):OpenRigRecord=>Object.fromEntries(keys.filter(k=>row[k]===null||typeof row[k]==='string'||typeof row[k]==='boolean'||typeof row[k]==='number').map(k=>[k,row[k]]));
const strings = (v:unknown):string[] => {if(!Array.isArray(v))throw new OpenRigError('invalid_upstream_response',502);return v.map(str);};
const absent = (v:unknown):OpenRigAbsent[] => records(v).map(r=>({seat:str(r.seat),reason:str(r.reason),host:r.host===null?null:str(r.host)}));
export function inputText(v:unknown,max=256): string {if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f\x7f]/.test(v))throw new OpenRigError('invalid_request',400);return v;}
export async function boundedJson(response: Response | Request, limit: number): Promise<unknown> {
  const n=Number(response.headers.get('content-length'));if(n>limit)throw new OpenRigError('payload_too_large',413);
  const reader=response.body?.getReader();if(!reader)throw new OpenRigError('invalid_json',400);
  const parts:Uint8Array[]=[];let size=0;
  try {while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit){await reader.cancel();throw new OpenRigError('payload_too_large',413);}parts.push(chunk.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new OpenRigError('invalid_json',400);}
}
const queueProjection=(r:OpenRigRecord)=>project(r,['qitemId','summary','tsCreated','tsUpdated','sourceSession','destinationSession','state','priority','blockedOn','handedOffTo','handedOffFrom','humanIntent']);
export class OpenRigRuntime {
  private readonly base: string;
  readonly starter:OpenRigStarter;
  readonly recovery:OpenRigRecovery;
  private nativeSnapshot?:OpenRigNativeSnapshot;
  // A transport failure cannot prove whether Herdr already created the workspace.
  // Keep a per-view hold until explicit operator reconciliation; configured storage survives restarts.
  private holdDb:Database|null=null;
  private holdStorageFailed=false;
  private uncertainViews=new Set<string>();
  private previews=new Map<string,{plan:string;at:number;used:boolean}>();
  private requests=new Map<string,{fingerprint:string;result:Promise<OpenRigOpenResult>}>();
  constructor(options:{baseUrl?:string;fetch?:Fetcher;timeoutMs?:number;stateDir?:string;starter?:StarterOptions;nativeSnapshot?:OpenRigNativeSnapshot}={}) {
    this.nativeSnapshot=options.nativeSnapshot;
    let base='';
    try {
      const url=new URL(options.baseUrl??process.env.TERMWEAVE_OPENRIG_URL??'http://127.0.0.1:7338');
      if(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash)base=url.origin;
    } catch { /* Invalid optional configuration must not stop native terminals. */ }
    this.base=base;this.fetcher=options.fetch??fetch;this.timeoutMs=options.timeoutMs??8000;
    this.starter=new OpenRigStarter(options.stateDir,(path,body,timeout)=>this.request(path,body,timeout),{has:key=>this.hasHold(key),place:key=>this.placeHold(key),clear:key=>this.clearHold(key)},options.starter);
    this.recovery=new OpenRigRecovery((path,body,timeout)=>this.request(path,body,timeout),{has:key=>this.hasHold(key),place:key=>this.placeHold(key),clear:key=>this.clearHold(key),finish:(marker,key)=>this.completeHold(marker,key)});
    if(options.stateDir){
      try{
        mkdirSync(options.stateDir,{recursive:true,mode:0o700});
        const path=join(options.stateDir,'openrig-operation-holds.sqlite');
        try{if(lstatSync(path).isSymbolicLink())throw new Error('invalid storage');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        this.holdDb=new Database(path,{create:true});chmodSync(path,0o600);
        this.holdDb.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS holds (origin TEXT NOT NULL, view TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(origin,view))');
      }catch{this.holdStorageFailed=true;}
    }
  }
  dispose(){this.holdDb?.close();this.holdDb=null;this.holdStorageFailed=true;}
  private hasHold(view:string):boolean{
    if(this.holdStorageFailed)throw new OpenRigError('openrig_hold_storage_unavailable');
    try{return this.uncertainViews.has(view)||!!this.holdDb?.query('SELECT 1 FROM holds WHERE origin=? AND view=?').get(this.base,view);}
    catch{this.holdStorageFailed=true;throw new OpenRigError('openrig_hold_storage_unavailable');}
  }
  private placeHold(view:string){
    if(this.holdStorageFailed)throw new OpenRigError('openrig_hold_storage_unavailable');
    try{
      if(this.holdDb){const result=this.holdDb.query('INSERT OR IGNORE INTO holds(origin,view,created_at) VALUES (?,?,?)').run(this.base,view,new Date().toISOString());if(result.changes!==1)throw new OpenRigError('openrig_open_uncertain',409);}
      this.uncertainViews.add(view);
    }catch(e){if(e instanceof OpenRigError)throw e;this.holdStorageFailed=true;throw new OpenRigError('openrig_hold_storage_unavailable');}
  }
  private clearHold(view:string){
    try{this.holdDb?.query('DELETE FROM holds WHERE origin=? AND view=?').run(this.base,view);this.uncertainViews.delete(view);}
    catch{this.holdStorageFailed=true;throw new OpenRigError('openrig_hold_storage_unavailable');}
  }
  private completeHold(marker:string,key:string){
    if(this.holdStorageFailed)throw new OpenRigError('openrig_hold_storage_unavailable');
    try{
      if(this.holdDb){this.holdDb.transaction(()=>{if(this.holdDb!.query('SELECT 1 FROM holds WHERE origin=? AND view=?').get(this.base,marker)){this.holdDb!.query('DELETE FROM holds WHERE origin=? AND view IN (?,?)').run(this.base,marker,key);}})();}
      else if(!this.uncertainViews.has(marker))return;
      this.uncertainViews.delete(marker);this.uncertainViews.delete(key);
    }catch{this.holdStorageFailed=true;throw new OpenRigError('openrig_hold_storage_unavailable');}
  }
  private fetcher:Fetcher;private timeoutMs:number;
  private async request(path:string,body?:unknown,timeoutMs=this.timeoutMs):Promise<unknown>{
    if(!this.base)throw new OpenRigError('openrig_invalid_config');
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const res=await this.fetcher(this.base+path,{method:body===undefined?'GET':'POST',redirect:'error',signal:controller.signal,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(!res.ok){throw new OpenRigError(res.status===409?'preview_changed':res.status===404?'not_found':'openrig_unavailable',res.status===409?409:res.status===404?404:503);}
      try{return await boundedJson(res,2*1024*1024);}catch{throw new OpenRigError('invalid_upstream_response',502);}
    }catch(e){if(e instanceof OpenRigError)throw e;throw new OpenRigError('openrig_unavailable');}finally{clearTimeout(timer);}
  }
  async overview():Promise<OpenRigOverview>{
    const [ps,views,status]=await Promise.all([this.request('/api/ps'),this.request('/api/terminal/views'),this.request('/api/terminal/status?provider=herdr')]);
    const v=object(views);const providers=records(object(status).providers);const p=providers.find(p=>p.name==='herdr');const s=p?object(p.status):{};const l=p?object(p.liveness):{};
    return {connected:true,checkedAt:new Date().toISOString(),teams:records(ps).map(r=>({rigId:str(r.rigId),name:str(r.name??r.rigName),rigName:str(r.rigName??r.name),nodeCount:count(r.nodeCount),runningCount:count(r.runningCount),status:str(r.status),isArchived:r.isArchived===true})),views:{rigs:strings(v.rigs),saved:records(v.saved).map(r=>({id:str(r.id),...(typeof r.name==='string'?{name:r.name}:{})}))},provider:{available:s.available===true,alive:l.alive===true,...(typeof s.version==='string'?{version:s.version}:{})}};
  }
  async team(rigId:string):Promise<OpenRigTeamDetail>{
    inputText(rigId);const id=encodeURIComponent(rigId);
    const [n,s]=await Promise.all([this.request(`/api/rigs/${id}/nodes`),this.request(`/api/rigs/${id}/snapshots`)]);
    const scoped=await this.scopedQueue(records(n)),items=scoped.items.slice(0,100),truncated=scoped.truncated;
    // Installed 0.6.7 attention=1 silently ignores rig. Filter the scoped list using its documented predicate instead.
    const human=(s:unknown)=>typeof s==='string'&&(/^(?:human(?:-[A-Za-z0-9._-]+)?@(kernel|host)|[A-Za-z0-9._:-]+@external)$/.test(s));
    const attention=items.filter(q=>['pending','in-progress','blocked'].includes(String(q.state))&&q.humanIntent!=='update'&&(human(q.destinationSession)||(q.state==='blocked'&&human(q.blockedOn))));
    return {rigId,nodes:records(n).map(r=>({...project(r,['nodeId','rigId','rigName','logicalId','podNamespace','role','canonicalSessionName','nodeKind','runtime','sessionStatus','startupStatus','lifecycleState','model','hostSelfId','lastActivityAt','pendingWorkCount','blockedWorkCount']),attention:seatAttention(r)})),queue:{items:items.map(queueProjection),limit:100,truncated},attention:{items:attention.map(queueProjection),limit:100,truncated},snapshots:records(s).map(r=>project(r,['id','rigId','kind','status','createdAt'])),checkedAt:new Date().toISOString()};
  }


  private async scopedQueue(nodes:OpenRigRecord[]):Promise<{items:OpenRigRecord[];truncated:boolean}>{
    if(!nodes.length)return {items:[],truncated:false};
    const names=new Set(nodes.map(n=>n.rigName));
    if(names.size!==1||typeof nodes[0]!.rigName!=='string'||!nodes[0]!.rigName)throw new OpenRigError('invalid_upstream_response',502);
    const sessions=new Set(nodes.map(n=>n.canonicalSessionName).filter(s=>typeof s==='string'));
    const rows=records(await this.request('/api/queue/list?rig='+encodeURIComponent(nodes[0]!.rigName)+'&limit=101'));
    return {items:rows.filter(q=>(typeof q.sourceSession==='string'&&sessions.has(q.sourceSession))||(typeof q.destinationSession==='string'&&sessions.has(q.destinationSession))),truncated:rows.length>100};
  }
  async capabilities():Promise<{humanHandoff:boolean}>{
    try{const c=object(await this.request('/api/queue/termweave-capabilities'));return {humanHandoff:c.handoffCompareAndSwap===1};}catch{return {humanHandoff:false};}
  }
  async handoffQueue(input:OpenRigQueueHandoff):Promise<OpenRigQueueHandoffResult>{
    inputText(input.rigId);inputText(input.qitemId);inputText(input.toSession);inputText(input.expectedUpdatedAt);inputText(input.requestId,128);inputText(input.summary);
    if(!['pending','in-progress','blocked'].includes(input.expectedState))throw new OpenRigError('invalid_request',400);
    if(!(await this.capabilities()).humanHandoff)throw new OpenRigError('handoff_guard_unavailable',409);
    const detail=await this.queueDetail(input.rigId,input.qitemId);
    if(detail.item.destinationSession!=='human@kernel')throw new OpenRigError('human_task_required',403);
    if(detail.item.state!==input.expectedState||detail.item.tsUpdated!==input.expectedUpdatedAt)throw new OpenRigError('queue_item_changed',409);
    const nodes=records(await this.request('/api/rigs/'+encodeURIComponent(input.rigId)+'/nodes'));
    if(!nodes.some(n=>n.canonicalSessionName===input.toSession))throw new OpenRigError('queue_destination_changed',409);
    const key='handoff:'+input.qitemId;if(this.hasHold(key))throw new OpenRigError('queue_handoff_uncertain',409);
    this.placeHold(key);
    try{
      const r=object(await this.request('/api/queue/'+encodeURIComponent(input.qitemId)+'/handoff',{fromSession:'human@kernel',toSession:input.toSession,summary:input.summary,nudge:false,expectedCurrent:{destinationSession:'human@kernel',state:input.expectedState,tsUpdated:input.expectedUpdatedAt}}));
      const closed=object(r.closed),created=object(r.created);
      if(closed.qitemId!==input.qitemId||closed.state!=='handed-off'||created.destinationSession!==input.toSession||created.sourceSession!=='human@kernel')throw new Error('unexpected handoff');
      return {closed:queueProjection(closed),created:queueProjection(created),actor:'human@kernel',provenance:'claimed:v1',delivery:'recorded_without_nudge'};
    }catch(e){if(e instanceof OpenRigError&&e.status===409){this.clearHold(key);throw new OpenRigError('queue_item_changed',409);}throw new OpenRigError('queue_handoff_uncertain',409);}
  }
  async handoffRequest(rigId:string,qitemId:string):Promise<OpenRigQueueHandoffResult>{
    inputText(rigId);inputText(qitemId);
    if(!this.hasHold('handoff:'+qitemId))throw new OpenRigError('not_found',404);
    const {item:closed}=await this.queueDetail(rigId,qitemId);
    if(closed.destinationSession!=='human@kernel'||closed.state!=='handed-off'||typeof closed.handedOffTo!=='string')throw new OpenRigError('queue_handoff_uncertain',409);
    const candidates=(await this.scopedQueue(records(await this.request('/api/rigs/'+encodeURIComponent(rigId)+'/nodes')))).items.filter(q=>q.handedOffFrom===qitemId&&q.sourceSession==='human@kernel'&&q.destinationSession===closed.handedOffTo);
    if(candidates.length!==1)throw new OpenRigError('queue_handoff_uncertain',409);
    return {closed,created:queueProjection(candidates[0]!),actor:'human@kernel',provenance:'claimed:v1',delivery:'recorded_without_nudge'};
  }
  async queueRequest(rigId:string,requestId:string):Promise<OpenRigQueueDetail>{
    inputText(requestId,128);const qitemId='tw-'+createHash('sha256').update(requestId).digest('hex').slice(0,32);
    if(!this.hasHold('queue:'+qitemId))throw new OpenRigError('not_found',404);
    const detail=await this.queueDetail(rigId,qitemId);if(detail.item.sourceSession!=='human@kernel')throw new OpenRigError('request_conflict',409);return detail;
  }
  async queueDetail(rigId:string,qitemId:string):Promise<OpenRigQueueDetail>{
    inputText(rigId);inputText(qitemId);
    const item=object(await this.request('/api/queue/'+encodeURIComponent(qitemId)));
    const nodes=records(await this.request('/api/rigs/'+encodeURIComponent(rigId)+'/nodes'));
    const sessions=new Set(nodes.map(n=>n.canonicalSessionName).filter(v=>typeof v==='string'));
    if(!(typeof item.sourceSession==='string'&&sessions.has(item.sourceSession))&&!(typeof item.destinationSession==='string'&&sessions.has(item.destinationSession)))throw new OpenRigError('queue_wrong_team',404);
    const transitions=records(await this.request('/api/queue/'+encodeURIComponent(qitemId)+'/transitions'));
    return {item:{...queueProjection(item),...project(item,['identityProvenance'])},transitions:transitions.map(t=>project(t,['transitionId','qitemId','state','actorSession','identityProvenance','ts','transitionNote','closureReason','closureTarget'])),checkedAt:new Date().toISOString()};
  }
  async createQueue(input:OpenRigQueueCreate):Promise<OpenRigQueueResult>{
    inputText(input.rigId);inputText(input.destinationSession);inputText(input.summary,256);inputText(input.requestId,128);
    if(typeof input.body!=='string'||!input.body.trim()||input.body.length>2048||input.body.includes('\0'))throw new OpenRigError('invalid_request',400);
    const nodes=records(await this.request('/api/rigs/'+encodeURIComponent(input.rigId)+'/nodes'));
    if(!nodes.some(n=>n.canonicalSessionName===input.destinationSession))throw new OpenRigError('queue_destination_changed',409);
    const qitemId='tw-'+createHash('sha256').update(input.requestId).digest('hex').slice(0,32),key='queue:'+qitemId;
    const result=(item:OpenRigRecord):OpenRigQueueResult=>({item:queueProjection(item),actor:'human@kernel',provenance:'claimed:v1',delivery:!this.hasHold('queue-notify:'+qitemId)?'recorded_without_nudge':typeof item.lastNudgeResult==='string'&&item.lastNudgeResult.startsWith('failed:')?'notification_failed':'notification_requested'});
    const matches=(item:OpenRigRecord)=>item.sourceSession==='human@kernel'&&item.destinationSession===input.destinationSession&&item.body===input.body&&item.summary===input.summary;
    if(this.hasHold(key)){
      let existing:OpenRigRecord;try{existing=object(await this.request('/api/queue/'+encodeURIComponent(qitemId)));}catch{throw new OpenRigError('queue_create_uncertain',409);}
      if(!matches(existing))throw new OpenRigError('request_conflict',409);return result(existing);
    }
    this.placeHold(key);
    if(input.notify===true)this.placeHold('queue-notify:'+qitemId);
    try{
      const item=object(await this.request('/api/queue/create',{qitemId,sourceSession:'human@kernel',destinationSession:input.destinationSession,summary:input.summary,body:input.body,nudge:input.notify===true}));
      if(!matches(item)||item.qitemId!==qitemId)throw new Error('unexpected item');return result(item);
    }catch{throw new OpenRigError('queue_create_uncertain',409);}
  }
  async preview(view:string):Promise<OpenRigPreview>{
    inputText(view);const r=object(await this.request(`/api/terminal/preview?provider=herdr&view=${encodeURIComponent(view)}`));
    if(typeof r.planId!=='string')throw new OpenRigError('preview_unavailable',409);
    const c=object(r.composed),s=object(r.status);const opened=records(c.opened).map(p=>({seat:str(p.seat),label:str(p.label),readOnly:p.readOnly===true,...(typeof p.runtime==='string'?{runtime:p.runtime}:{})}));
    if(this.previews.size>=256)this.previews.clear();this.previews.set(view,{plan:r.planId,at:Date.now(),used:false});
    return {provider:'herdr',view,planId:r.planId,opened,absent:absent(c.absent),degraded:absent(c.degraded),pages:Array.isArray(c.pages)?c.pages.length:0,available:s.available===true};
  }
  async open(view:string,expectedPlan:string,requestId:string):Promise<OpenRigOpenResult>{
    inputText(view);inputText(expectedPlan);inputText(requestId,128);const fingerprint=JSON.stringify([view,expectedPlan]);
    const prior=this.requests.get(requestId);if(prior){if(prior.fingerprint!==fingerprint)throw new OpenRigError('request_conflict',409);return prior.result;}
    if(this.hasHold(view))throw new OpenRigError('openrig_open_uncertain',409);
    const preview=this.previews.get(view);if(!preview||preview.plan!==expectedPlan||Date.now()-preview.at>300000||preview.used)throw new OpenRigError('preview_changed',409);
    if(this.requests.size>=1024)throw new OpenRigError('request_capacity',503);
    preview.used=true;
    const result=this.performOpen(view,expectedPlan);this.requests.set(requestId,{fingerprint,result});return result;
  }
  private async performOpen(view:string,expectedPlan:string):Promise<OpenRigOpenResult>{
    this.placeHold(view);
    try {
      const r=object(await this.request('/api/terminal/open',{provider:'herdr',view,expectedPlan}));
      const opened=strings(r.opened),a=absent(r.absent),d=absent(r.degraded);
      if(typeof r.ok!=='boolean')throw new OpenRigError('invalid_upstream_response',502);
      const ok=r.ok;
      const result:OpenRigOpenResult={ok,opened,absent:a,degraded:d,pages:count(r.pages),...(typeof r.code==='string'?{code:r.code}:{}),outcome:!ok?'failed':!opened.length||a.length||d.length?'partial':'complete'};
      result.terminalIdentities=await verifyTerminalIdentities(r.terminalIdentities,this.nativeSnapshot);
      this.clearHold(view);
      return result;
    } catch(error) {
      if(error instanceof OpenRigError && ['preview_changed','not_found'].includes(error.code)) {
        this.clearHold(view);throw error;
      }
      throw new OpenRigError('openrig_open_uncertain',409);
    }
  }
}
