import {createHash,randomUUID} from 'node:crypto';
import {realpathSync,statSync,readFileSync,readdirSync,mkdirSync,cpSync,writeFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import type {OpenRigReadiness,OpenRigStarterPlan,OpenRigStarterLaunch} from '../../shared/openrig.ts';
import {OpenRigError,inputText} from './runtime.ts';
export interface StarterOptions {packageDir?:string;allowedProjectRoots?:string[];providerStateDir?:string;probe?: (command:'claude'|'codex',args:string[],env:NodeJS.ProcessEnv)=>Promise<{code:number;output:string}>}
type Requester=(path:string,body?:unknown,timeoutMs?:number)=>Promise<unknown>;
interface PlanRecord {public:OpenRigStarterPlan;sourceRef:string;sourceHash:string;packageHash:string;used:boolean}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const record=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new OpenRigError('invalid_upstream_response',502);return v as Record<string,unknown>;};
function treeHash(path:string):string{
  const entries=readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));
  return hash(entries.map(e=>{if(e.isSymbolicLink())throw new OpenRigError('starter_source_changed',409);return e.name+':'+(e.isDirectory()?treeHash(join(path,e.name)):hash(readFileSync(join(path,e.name),'utf8')));}).join('\n'));
}
const probe:NonNullable<StarterOptions['probe']>=(command,args,env)=>new Promise(resolveResult=>{
  execFile(command,args,{env,timeout:15000,maxBuffer:512*1024},(error,stdout)=>resolveResult({code:error?1:0,output:stdout}));
});
export class OpenRigStarter {
  private launches=new Map<string,{planId:string;result:Promise<OpenRigStarterLaunch>}>();
  private options:StarterOptions;private plans=new Map<string,PlanRecord>();private readonly packageDir:string;private readonly providerState:string;
  constructor(private stateDir:string|undefined,private request:Requester,private hold:{has:(key:string)=>boolean;place:(key:string)=>void;clear:(key:string)=>void},options:StarterOptions={}){
    this.options=options;this.packageDir=options.packageDir??join(homedir(),'.local/share/termweave-openrig/node_modules/@openrig/cli');this.providerState=options.providerStateDir??join(homedir(),'.local/state/termweave-openrig');
  }
  async readiness():Promise<OpenRigReadiness>{
    const env={...process.env,CODEX_HOME:join(this.providerState,'codex'),CLAUDE_CONFIG_DIR:join(this.providerState,'claude'),OPENRIG_HOME:join(this.providerState,'data')};
    // Login-status commands only. Outputs are never returned, persisted, or logged.
    const run=this.options.probe??probe;
    const providers=await Promise.all((['claude','codex'] as const).map(async command=>{
      const [auth,help]=await Promise.all([run(command,command==='claude'?['auth','status']:['login','status'],env),run(command,['--help'],env)]);
      const permissionsSupported=help.code===0&&(command==='claude'?help.output.includes('acceptEdits')&&help.output.includes('--permission-mode'):help.output.includes('workspace-write')&&help.output.includes('--sandbox'));
      return {runtime:command==='claude'?'claude-code' as const:'codex' as const,authenticated:auth.code===0,permissionsSupported,reason:auth.code!==0?'authentication_required':!permissionsSupported?'permission_mode_unsupported':'ready'};
    }));
    const blockers=providers.filter(p=>p.reason!=='ready').map(p=>p.runtime+':'+p.reason);
    return {checkedAt:new Date().toISOString(),ready:!blockers.length,providers,blockers};
  }
  private project(value:string):string{
    inputText(value,2048);let path:string;try{path=realpathSync(value);if(!statSync(path).isDirectory())throw new Error();}catch{throw new OpenRigError('invalid_project_path',400);}
    const roots=this.options.allowedProjectRoots??[join(homedir(),'projects'),join(homedir(),'Documents')];
    const allowed=roots.some(root=>{try{const delta=relative(realpathSync(root),path);return delta!==''&&!delta.startsWith('..')&&!isAbsolute(delta);}catch{return false;}});
    if(!allowed)throw new OpenRigError('project_path_not_allowed',403);return path;
  }
  private packageHash():string{
    try{
      const metadata=JSON.parse(readFileSync(join(this.packageDir,'package.json'),'utf8'));
      if(metadata.name!=='@openrig/cli'||metadata.version!=='0.6.7')throw new Error();
      const posture=readFileSync(join(this.packageDir,'daemon/dist/adapters/yolo-mode.js'),'utf8');
      if(!posture.includes('"--permission-mode acceptEdits"')||!posture.includes('" -s workspace-write"'))throw new Error();
      return hash(treeHash(join(this.packageDir,'daemon/specs'))+posture);
    }catch{throw new OpenRigError('starter_package_unverified',409);}
  }
  async plan(projectPath:string):Promise<OpenRigStarterPlan>{
    if(!this.stateDir)throw new OpenRigError('starter_storage_required');
    const path=this.project(projectPath),packageHash=this.packageHash(),teamName='termweave-'+hash(path).slice(0,12),planId=randomUUID();
    const sourceDir=join(this.packageDir,'daemon/specs/rigs/launch/starter');
    const planDir=join(this.stateDir,'openrig-starter-plans',planId);mkdirSync(planDir,{recursive:true,mode:0o700});cpSync(sourceDir,planDir,{recursive:true,force:false,errorOnExist:false});
    const sourceRef=join(planDir,'rig.yaml');let spec=readFileSync(sourceRef,'utf8');
    if(!spec.includes('name: starter')||(spec.match(/profile: default/g)||[]).length!==2)throw new OpenRigError('starter_source_changed',409);
    spec=spec.replace('name: starter','name: '+teamName).replaceAll('profile: default','profile: default\n        permission_policy: none').replace(/local:([^"\n]+)/g,(_match,ref:string)=>'local:'+relative(planDir,resolve(sourceDir,ref)));
    writeFileSync(sourceRef,spec,{mode:0o600});
    const upstream=record(await this.request('/api/up',{sourceRef,plan:true,autoApprove:false,nonInterruptive:false,cwdOverride:path}));
    if(upstream.status!=='planned'||!Array.isArray(upstream.stages))throw new OpenRigError('starter_plan_failed',409);
    const readiness=await this.readiness();
    const publicPlan:OpenRigStarterPlan={planId,expiresAt:new Date(Date.now()+300000).toISOString(),input:{projectPath:path,source:'official-starter',teamName},status:'planned',stages:upstream.stages.map(s=>{const v=record(s);return {stage:inputText(v.stage),status:inputText(v.status)};}),warnings:Array.isArray(upstream.warnings)?upstream.warnings.filter((w):w is string=>typeof w==='string'):[],permissions:[{seat:'dev.build',posture:'floor',mode:'acceptEdits',verified:readiness.providers[0]?.permissionsSupported===true},{seat:'dev.review',posture:'floor',mode:'workspace-write',verified:readiness.providers[1]?.permissionsSupported===true}],readiness};
    if(this.plans.size>=128)this.plans.clear();this.plans.set(planId,{public:publicPlan,sourceRef,sourceHash:treeHash(planDir),packageHash,used:false});return publicPlan;
  }
  async launch(planId:string,requestId:string):Promise<OpenRigStarterLaunch>{
    inputText(planId,128);inputText(requestId,128);
    const prior=this.launches.get(requestId);if(prior){if(prior.planId!==planId)throw new OpenRigError('request_conflict',409);return prior.result;}
    if(this.launches.size>=1024)throw new OpenRigError('request_capacity');
    const result=this.performLaunch(planId,requestId);this.launches.set(requestId,{planId,result});return result;
  }
  private async performLaunch(planId:string,requestId:string):Promise<OpenRigStarterLaunch>{
    inputText(planId,128);inputText(requestId,128);const plan=this.plans.get(planId);
    if(!plan||plan.used||Date.now()>Date.parse(plan.public.expiresAt))throw new OpenRigError('starter_plan_expired',409);
    const p=plan.public.input;if(this.project(p.projectPath)!==p.projectPath||this.packageHash()!==plan.packageHash||treeHash(dirname(plan.sourceRef))!==plan.sourceHash)throw new OpenRigError('starter_source_changed',409);
    const key='starter:'+p.teamName;if(this.hold.has(key))throw new OpenRigError('starter_launch_uncertain',409);
    if(!(await this.readiness()).ready)throw new OpenRigError('starter_not_ready',409);
    const ps=await this.request('/api/ps');if(!Array.isArray(ps))throw new OpenRigError('invalid_upstream_response',502);
    if(ps.some(v=>{const r=record(v);return r.name===p.teamName||r.rigName===p.teamName;}))throw new OpenRigError('starter_team_exists',409);
    // Recheck after async readiness: a second click may have reached this point concurrently.
    if(plan.used)throw new OpenRigError('starter_plan_expired',409);
    const requestKey='starter-request:'+hash(requestId);if(this.hold.has(requestKey))throw new OpenRigError('starter_launch_uncertain',409);
    plan.used=true;this.hold.place(requestKey);this.hold.place(key);
    try{
      const r=record(await this.request('/api/up',{sourceRef:plan.sourceRef,plan:false,autoApprove:false,nonInterruptive:false,cwdOverride:p.projectPath},120000));
      if(!['completed','partial','failed'].includes(String(r.status)))throw new Error('unknown result');
      const result:OpenRigStarterLaunch={status:String(r.status),...(typeof r.rigId==='string'?{rigId:r.rigId}:{}),outcome:r.status==='completed'?'started':r.status==='partial'?'attention':'failed',checkedAt:new Date().toISOString()};
      // Keep one persistent launch receipt/hold even after success. Same project must not silently replace its team.
      return result;
    }catch{throw new OpenRigError('starter_launch_uncertain',409);}
  }
}
