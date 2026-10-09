import type {OpenRigTerminalIdentity} from '../../shared/openrig.ts';
export interface NativeOpenRigPane {pane_id:string;terminal_id:string;workspace_id:string;tab_id:string;global_pane_number?:number}
export type OpenRigNativeSnapshot=()=>Promise<{panes:NativeOpenRigPane[]}>;
export async function verifyTerminalIdentities(raw:unknown,snapshot?:OpenRigNativeSnapshot):Promise<OpenRigTerminalIdentity[]>{
 if(!snapshot||!Array.isArray(raw)||raw.length>100)return [];
 try{
  const {panes}=await snapshot();const result:OpenRigTerminalIdentity[]=[];
  for(const item of raw){
   if(!item||typeof item!=='object'||!['seat','paneId','terminalId','workspaceId','tabId','generation'].every(k=>typeof item[k]==='string'&&item[k].length>0&&item[k].length<=256))continue;
   const matches=panes.filter(p=>p.pane_id===item.paneId&&p.terminal_id===item.terminalId&&p.workspace_id===item.workspaceId&&p.tab_id===item.tabId);
   if(matches.length!==1)continue;const p=matches[0]!;
   if(!Number.isSafeInteger(p.global_pane_number)||p.global_pane_number!<1)continue;
   if(result.some(r=>r.seat===item.seat||r.terminalId===item.terminalId))return [];
   result.push({seat:item.seat,paneId:item.paneId,terminalId:item.terminalId,workspaceId:item.workspaceId,tabId:item.tabId,generation:item.generation,paneNumber:p.global_pane_number!});
  }
  return result;
 }catch{return [];}
}
