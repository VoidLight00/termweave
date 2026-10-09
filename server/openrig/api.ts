import {OpenRigError,OpenRigRuntime,boundedJson,inputText} from './runtime.ts';
export async function handleOpenRigRequest(request:Request,runtime:OpenRigRuntime,readOnly:boolean):Promise<Response>{
  const url=new URL(request.url),path=url.pathname;
  const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
  try{
    if(request.method==='GET'){
      if(path==='/api/openrig/capabilities')return json(await runtime.capabilities());
      if(path==='/api/openrig/starter/readiness')return json(await runtime.starter.readiness());
      if(path==='/api/openrig')return json(await runtime.overview());
      const restoreStatus=path.match(/^\/api\/openrig\/teams\/([^/]+)\/restore\/([0-9]+)$/);
      if(restoreStatus)return json(await runtime.recovery.status(inputText(decodeURIComponent(restoreStatus[1]!)),Number(restoreStatus[2])));
      const handoffRequest=path.match(/^\/api\/openrig\/teams\/([^/]+)\/handoff-request\/([^/]+)$/);
      if(handoffRequest)return json(await runtime.handoffRequest(inputText(decodeURIComponent(handoffRequest[1]!)),inputText(decodeURIComponent(handoffRequest[2]!))));
      const queueRequest=path.match(/^\/api\/openrig\/teams\/([^/]+)\/queue-request\/([^/]+)$/);
      if(queueRequest)return json(await runtime.queueRequest(inputText(decodeURIComponent(queueRequest[1]!)),inputText(decodeURIComponent(queueRequest[2]!))));
      const queue=path.match(/^\/api\/openrig\/teams\/([^/]+)\/queue\/([^/]+)$/);
      if(queue)return json(await runtime.queueDetail(inputText(decodeURIComponent(queue[1]!)),inputText(decodeURIComponent(queue[2]!))));
      const team=path.match(/^\/api\/openrig\/teams\/([^/]+)$/);
      if(team)return json(await runtime.team(inputText(decodeURIComponent(team[1]!))));
      if(path==='/api/openrig/preview')return json(await runtime.preview(inputText(url.searchParams.get('view'))));
      return json({error:{code:'not_found'}},404);
    }
    if(!['/api/openrig/open','/api/openrig/starter/plan','/api/openrig/starter/launch','/api/openrig/queue/create','/api/openrig/queue/handoff','/api/openrig/recovery/plan','/api/openrig/recovery/snapshot','/api/openrig/recovery/restore'].includes(path))return json({error:{code:'not_found'}},404);
    if(readOnly)return json({error:{code:'read_only'}},403);
    if(request.method!=='POST')return json({error:{code:'method_not_allowed'}},405);
    // JSON may encode each UTF-16 unit as six bytes (\\uXXXX). Keep a bounded
    // envelope large enough for every allowed field, including Korean text.
    const envelopeLimit=path==='/api/openrig/queue/create'?24*1024
      :path==='/api/openrig/starter/plan'?16*1024
      :path==='/api/openrig/queue/handoff'?12*1024:4096;
    const value=await boundedJson(request,envelopeLimit);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new OpenRigError('invalid_request',400);
    const b=value as Record<string,unknown>;
    if(path==='/api/openrig/queue/handoff'){
      if(Object.keys(b).some(k=>!['rigId','qitemId','toSession','expectedState','expectedUpdatedAt','requestId','summary'].includes(k)))throw new OpenRigError('invalid_request',400);
      return json(await runtime.handoffQueue({rigId:inputText(b.rigId),qitemId:inputText(b.qitemId),toSession:inputText(b.toSession),expectedState:inputText(b.expectedState),expectedUpdatedAt:inputText(b.expectedUpdatedAt),requestId:inputText(b.requestId,128),summary:inputText(b.summary)}));
    }

    if(path==='/api/openrig/recovery/plan'){
      if(Object.keys(b).some(k=>k!=='rigId'))throw new OpenRigError('invalid_request',400);
      return json(await runtime.recovery.plan(inputText(b.rigId)));
    }
    if(path==='/api/openrig/recovery/snapshot'||path==='/api/openrig/recovery/restore'){
      if(Object.keys(b).some(k=>!['planId','requestId'].includes(k)))throw new OpenRigError('invalid_request',400);
      return json(await (path.endsWith('/snapshot')?runtime.recovery.snapshot(inputText(b.planId,128),inputText(b.requestId,128)):runtime.recovery.restore(inputText(b.planId,128),inputText(b.requestId,128))));
    }

    if(path==='/api/openrig/queue/create'){
      if(Object.keys(b).some(k=>!['rigId','destinationSession','summary','body','requestId','notify'].includes(k)))throw new OpenRigError('invalid_request',400);
      if(b.notify!==undefined&&typeof b.notify!=='boolean')throw new OpenRigError('invalid_request',400);
      return json(await runtime.createQueue({notify:b.notify===true,rigId:inputText(b.rigId),destinationSession:inputText(b.destinationSession),summary:inputText(b.summary),body:typeof b.body==='string'?b.body:'',requestId:inputText(b.requestId,128)}));
    }

    if(path==='/api/openrig/starter/plan'){
      if(Object.keys(b).some(k=>k!=='projectPath'))throw new OpenRigError('invalid_request',400);
      return json(await runtime.starter.plan(inputText(b.projectPath,2048)));
    }
    if(path==='/api/openrig/starter/launch'){
      if(Object.keys(b).some(k=>!['planId','requestId'].includes(k)))throw new OpenRigError('invalid_request',400);
      return json(await runtime.starter.launch(inputText(b.planId,128),inputText(b.requestId,128)));
    }

    if(Object.keys(b).some(k=>!['view','expectedPlan','requestId'].includes(k)))throw new OpenRigError('invalid_request',400);
    return json(await runtime.open(inputText(b.view),inputText(b.expectedPlan),inputText(b.requestId,128)));
  }catch(e){return json({error:{code:e instanceof OpenRigError?e.code:'openrig_unavailable'}},e instanceof OpenRigError?e.status:503);}
}
