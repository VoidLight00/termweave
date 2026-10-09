#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { chromiumExecutable } from "./browser.ts";
import { TmuxRuntime } from "../server/tmux/runtime.ts";
import { DeviceStore } from "../server/devices.ts";
import { DEVICE_COOKIE } from "../server/auth.ts";

// No native Herdr discovery, attach or mutation. All tmux processes belong to this test.
const root = await realpath(await mkdtemp("/tmp/tw-ui-"));
process.env.HERDR_SOCKET = root + "/absent-herdr.sock";
process.env.SHELL = "/bin/sh";
const runtime = new TmuxRuntime(root + "/tmux");
const { createServer } = await import("../server/index.ts");
const store = new DeviceStore(root + "/state");
const controller = store.pair(store.startPairing().code, "Owned controller fixture", "drive")!;
const watch = store.pair(store.startPairing().code, "Owned watch fixture", "watch")!;
const server = createServer({port:0,hostname:"127.0.0.1",token:"owned-tmux-fixture",stateDir:root+"/state",tailscaleOwner:null,machines:false,registerBridge:false,terminalAttach:false,tmux:runtime});
const origin = `http://127.0.0.1:${server.port}`;
const headers = {origin,authorization:"Bearer owned-tmux-fixture","content-type":"application/json"};
const artifact = process.env.TMUX_EVIDENCE_DIR;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let ownedSocket = "";
const until = async (check: () => Promise<boolean>) => { for(let i=0;i<150;i++){if(await check())return;await Bun.sleep(40);}throw new Error("owned tmux state timeout"); };
try {
  assert.equal((await fetch(origin+"/api/tmux",{headers:{"x-forwarded-for":"203.0.113.1"}})).status,401);
  assert.equal((await fetch(origin+"/api/tmux/session",{method:"POST",headers:{...headers,origin:"https://other.invalid"},body:'{"name":"no"}'})).status,403);
  assert.equal((await fetch(origin+"/api/tmux/session",{method:"POST",headers:{origin,cookie:`${DEVICE_COOKIE}=${watch.token}`,"content-type":"application/json"},body:'{"name":"no"}'})).status,403);
  browser = await chromium.launch({executablePath:chromiumExecutable(),headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000},locale:"ko-KR"});
  await context.addCookies([{name:DEVICE_COOKIE,value:controller.token,url:origin}]);
  const page = await context.newPage(); const errors:string[]=[];
  page.on("pageerror",error=>{ errors.push(error.message); console.error("owned page error",error.message); });
  page.on("websocket", ws => { ws.on("socketerror", error => console.error("owned websocket",error)); ws.on("close",()=>console.error("owned websocket closed")); });
  page.on("response",response=>{ if(response.status()>=400) console.error("owned HTTP",new URL(response.url()).pathname,response.status()); });
  await page.goto(origin+"/tmux");
  await page.getByRole("textbox").fill("owned-ui");
  await page.getByRole("button",{name:"tmux 세션 생성",exact:true}).click();
  await page.getByText("tmux 연결됨",{exact:true}).waitFor();
  let state = (await runtime.state())!; ownedSocket=state.socket;
  const first = state.panes[0]!; const client = await runtime.client(ownedSocket);
  const input = page.locator(".tmux-screen-host .xterm-helper-textarea");
  await input.focus(); await input.pressSequentially("printf 'TMUX_%s\\n' WEB_VERIFIED",{delay:5}); await input.press("Enter");
  await until(async()=> (await client.read(first)).includes("TMUX_WEB_VERIFIED"));
  // Exercise a real tmux command prompt, not a simulated UI handler.
  await input.press("Control+b"); await input.press(":");
  await input.pressSequentially("set-option -g @termweave-test native-command",{delay:5}); await input.press("Enter");
  const query = async () => {
    const p=Bun.spawn([runtime.binary!,"-S",ownedSocket,"show-option","-gqv","@termweave-test"],{stdout:"pipe",stderr:"ignore"});
    const out=await new Response(p.stdout).text(); await p.exited; return out.trim();
  };
  await until(async()=>await query()==="native-command");
  await page.getByRole("button",{name:"좌우 분할",exact:true}).click();
  await until(async()=>(await runtime.state())!.panes.length===2);
  await page.locator("[data-tmux-pane]").nth(1).waitFor();
  assert.equal(await page.locator("[data-tmux-pane]").count(),2);
  state=(await runtime.state())!; const second=state.panes.find(p=>p.paneId!==first.paneId)!;
  await page.locator(`[data-tmux-pane="${second.paneId}"]`).click();
  await until(async()=>(await runtime.state())!.panes.find(p=>p.paneId===second.paneId)!.active);
  await input.focus(); await input.pressSequentially("printf 'PANE_%s\\n' TWO_ONLY",{delay:5}); await input.press("Enter");
  await until(async()=>(await client.read(second)).includes("PANE_TWO_ONLY"));
  // Raw watch WebSocket input is denied too; disabled buttons alone are not authorization.
  const params=new URLSearchParams({socket:ownedSocket,generation:state.generation,paneId:first.paneId,sessionId:first.sessionId});
  const watchSocket=new WebSocket(origin.replace("http:","ws:")+"/api/tmux/terminal?"+params,{headers:{origin,cookie:`${DEVICE_COOKIE}=${watch.token}`}});
  const denied=await new Promise<number>((resolve,reject)=>{
    const timer=setTimeout(()=>{watchSocket.close();reject(new Error("watch socket timeout"));},5000);
    watchSocket.onmessage=event=>{const message=JSON.parse(String(event.data));if(message.type==="ready")watchSocket.send(JSON.stringify({type:"input",data:"MUST_NOT_TYPE"}));};
    watchSocket.onclose=event=>{clearTimeout(timer);resolve(event.code);};
    watchSocket.onerror=()=>{clearTimeout(timer);reject(new Error("watch connection failed"));};
  });
  assert.equal(denied,1008);
  assert.ok(!(await client.read(first)).includes("MUST_NOT_TYPE"));
  assert.ok(!(await client.read(first)).includes("PANE_TWO_ONLY"));
  await page.getByRole("button",{name:"터미널 확대·복원",exact:true}).click();
  await until(async()=>(await runtime.state())!.panes.some(p=>p.zoomed));
  await page.getByRole("button",{name:"터미널 확대·복원",exact:true}).click();
  await until(async()=>(await runtime.state())!.panes.every(p=>!p.zoomed));
  await page.reload(); await page.getByText("tmux 연결됨",{exact:true}).waitFor();
  assert.equal((await runtime.state())!.generation,first.generation);
  await until(async()=>(await client.read(second)).includes("PANE_TWO_ONLY"));
  for(const width of [320,375,768,1440]){
    await page.setViewportSize({width,height:1000}); await Bun.sleep(120);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`horizontal overflow ${width}`);
  }
  await page.setViewportSize({width:1440,height:1000});
  if(artifact){await mkdir(artifact,{recursive:true});await page.screenshot({path:artifact+"/tmux-workspace.png"});}
  const watchContext=await browser.newContext({locale:"en-US"});
  await watchContext.addCookies([{name:DEVICE_COOKIE,value:watch.token,url:origin}]);
  const watchPage=await watchContext.newPage();await watchPage.goto(origin+"/tmux");
  await watchPage.getByText("Connected to tmux",{exact:true}).waitFor({timeout:5000}).catch(async e=>{console.error("watch fixture",(await watchPage.locator("body").innerText()).slice(0,1200));throw e;});
  assert.ok(await watchPage.getByRole("button",{name:"Create tmux session",exact:true}).isDisabled());
  await watchContext.close();
  await context.close();
  assert.equal((await runtime.state())!.generation,first.generation,"browser close must not kill sessions");
  assert.deepEqual(errors,[]);
  const result={realShell:true,nativeTmuxCommand:true,split:true,paneInputIsolation:true,zoom:true,reloadPersistence:true,closePersistence:true,watch:true,auth:true,origin:true,responsiveWidths:[320,375,768,1440],errors};
  if(artifact)await writeFile(artifact+"/tmux-workspace.json",JSON.stringify(result,null,2)+"\n");
  console.log("PASS",JSON.stringify(result));
} catch(error) {
  const page=browser?.contexts()[0]?.pages()[0];
  if(page) { console.error("owned browser regression failed"); if(artifact)await page.screenshot({path:artifact+"/failed-tmux.png"}); }
  throw error;
} finally {
  await browser?.close();server.stop();
  const state=await runtime.state().catch(()=>null); ownedSocket ||= state?.socket ?? root+"/tmux/server.sock";
  if(ownedSocket){const p=Bun.spawn([runtime.binary!,"-S",ownedSocket,"kill-server"],{stdout:"ignore",stderr:"ignore"});await p.exited;}
  await rm(root,{recursive:true,force:true});
}
