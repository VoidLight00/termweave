import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const candidate=resolve(process.argv[2]);
const load=p=>import(pathToFileURL(candidate+'/daemon/dist/'+p).href);
const {createDb}=await load('db/connection.js'),{migrate}=await load('db/migrate.js'),{EventBus}=await load('domain/event-bus.js'),{QueueRepository}=await load('domain/queue-repository.js');
const migrations=[];for(const [file,name] of [['001_core_schema','coreSchema'],['003_events','eventsSchema'],['024_queue_items','queueItemsSchema'],['025_queue_transitions','queueTransitionsSchema'],['027_outbox_entries','outboxEntriesSchema']])migrations.push((await load('db/migrations/'+file+'.js'))[name]);
async function fixture(){const db=createDb();migrate(db,migrations);const repo=new QueueRepository(db,new EventBus(db));const item=await repo.create({sourceSession:'origin@demo',destinationSession:'owner@demo',body:'Synthetic test only',nudge:false});db.prepare('UPDATE queue_items SET destination_session=? WHERE qitem_id=?').run('human@kernel',item.qitemId);const source=repo.getById(item.qitemId);return {db,repo,source};}
let checks=0;
for(const kind of ['success','wrong-owner','stale-timestamp','race']){
 const {db,repo,source}=await fixture();
 try{
  const expectedCurrent={tsUpdated:source.tsUpdated,state:source.state,destinationSession:source.destinationSession};
  const input={qitemId:source.qitemId,fromSession:'human@kernel',toSession:'next@demo',nudge:false,identityProvenance:'claimed:v1',expectedCurrent};
  if(kind==='wrong-owner')input.fromSession='agent@demo';
  if(kind==='stale-timestamp')expectedCurrent.tsUpdated='old';
  if(kind==='race'){
   const get=repo.getById.bind(repo);let first=true;
   repo.getById=id=>{const row=get(id);if(first){first=false;db.prepare('UPDATE queue_items SET ts_updated=? WHERE qitem_id=?').run('changed-after-read',id);}return row;};
  }
  if(kind==='success'){
   const result=await repo.handoff(input);assert.equal(result.created.destinationSession,'next@demo');assert.equal(repo.getById(source.qitemId).state,'handed-off');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_items').get().n,2);checks+=3;
  }else{
   await assert.rejects(()=>repo.handoff(input),e=>e.code==='qitem_precondition_failed');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM queue_items').get().n,1);assert.equal(db.prepare('SELECT state FROM queue_items WHERE qitem_id=?').get(source.qitemId).state,'pending');checks+=3;
  }
 }finally{db.close();}
}
const {Hono}=await import(pathToFileURL(candidate+'/node_modules/hono/dist/index.js').href);
const {queueRoutes}=await load('routes/queue.js');
{
 const {db,repo,source}=await fixture();
 try{
  const nativeHandoff=repo.handoff.bind(repo);repo.handoff=input=>{assert.equal(input.fromSession,'human@kernel');assert.equal(input.identityProvenance,'claimed:v1');assert.equal(input.expectedCurrent.tsUpdated,source.tsUpdated);checks+=3;return nativeHandoff(input);};
  const app=new Hono();app.use('*',async(c,next)=>{c.set('queueRepo',repo);await next();});app.route('/api/queue',queueRoutes());
  assert.equal((await (await app.request('/api/queue/termweave-capabilities')).json()).handoffCompareAndSwap,1);checks++;
  const response=await app.request('/api/queue/'+source.qitemId+'/handoff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fromSession:'human@kernel',toSession:'next@demo',nudge:false,expectedCurrent:{destinationSession:'human@kernel',state:source.state,tsUpdated:source.tsUpdated}})});
  assert.equal(response.status,201);checks++;
 }finally{db.close();}
}
console.log(JSON.stringify({passed:5,checks,scope:'isolated patched route + repository + SQLite; no running daemon modified'}));
