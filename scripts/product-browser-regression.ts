import './test-herdr.ts';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {chromium} from 'playwright-core';import {chromiumExecutable} from './browser.ts';
import {createServer} from '../server/index.ts';import {workspaceCreate,workspaceClose} from '../server/herdr/client.ts';
const root=mkdtempSync(join(process.env.TERMWEAVE_TEST_ROOT!,'product-browser-'));
const owned=await workspaceCreate({cwd:root,label:'synthetic-locale'});
const server=createServer({port:0,hostname:'127.0.0.1',stateDir:root,token:''});
const browser=await chromium.launch({executablePath:chromiumExecutable(),headless:true});
try {
 for(const [language,label] of [['en','New terminal tab'],['ko','새 터미널 탭'],['zh','新建终端标签'],['ja','新しいターミナルタブ']]) {
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addInitScript(language=>localStorage.setItem('termweave:settings',JSON.stringify({language,alertsOn:false})),language);
  const page=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${owned.root_pane.pane_id}`);await page.locator('.conn-live').waitFor();
  // The application may open in chat; switch through its existing terminal lens.
  await page.evaluate(id=>localStorage.setItem(`termweave:view:${id}`,'terminal'),owned.root_pane.pane_id);await page.reload();
  await page.getByRole('button',{name:label,exact:true}).first().waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  console.log(`PASS product locale ${language}: translated terminal control, no overflow/page errors`);await context.close();
 }
}finally{await browser.close();server.stop(true);await workspaceClose(owned.workspace.workspace_id);rmSync(root,{recursive:true,force:true});}
