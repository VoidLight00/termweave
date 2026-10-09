import {createHash,randomUUID} from 'node:crypto';
import type {OpenRigRecoveryPlan,OpenRigRestoreStarted,OpenRigRestoreStatus,OpenRigRecord} from '../../shared/openrig.ts';
import {OpenRigError,inputText} from './runtime.ts';
type Requester=(path:string,body?:unknown,timeout?:number)=>Promise<unknown>;
const object=(v:unknown):OpenRigRecord=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new OpenRigError('invalid_upstream_response',502);return v as OpenRigRecord;};
const rows=(v:unknown):OpenRigRecord[]=>{if(!Array.isArray(v))throw new OpenRigError('invalid_upstream_response',502);return v.map(object);};
const fields=(r:OpenRigRecord,keys:string[])=>Object.fromEntries(keys.filter(k=>['string','number','boolean'].includes(typeof r[k])||r[k]===null).map(k=>[k,r[k]]));
interface StoredPlan {value:OpenRigRecoveryPlan;fingerprint:string;used:boolean}
export class OpenRigRecovery {
 private plans=new Map<string,StoredPlan>();
 constructor(private request:Requester,private hold:{has:(s:string)=>boolean;place:(s:string)=>void;clear:(s:string)=>void;finish:(marker:string,key:string)=>void}){}
 private async inspect(rigId:string){
  const base='/api/rigs/'+encodeURIComponent(rigId);
  const [raw,nativeNodes]=await Promise.all([this.request(base+'/launch-plan',{}),this.request(base+'/nodes')]);
  const plan=object(raw),nodes=rows(plan.nodes),inventory=rows(nativeNodes);
  if(plan.rigId!==rigId||plan.mutated!==false||plan.mode!=='restore')throw new OpenRigError('invalid_upstream_response',502);
  const snapshot=plan.snapshot===null?null:object(plan.snapshot);
  const identity=nodes.map(n=>fields(n,['logicalId','occupantSessionId','intendedAction','freshRequired','resumeTokenState']));
  const roster=inventory.map(n=>fields(n,['nodeId','logicalId','canonicalSessionName','sessionStatus','lifecycleState']));
  const fingerprint=createHash('sha256').update(JSON.stringify({snapshot:snapshot?.id,identity,roster})).digest('hex');
  const blockers:string[]=[];
  if(!snapshot)blockers.push('snapshot_required');
  if(inventory.some(n=>n.sessionStatus==='running'))blockers.push('team_must_be_stopped');
  if(!nodes.length)blockers.push('no_seats');
  if(nodes.some(n=>n.freshRequired===true||n.intendedAction!=='resume-original'))blockers.push('explicit_fresh_decision_required');
  return {fingerprint,nodes,snapshot,blockers};
 }
 async plan(rigId:string):Promise<OpenRigRecoveryPlan>{
  inputText(rigId);const observed=await this.inspect(rigId);const planId=randomUUID();
  const snapshot=observed.snapshot?{id:inputText(observed.snapshot.id),kind:inputText(observed.snapshot.kind),createdAt:inputText(observed.snapshot.createdAt)}:null;
  const value:OpenRigRecoveryPlan={planId,rigId,expiresAt:new Date(Date.now()+300000).toISOString(),snapshot,nodes:observed.nodes.map(n=>fields(n,['logicalId','occupantSessionId','intendedAction','freshRequired','resumeTokenState','lastVerified','hasHistory','runtimePrompt'])),canRestore:!observed.blockers.length,blockers:observed.blockers};
  if(this.plans.size>=128)this.plans.clear();this.plans.set(planId,{value,fingerprint:observed.fingerprint,used:false});return value;
 }
 private async checked(planId:string){inputText(planId,128);const p=this.plans.get(planId);if(!p||p.used||Date.now()>Date.parse(p.value.expiresAt))throw new OpenRigError('recovery_plan_expired',409);const current=await this.inspect(p.value.rigId);if(current.fingerprint!==p.fingerprint)throw new OpenRigError('recovery_plan_changed',409);return p;}
 async snapshot(planId:string,requestId:string):Promise<OpenRigRecord>{
  inputText(requestId,128);const p=await this.checked(planId),key='snapshot:'+p.value.rigId+':'+requestId;
  if(this.hold.has(key))throw new OpenRigError('snapshot_create_uncertain',409);
  if(p.used)throw new OpenRigError('recovery_plan_expired',409);p.used=true;this.hold.place(key);
  try{const s=object(await this.request('/api/rigs/'+encodeURIComponent(p.value.rigId)+'/snapshots',{kind:'manual'}));if(s.rigId!==p.value.rigId||typeof s.id!=='string')throw new Error();return fields(s,['id','rigId','kind','status','createdAt']);}catch{throw new OpenRigError('snapshot_create_uncertain',409);}
 }
 async restore(planId:string,requestId:string):Promise<OpenRigRestoreStarted>{
  inputText(requestId,128);const p=await this.checked(planId);if(!p.value.canRestore||!p.value.snapshot)throw new OpenRigError('restore_preconditions_failed',409);
  const key='restore:'+p.value.rigId;if(this.hold.has(key))throw new OpenRigError('restore_outcome_uncertain',409);
  if(p.used)throw new OpenRigError('recovery_plan_expired',409);p.used=true;this.hold.place(key);
  try{const r=object(await this.request('/api/rigs/'+encodeURIComponent(p.value.rigId)+'/restore/'+encodeURIComponent(p.value.snapshot.id),{},120000));if(r.status!=='started'||r.ok!==true||r.rigId!==p.value.rigId||typeof r.attemptId!=='number'||!Number.isSafeInteger(r.attemptId)||r.attemptId<1)throw new Error();this.hold.place('restore-attempt:'+p.value.rigId+':'+r.attemptId);return {status:'started',rigId:p.value.rigId,attemptId:r.attemptId};}catch{throw new OpenRigError('restore_outcome_uncertain',409);}
 }
 async status(rigId:string,attemptId:number):Promise<OpenRigRestoreStatus>{
  inputText(rigId);if(!Number.isSafeInteger(attemptId)||attemptId<1)throw new OpenRigError('invalid_request',400);
  let raw:unknown;try{raw=await this.request('/api/rigs/'+encodeURIComponent(rigId)+'/restore/status/'+attemptId);}catch(e){if(e instanceof OpenRigError&&e.status===409)return {status:'running',rigId,attemptId,nodes:[]};throw e;}
  const r=object(raw);if(r.ok!==true||r.rigId!==rigId||r.attemptId!==attemptId)throw new OpenRigError('invalid_upstream_response',502);
  const result:OpenRigRestoreStatus={status:'completed',rigId,attemptId,nodes:rows(r.currentNodes).map(n=>fields(n,['nodeId','logicalId','status'])),...(typeof r.currentIntendedSetVerdict==='string'?{verdict:r.currentIntendedSetVerdict}:{})};
  // Only this bridge's still-unconsumed attempt marker may release the team's hold.
  this.hold.finish('restore-attempt:'+rigId+':'+attemptId,'restore:'+rigId);
  return result;
 }
}
