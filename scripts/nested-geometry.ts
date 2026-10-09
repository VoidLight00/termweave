import { chromiumExecutable } from './browser.ts';
import "./test-herdr.ts";
import { workspaceCreate, workspaceClose, paneSendText, sessionSnapshot, paneRead } from "../server/herdr/client.ts";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { chromium } from "playwright-core";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root=mkdtempSync(join(tmpdir(),"herdr-nested-test-"));
const own=await workspaceCreate({cwd:root,label:"nested-test-owned"});
const socket=join(root,"nested.sock");
const command=`tmux -S '${socket}' new-session -s owned`; await paneSendText(own.root_pane.pane_id,command+"\r");
const server=createServer({port:0,hostname:"127.0.0.1",token:"",stateDir:root,usage:new UsageService(undefined,[])});
const browser=await chromium.launch({executablePath: chromiumExecutable(),headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const frames:unknown[]=[];
 page.on("websocket",ws=>{ws.on("framesent",({payload})=>{const m=JSON.parse(String(payload));if(m.type!=="ack")frames.push(m)});ws.on("framereceived",({payload})=>{const m=JSON.parse(String(payload));if(m.type!=="output")frames.push(m)})});
 await page.goto(`http://127.0.0.1:${server.port}/?pane=${own.root_pane.pane_id}`);await page.waitForTimeout(2500);
 const snap=await sessionSnapshot();console.log('OUTER',snap.panes.find(p=>p.pane_id===own.root_pane.pane_id));
 console.log('FRAMES',frames);console.log('TMUX',Bun.spawnSync(['tmux','-S',socket,'list-clients','-F','#{client_width}x#{client_height} #{client_pid}']).stdout.toString());
 console.log('READ_LAST', (await paneRead({paneId:own.root_pane.pane_id,source:'visible',format:'plain'})).text.split('\n').slice(-3));
} finally {await browser.close();server.stop();Bun.spawnSync(['tmux','-S',socket,'kill-server']);await workspaceClose(own.workspace.workspace_id);rmSync(root,{recursive:true,force:true})}
