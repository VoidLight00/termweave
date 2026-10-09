import {test,expect} from 'bun:test';
import {verifyTerminalIdentities} from './terminal-identities.ts';
const identity={seat:'dev@rig',paneId:'p',terminalId:'t',workspaceId:'w',tabId:'tab',generation:'launch1'};
const pane={pane_id:'p',terminal_id:'t',workspace_id:'w',tab_id:'tab',global_pane_number:42};
test('native IDs bind to current global P number only',async()=>{
 expect(await verifyTerminalIdentities([identity],async()=>({panes:[pane]}))).toEqual([{...identity,paneNumber:42}]);
 for(const changed of [{terminal_id:'replaced'},{pane_id:'moved'},{workspace_id:'other'},{tab_id:'other'},{global_pane_number:0}])expect(await verifyTerminalIdentities([identity],async()=>({panes:[{...pane,...changed}]}))).toEqual([]);
 expect(await verifyTerminalIdentities([identity])).toEqual([]);
 expect(await verifyTerminalIdentities([identity,identity],async()=>({panes:[pane]}))).toEqual([]);
});
