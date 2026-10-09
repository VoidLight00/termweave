import {mkdtempSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,test,expect} from 'bun:test';
import {OpenRigRuntime} from './runtime.ts';
import {handleOpenRigRequest} from './api.ts';
const preview={planId:'plan1',composed:{opened:[{seat:'dev@team',label:'Dev',readOnly:false,paneCommand:'secret shell command'}],absent:[],degraded:[],pages:[[]]},status:{available:true,launch:{socketPath:'secret'}}};
function harness(open:unknown={ok:true,opened:['dev@team'],absent:[],degraded:[],pages:1}){
 let calls=0;
 const runtime=new OpenRigRuntime({fetch:async(url,init)=>{if(url.includes('/preview'))return Response.json(preview);if(url.endsWith('/open')){calls++;expect(init?.redirect).toBe('error');return Response.json(open);}return Response.json([]);}});
 return {runtime,calls:()=>calls};
}
const post=(data:unknown)=>new Request('http://localhost/api/openrig/open',{method:'POST',body:JSON.stringify(data)});
const input={view:'team',expectedPlan:'plan1',requestId:'r1'};
describe('OpenRig guarded bridge',()=>{
 test('watch cannot open even with valid preview',async()=>{const h=harness();await h.runtime.preview('team');expect((await handleOpenRigRequest(post(input),h.runtime,true)).status).toBe(403);expect(h.calls()).toBe(0);});
 test('stale and missing preview do not contact upstream',async()=>{const h=harness();expect((await handleOpenRigRequest(post(input),h.runtime,false)).status).toBe(409);await h.runtime.preview('team');expect((await handleOpenRigRequest(post({...input,expectedPlan:'old'}),h.runtime,false)).status).toBe(409);expect(h.calls()).toBe(0);});
 test('parallel retries are deduplicated; mismatched request rejects',async()=>{const h=harness();await h.runtime.preview('team');const results=await Promise.all([h.runtime.open('team','plan1','r1'),h.runtime.open('team','plan1','r1')]);expect(h.calls()).toBe(1);expect(results[0]?.outcome).toBe('complete');await expect(h.runtime.open('other','plan1','r1')).rejects.toMatchObject({code:'request_conflict'});});
 test('HTTP200 partial and failure are not completion',async()=>{for(const [body,outcome] of [[{ok:true,opened:[],absent:[],degraded:[],pages:0},'partial'],[{ok:false,opened:[],absent:[],degraded:[],pages:0,code:'provider_unavailable'},'failed'],[{ok:true,opened:['a'],absent:[{seat:'b',host:null,reason:'stopped'}],degraded:[],pages:1},'partial']] as const){const h=harness(body);await h.runtime.preview('team');expect((await h.runtime.open('team','plan1','r1')).outcome).toBe(outcome);}});
 test('malformed payload and extra provider fields rejected',async()=>{const h=harness();for(const data of [null,[],{...input,provider:'cmux'}, {...input,requestId:''}])expect((await handleOpenRigRequest(post(data),h.runtime,false)).status).toBe(400);expect(h.calls()).toBe(0);});
 test('body byte limit and unknown route',async()=>{const h=harness();expect((await handleOpenRigRequest(post({view:'x'.repeat(5000)}),h.runtime,false)).status).toBe(413);expect((await handleOpenRigRequest(new Request('http://localhost/api/openrig/proxy'),h.runtime,false)).status).toBe(404);});
 test('offline and invalid optional config are isolated, sanitized',async()=>{const runtime=new OpenRigRuntime({fetch:async()=>{throw new Error('Bearer SECRET');}});const res=await handleOpenRigRequest(new Request('http://localhost/api/openrig'),runtime,false);expect(res.status).toBe(503);expect(await res.text()).not.toContain('SECRET');for(const baseUrl of ['http://example.com','http://127.0.0.1/path','http://user:' + 'secret@127.0.0.1','garbage']){const r=new OpenRigRuntime({baseUrl});await expect(r.overview()).rejects.toMatchObject({code:'openrig_invalid_config'});}}); // leakscan:allow: test fixture
 test('preview omits command and launch details',async()=>{const h=harness();const result=JSON.stringify(await h.runtime.preview('team'));expect(result).not.toContain('secret');expect(result).not.toContain('paneCommand');});
 test('malformed counts fail instead of showing zero',async()=>{const r=new OpenRigRuntime({fetch:async url=>Response.json(url.endsWith('/api/ps')?[{rigId:'id',name:'n',status:'running'}]:url.includes('/views')?{rigs:[],saved:[]}:{providers:[]})});await expect(r.overview()).rejects.toMatchObject({code:'invalid_upstream_response'});});
 test('team filters attention locally and strips private execution state',async()=>{const r=new OpenRigRuntime({fetch:async url=>Response.json(url.includes('/nodes')?[{nodeId:'n',logicalId:'dev',rigName:'named-team',canonicalSessionName:'dev@named-team',resumeToken:'SECRET',tmuxAttachCommand:'SECRET'}]:url.includes('/snapshots')?[{id:'s',data:{secret:'SECRET'}}]:[{qitemId:'q',sourceSession:'dev@named-team',state:'blocked',blockedOn:'human@kernel',body:'SECRET'},{qitemId:'u',sourceSession:'dev@named-team',state:'pending',destinationSession:'human@kernel',humanIntent:'update'}])});const result=await r.team('t');expect(result.attention.items.map(i=>i.qitemId)).toEqual(['q']);expect(JSON.stringify(result)).not.toContain('SECRET');});
 test('changed upstream preview returns conflict without error content',async()=>{let opens=0;const runtime=new OpenRigRuntime({fetch:async url=>url.includes('/preview')?Response.json(preview):(opens++,Response.json({error:'SECRET'},{status:409}))});await runtime.preview('team');await expect(runtime.open('team','plan1','r1')).rejects.toMatchObject({code:'preview_changed',status:409});await expect(runtime.open('team','plan1','r1')).rejects.toMatchObject({code:'preview_changed'});expect(opens).toBe(1);});
 test('timeout cancels upstream request',async()=>{const runtime=new OpenRigRuntime({timeoutMs:10,fetch:async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('timeout')), {once:true});})});await expect(runtime.overview()).rejects.toMatchObject({code:'openrig_unavailable'});});
 test('invalid upstream JSON and oversized response are not reflected',async()=>{for(const response of [new Response('SECRET-not-json'),new Response('x',{headers:{'content-length':'3000000'}})]){const runtime=new OpenRigRuntime({fetch:async()=>response.clone()});await expect(runtime.overview()).rejects.toMatchObject({code:'invalid_upstream_response',status:502});}});
 test('queue limit signals incomplete attention results',async()=>{const runtime=new OpenRigRuntime({fetch:async url=>Response.json(url.includes('/queue/list')?Array.from({length:101},(_,i)=>({qitemId:String(i),sourceSession:'dev@named-team',state:'pending',destinationSession:'human@kernel'})):url.includes('/nodes')?[{rigName:'named-team',canonicalSessionName:'dev@named-team'}]:[])});const result=await runtime.team('t');expect(result.queue.items).toHaveLength(100);expect(result.queue.truncated).toBe(true);expect(result.attention.truncated).toBe(true);});

 test('lost open response blocks re-preview with a new request ID',async()=>{
   let opens=0;const runtime=new OpenRigRuntime({fetch:async url=>{if(url.includes('/preview'))return Response.json(preview);opens++;throw new Error('response lost after workspace created');}});
   await runtime.preview('team');await expect(runtime.open('team','plan1','first')).rejects.toMatchObject({code:'openrig_open_uncertain'});
   await runtime.preview('team');await expect(runtime.open('team','plan1','second')).rejects.toMatchObject({code:'openrig_open_uncertain'});expect(opens).toBe(1);
 });
 test('unparseable POST result holds the view instead of enabling another open',async()=>{
   let opens=0;const runtime=new OpenRigRuntime({fetch:async url=>{if(url.includes('/preview'))return Response.json(preview);opens++;return Response.json({ok:true});}});
   await runtime.preview('team');await expect(runtime.open('team','plan1','first')).rejects.toMatchObject({code:'openrig_open_uncertain'});
   await runtime.preview('team');await expect(runtime.open('team','plan1','second')).rejects.toMatchObject({code:'openrig_open_uncertain'});expect(opens).toBe(1);
 });

 test('uncertain hold survives restart with private storage',async()=>{
   const dir=mkdtempSync(join(tmpdir(),'or-hold-'));let opens=0;
   const fetcher=async(url:string)=>{if(url.includes('/preview'))return Response.json(preview);opens++;throw new Error('lost response');};
   const first=new OpenRigRuntime({stateDir:dir,fetch:fetcher});
   try{await first.preview('team');await expect(first.open('team','plan1','first')).rejects.toMatchObject({code:'openrig_open_uncertain'});first.dispose();
     const second=new OpenRigRuntime({stateDir:dir,fetch:fetcher});try{await second.preview('team');await expect(second.open('team','plan1','second')).rejects.toMatchObject({code:'openrig_open_uncertain'});expect(opens).toBe(1);expect(statSync(join(dir,'openrig-operation-holds.sqlite')).mode&0o777).toBe(0o600);}finally{second.dispose();}
   }finally{rmSync(dir,{recursive:true,force:true});}
 });
 test('known result clears persistent hold',async()=>{
   const dir=mkdtempSync(join(tmpdir(),'or-hold-'));const fetcher=async(url:string)=>Response.json(url.includes('/preview')?preview:{ok:true,opened:['dev'],absent:[],degraded:[],pages:1});
   try{for(let i=0;i<2;i++){const r=new OpenRigRuntime({stateDir:dir,fetch:fetcher});try{await r.preview('team');expect((await r.open('team','plan1','id'+i)).outcome).toBe('complete');}finally{r.dispose();}}}finally{rmSync(dir,{recursive:true,force:true});}
 });
 test('corrupt storage blocks mutation but leaves read overview available',async()=>{
   const dir=mkdtempSync(join(tmpdir(),'or-hold-'));writeFileSync(join(dir,'openrig-operation-holds.sqlite'),'not sqlite');let opens=0;
   const r=new OpenRigRuntime({stateDir:dir,fetch:async url=>{if(url.endsWith('/open'))opens++;return Response.json(url.includes('/preview')?preview:url.endsWith('/api/ps')?[]:url.includes('/views')?{rigs:[],saved:[]}:{providers:[]});}});
   try{expect((await r.overview()).connected).toBe(true);await r.preview('team');await expect(r.open('team','plan1','id')).rejects.toMatchObject({code:'openrig_hold_storage_unavailable'});expect(opens).toBe(0);}finally{r.dispose();rmSync(dir,{recursive:true,force:true});}
 });

});
