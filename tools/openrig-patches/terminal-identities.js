// TermWeave extension to OpenRig 0.6.7 (Apache-2.0).
// Bind structured layout positions to native identifiers, never labels or commands.
export function bindTerminalIdentities(requestRoot, response, listed, seats, generation) {
  const layout=response?.layout;
  if(!layout||!Array.isArray(listed?.panes)||typeof generation!=='string')return [];
  const ids=[];
  function walk(a,b){
    if(!a||!b||a.type!==b.type)return false;
    if(a.type==='pane'){if(typeof b.pane_id!=='string'||!b.pane_id)return false;ids.push(b.pane_id);return true;}
    return a.type==='split'&&a.direction===b.direction&&a.ratio===b.ratio&&walk(a.first,b.first)&&walk(a.second,b.second);
  }
  if(!walk(requestRoot,layout.root)||new Set(ids).size!==ids.length||ids.length<seats.length)return [];
  return seats.flatMap((seat,index)=>{
    const matches=listed.panes.filter(p=>p.pane_id===ids[index]&&p.workspace_id===layout.workspace_id&&p.tab_id===layout.tab_id&&typeof p.terminal_id==='string'&&p.terminal_id);
    return matches.length===1?[{seat:seat.seat,paneId:matches[0].pane_id,terminalId:matches[0].terminal_id,workspaceId:layout.workspace_id,tabId:layout.tab_id,generation}]:[];
  });
}
