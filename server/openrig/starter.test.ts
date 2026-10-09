import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OpenRigRuntime} from './runtime.ts';
import {handleOpenRigRequest} from './api.ts';
function fixture(ready=true,unknown=false){
 const root=mkdtempSync(join(tmpdir(),'or-starter-')),pkg=join(root,'package'),projects=join(root,'projects'),project=join(projects,'demo'),state=join(root,'state');
 mkdirSync(join(pkg,'daemon/specs/rigs/launch/starter'),{recursive:true});mkdirSync(join(pkg,'daemon/dist/adapters'),{recursive:true});mkdirSync(project,{recursive:true});
 writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'@openrig/cli',version:'0.6.7'}));
 writeFileSync(join(pkg,'daemon/dist/adapters/yolo-mode.js'),'"--permission-mode acceptEdits" " -s workspace-write"');
 writeFileSync(join(pkg,'daemon/specs/rigs/launch/starter/rig.yaml'),'name: starter\npods:\n  - id: dev\n    members:\n      - id: build\n        profile: default\n      - id: review\n        profile: default\n');
 let launches=0,planCalls=0;
 const make=()=>new OpenRigRuntime({stateDir:state,starter:{packageDir:pkg,allowedProjectRoots:[projects],providerStateDir:join(root,'provider'),probe:async(_command,args,env)=>{expect(env.CODEX_HOME).toBe(join(root,'provider/codex'));return {code:args.includes('--help')?0:ready?0:1,output:'--permission-mode acceptEdits --sandbox workspace-write'};}},fetch:async(url,init)=>{
  if(url.endsWith('/api/ps'))return Response.json([]);
  if(url.endsWith('/api/up')){const body=JSON.parse(String(init?.body));expect(body.autoApprove).toBe(false);expect(body.nonInterruptive).toBe(false);if(body.plan){planCalls++;return Response.json({status:'planned',stages:[{stage:'preflight',status:'ok'}],warnings:[]});} launches++;if(unknown)throw new Error('lost');return Response.json({status:'completed',rigId:'rig1'});}
  throw new Error('unexpected');
 }});
 return {root,project,pkg,make,counts:()=>({launches,planCalls}),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('starter plan binds input and explicit floor policy without launching',async()=>{const f=fixture(false),r=f.make();try{const plan=await r.starter.plan(f.project);expect(plan.status).toBe('planned');expect(plan.readiness.ready).toBe(false);expect(plan.permissions.every(p=>p.verified)).toBe(true);const yaml=readFileSync(join(f.root,'state/openrig-starter-plans',plan.planId,'rig.yaml'),'utf8');expect(yaml.match(/permission_policy: none/g)).toHaveLength(2);await expect(r.starter.launch(plan.planId,'req')).rejects.toMatchObject({code:'starter_not_ready'});expect(f.counts().launches).toBe(0);}finally{r.dispose();f.cleanup();}});
test('starter rejects outside allowed project before upstream calls',async()=>{const f=fixture(),r=f.make();try{await expect(r.starter.plan(f.root)).rejects.toMatchObject({code:'project_path_not_allowed'});expect(f.counts().planCalls).toBe(0);}finally{r.dispose();f.cleanup();}});
test('starter launches once with exact plan and never bypasses permissions',async()=>{const f=fixture(),r=f.make();try{const p=await r.starter.plan(f.project);expect((await r.starter.launch(p.planId,'req')).outcome).toBe('started');await expect(r.starter.launch(p.planId,'req2')).rejects.toMatchObject({code:'starter_plan_expired'});expect(f.counts().launches).toBe(1);}finally{r.dispose();f.cleanup();}});
test('starter changed spec cannot launch',async()=>{const f=fixture(),r=f.make();try{const p=await r.starter.plan(f.project);writeFileSync(join(f.root,'state/openrig-starter-plans',p.planId,'rig.yaml'),'changed');await expect(r.starter.launch(p.planId,'req')).rejects.toMatchObject({code:'starter_source_changed'});expect(f.counts().launches).toBe(0);}finally{r.dispose();f.cleanup();}});
test('starter uncertain launch survives restart and re-plan',async()=>{const f=fixture(true,true);let r=f.make();try{const p=await r.starter.plan(f.project);await expect(r.starter.launch(p.planId,'req')).rejects.toMatchObject({code:'starter_launch_uncertain'});r.dispose();r=f.make();const again=await r.starter.plan(f.project);await expect(r.starter.launch(again.planId,'new')).rejects.toMatchObject({code:'starter_launch_uncertain'});expect(f.counts().launches).toBe(1);}finally{r.dispose();f.cleanup();}});
test('watch cannot create starter plan',async()=>{const f=fixture(),r=f.make();try{const res=await handleOpenRigRequest(new Request('http://localhost/api/openrig/starter/plan',{method:'POST',body:JSON.stringify({projectPath:f.project})}),r,true);expect(res.status).toBe(403);expect(f.counts().planCalls).toBe(0);}finally{r.dispose();f.cleanup();}});
