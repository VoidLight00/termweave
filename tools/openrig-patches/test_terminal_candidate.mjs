import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];
const {bindTerminalIdentities}=await import(pathToFileURL(root+'/daemon/dist/domain/terminal/termweave-terminal-identities.js'));
const request={type:'split',direction:'right',ratio:0.5,first:{type:'pane',label:'same'},second:{type:'pane',label:'same'}};
const response={layout:{workspace_id:'w',tab_id:'tab',root:{...request,first:{type:'pane',pane_id:'p1'},second:{type:'pane',pane_id:'p2'}}}};
const listed={panes:[{pane_id:'p2',terminal_id:'t2',workspace_id:'w',tab_id:'tab'},{pane_id:'p1',terminal_id:'t1',workspace_id:'w',tab_id:'tab'}]};
const seats=[{seat:'builder'},{seat:'reviewer'}];
let r=bindTerminalIdentities(request,response,listed,seats,'generation');assert.deepEqual(r.map(x=>[x.seat,x.terminalId]),[['builder','t1'],['reviewer','t2']]);
assert.equal(bindTerminalIdentities(request,{layout:{...response.layout,root:{...response.layout.root,direction:'down'}}},listed,seats,'g').length,0);
assert.equal(bindTerminalIdentities(request,response,{panes:[listed.panes[0]]},seats,'g').length,1);
assert.equal(bindTerminalIdentities(request,response,{panes:listed.panes.map(p=>({...p,tab_id:'other'}))},seats,'g').length,0);
assert.equal(bindTerminalIdentities(request,{layout:{...response.layout,root:{...response.layout.root,second:response.layout.root.first}}},listed,seats,'g').length,0);
await import(pathToFileURL(root+'/daemon/dist/domain/terminal/herdr-adapter.js'));
console.log(JSON.stringify({tests:6,passed:true,actualCandidateImported:true}));
const {HerdrAdapter}=await import(pathToFileURL(root+'/daemon/dist/domain/terminal/herdr-adapter.js'));
let applyCount=0;let native=[];
const adapter=new HerdrAdapter({transportFactory:()=>({probe:async()=>({alive:true}),request:async(method,params)=>{
 if(method==='workspace.create')return {workspace:{workspace_id:'w'},tab:{tab_id:'blank'}};
 if(method==='layout.apply'){
  applyCount++;let n=0;const map=x=>x.type==='pane'?{...x,pane_id:'native'+(++n)}:{...x,first:map(x.first),second:map(x.second)};
  const mapped=map(params.root);native=[1,2].map(i=>({pane_id:'native'+i,terminal_id:'term'+i,workspace_id:'w',tab_id:'populated'}));
  return {layout:{workspace_id:'w',tab_id:'populated',root:mapped}};
 }
 if(method==='pane.list')return {panes:native};
 return {};
}})});
const panes=[{seat:'builder',label:'Same label',paneCommand:'true'},{seat:'reviewer',label:'Same label',paneCommand:'true'}];
const opened=await adapter.openView({id:'rig:fixture',opened:panes,absent:[],degraded:[],pages:[panes]});
assert.equal(applyCount,1);assert.deepEqual(opened.terminalIdentities.map(x=>[x.seat,x.terminalId]),[['builder','term1'],['reviewer','term2']]);
console.log(JSON.stringify({actualAdapterMockRoundtrip:true,structuredIdentityCount:opened.terminalIdentities.length}));
