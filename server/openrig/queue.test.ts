import {test,expect} from 'bun:test';
import {OpenRigRuntime} from './runtime.ts';
import {handleOpenRigRequest} from './api.ts';
const input={rigId:'rig',destinationSession:'dev@rig',summary:'Task',body:'Create the bounded artifact.',requestId:'one'};
function setup(){let calls=0;let item:Record<string,unknown>|undefined;const runtime=new OpenRigRuntime({fetch:async(url,init)=>{if(url.endsWith('/nodes'))return Response.json([{canonicalSessionName:'dev@rig',rigName:'rig'}]);if(url.endsWith('/create')){calls++;item=JSON.parse(String(init?.body));expect(item?.sourceSession).toBe('human@kernel');expect(item?.nudge).toBe(false);expect(new Headers(init?.headers).has('x-openrig-session')).toBe(false);return Response.json(item);}if(url.endsWith('/transitions'))return Response.json([{actorSession:'human@kernel',identityProvenance:'claimed:v1',secret:'SECRET'}]);return Response.json(item??{}, {status:item?200:404});}});return {runtime,calls:()=>calls};}
test('human task uses claimed actor and records without terminal nudge',async()=>{const s=setup();const r=await s.runtime.createQueue(input);expect(r.actor).toBe('human@kernel');expect(r.provenance).toBe('claimed:v1');expect(r.delivery).toBe('recorded_without_nudge');await s.runtime.createQueue(input);expect(s.calls()).toBe(1);await expect(s.runtime.createQueue({...input,summary:'Changed'})).rejects.toMatchObject({code:'request_conflict'});});
test('queue target must be a real current team seat',async()=>{const s=setup();await expect(s.runtime.createQueue({...input,destinationSession:'fake@other'})).rejects.toMatchObject({code:'queue_destination_changed'});expect(s.calls()).toBe(0);});
test('queue details are scoped to team and redact transition fields',async()=>{const s=setup();const created=await s.runtime.createQueue(input);const detail=await s.runtime.queueDetail('rig',String(created.item.qitemId));expect(detail.transitions[0]?.identityProvenance).toBe('claimed:v1');expect(JSON.stringify(detail)).not.toContain('SECRET');});
test('queue API rejects watch writes and agent impersonation fields',async()=>{const s=setup();const req=(b:unknown)=>new Request('http://localhost/api/openrig/queue/create',{method:'POST',body:JSON.stringify(b)});expect((await handleOpenRigRequest(req(input),s.runtime,true)).status).toBe(403);expect((await handleOpenRigRequest(req({...input,sourceSession:'dev@rig'}),s.runtime,false)).status).toBe(400);expect(s.calls()).toBe(0);});
test('human handoff requires candidate capability and current human ownership',async()=>{
 let posts=0;let capable=false;let owner='human@kernel';let expected='now';
 const runtime=new OpenRigRuntime({fetch:async(url,init)=>{
  if(url.endsWith('/termweave-capabilities'))return Response.json({handoffCompareAndSwap:capable?1:0});
  if(url.endsWith('/nodes'))return Response.json([{canonicalSessionName:'dev@rig',rigName:'rig'}]);
  if(url.endsWith('/transitions'))return Response.json([]);
  if(url.endsWith('/handoff')){posts++;const body=JSON.parse(String(init?.body));expect(body.expectedCurrent).toEqual({destinationSession:'human@kernel',state:'pending',tsUpdated:'now'});expect(body.nudge).toBe(false);return Response.json({closed:{qitemId:'q',state:'handed-off'},created:{qitemId:'new',sourceSession:'human@kernel',destinationSession:'dev@rig'}});}
  return Response.json({qitemId:'q',sourceSession:'dev@rig',destinationSession:owner,state:'pending',tsUpdated:expected});
 }});
 const task={rigId:'rig',qitemId:'q',toSession:'dev@rig',expectedState:'pending',expectedUpdatedAt:'now',requestId:'h1',summary:'Handoff'};
 await expect(runtime.handoffQueue(task)).rejects.toMatchObject({code:'handoff_guard_unavailable'});capable=true;owner='dev@rig';await expect(runtime.handoffQueue(task)).rejects.toMatchObject({code:'human_task_required'});owner='human@kernel';expected='later';await expect(runtime.handoffQueue(task)).rejects.toMatchObject({code:'queue_item_changed'});expected='now';expect((await runtime.handoffQueue(task)).created.qitemId).toBe('new');await expect(runtime.handoffQueue(task)).rejects.toMatchObject({code:'queue_handoff_uncertain'});expect(posts).toBe(1);
});
test('lost handoff response reconciles only a linked successor and preserves unknown lock',async()=>{
 let committed=false;
 const runtime=new OpenRigRuntime({fetch:async(url,init)=>{
  if(url.endsWith('/termweave-capabilities'))return Response.json({handoffCompareAndSwap:1});
  if(url.endsWith('/nodes'))return Response.json([{canonicalSessionName:'dev@rig',rigName:'rig'}]);
  if(url.endsWith('/transitions'))return Response.json([]);
  if(url.includes('/queue/list'))return Response.json(committed?[{qitemId:'successor',handedOffFrom:'q',sourceSession:'human@kernel',destinationSession:'dev@rig'}]:[]);
  if(init?.method==='POST'){committed=true;throw new Error('lost response');}
  return Response.json({qitemId:'q',sourceSession:'dev@rig',destinationSession:'human@kernel',state:committed?'handed-off':'pending',tsUpdated:'now',handedOffTo:committed?'dev@rig':null});
 }});
 await expect(runtime.handoffRequest('rig','q')).rejects.toMatchObject({code:'not_found'});
 await expect(runtime.handoffQueue({rigId:'rig',qitemId:'q',toSession:'dev@rig',expectedState:'pending',expectedUpdatedAt:'now',requestId:'h',summary:'Next'})).rejects.toMatchObject({code:'queue_handoff_uncertain'});
 const response=await handleOpenRigRequest(new Request('http://localhost/api/openrig/teams/rig/handoff-request/q'),runtime,true);
 expect(response.status).toBe(200);expect((await response.json()).created.qitemId).toBe('successor');
});
test('explicit notification uses only official queue nudge and never claims agent receipt',async()=>{
 let sent=0;
 const runtime=new OpenRigRuntime({fetch:async(url,init)=>{
  if(url.endsWith('/nodes'))return Response.json([{canonicalSessionName:'dev@rig',rigName:'rig'}]);
  const body=JSON.parse(String(init?.body));sent++;expect(body.nudge).toBe(true);expect(body.destinationSession).toBe('dev@rig');return Response.json({...body,lastNudgeResult:'failed:private path details'});
 }});
 const result=await runtime.createQueue({...input,notify:true});expect(result.delivery).toBe('notification_failed');expect(JSON.stringify(result)).not.toContain('private path');expect(sent).toBe(1);
});
test('queue envelope accepts the full Korean field limits and rejects character and byte overflow',async()=>{
 const s=setup();const full={...input,body:'한'.repeat(2048),summary:'글'.repeat(256)};
 const request=(text:string)=>new Request('http://localhost/api/openrig/queue/create',{method:'POST',body:text});
 const native=JSON.stringify(full);expect(new TextEncoder().encode(native).length).toBeGreaterThan(4096);
 expect((await handleOpenRigRequest(request(native),s.runtime,false)).status).toBe(200);
 const escaped=JSON.stringify({...full,requestId:'escaped'}).replace(/[한글]/g,c=>'\\u'+c.charCodeAt(0).toString(16));
 expect(escaped.length).toBeGreaterThan(12*1024);
 expect((await handleOpenRigRequest(request(escaped),s.runtime,false)).status).toBe(200);
 expect((await handleOpenRigRequest(request(JSON.stringify({...full,body:'한'.repeat(2049)})),s.runtime,false)).status).toBe(400);
 expect((await handleOpenRigRequest(request(JSON.stringify({...full,summary:'글'.repeat(257)})),s.runtime,false)).status).toBe(400);
 expect((await handleOpenRigRequest(request(' '.repeat(24*1024)+native),s.runtime,false)).status).toBe(413);
 expect(s.calls()).toBe(2);
});
test('team queue translates UUID to official rig name and excludes unrelated seats',async()=>{
 const calls:string[]=[];const r=new OpenRigRuntime({fetch:async url=>{calls.push(url);return Response.json(url.endsWith('/nodes')?[{rigName:'actual-name',canonicalSessionName:'dev@actual-name'}]:url.endsWith('/snapshots')?[]:[{qitemId:'mine',destinationSession:'dev@actual-name'},{qitemId:'other',destinationSession:'dev@other'}]);}});
 expect((await r.team('uuid-not-name')).queue.items.map(q=>q.qitemId)).toEqual(['mine']);
 expect(calls.some(url=>url.includes('/queue/list?rig=actual-name&'))).toBe(true);
 expect(calls.some(url=>url.includes('/queue/list?rig=uuid-not-name'))).toBe(false);
});
