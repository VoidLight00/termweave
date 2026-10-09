#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

/** Read-only inventory from pinned official checkouts. Does not install or run upstream source. */
const [tmuxRoot, cmuxRoot, output] = process.argv.slice(2);
if (!tmuxRoot || !cmuxRoot || !output) throw new Error("usage: parity-inventory.ts <tmux checkout> <cmux checkout> <output.json>");
const git = async (root: string, ...args: string[]) => {
  const p = Bun.spawn(["git","-C",root,...args], {stdout:"pipe",stderr:"pipe"});
  const [out,,code] = await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  if (code) throw new Error("source identity unavailable"); return out.trim();
};
const identity = async (root: string, repository: string, licenseFile: string, policy: string) => {
  const remote = await git(root,"remote","get-url","origin");
  if (remote !== `https://github.com/${repository}.git`) throw new Error("unexpected reference origin");
  return {repository,revision:await git(root,"rev-parse","HEAD"),licenseFile,
    licenseSha256:createHash("sha256").update(await readFile(join(root,licenseFile))).digest("hex"),policy};
};
const installed = Bun.which("tmux");
let runtimeVersion: string | null = null;
if (installed) {
  const process = Bun.spawn([installed,"-V"],{stdout:"pipe",stderr:"pipe"});
  const [text,,code] = await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited]);
  if (!code) runtimeVersion = text.trim();
}
const tmuxCommands: {name:string;source:string;line:number;verification:"NOT_RUN"}[]=[];
for (const file of new Bun.Glob("cmd-*.c").scanSync({cwd:tmuxRoot})) {
  const text=await readFile(join(tmuxRoot,file),"utf8");
  for(const match of text.matchAll(/\.name\s*=\s*"([a-z][a-z0-9-]+)"/g))
    tmuxCommands.push({name:match[1]!,source:file,line:text.slice(0,match.index).split("\n").length,verification:"NOT_RUN"});
}
const cmuxMethods = new Map<string,{source:string;line:number}[]>();
for (const file of new Bun.Glob("Sources/TerminalController*.swift").scanSync({cwd:cmuxRoot})) {
  const text=await readFile(join(cmuxRoot,file),"utf8");
  for(const match of text.matchAll(/case\s+((?:"[^"]+"\s*,?\s*)+):/g)) {
    for(const name of match[1]!.matchAll(/"([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)"/g))
      cmuxMethods.set(name[1]!,[...(cmuxMethods.get(name[1]!)??[]),{source:file,line:text.slice(0,match.index).split("\n").length}]);
  }
}
const report={schemaVersion:1,scope:"Static command-entry and TerminalController dispatch inventory; dynamic routes and native GUI features require separate mapping. Presence is not implementation or test evidence.",
  upstreams:[await identity(tmuxRoot,"tmux/tmux","COPYING","external engine; source behavior reference"),await identity(cmuxRoot,"manaflow-ai/cmux","LICENSE","reference only; no GPL/BUSL source or assets imported")],
  runtime:{tmux:runtimeVersion,latestSourceParity:"NOT_CLAIMED",entry:"/tmux",nativeCommandPrompt:"Ctrl+b then colon; native runtime commands are reachable, not individually verified"},
  tmuxCommands:tmuxCommands.sort((a,b)=>a.name.localeCompare(b.name)),
  cmuxMethods:[...cmuxMethods].sort(([a],[b])=>a.localeCompare(b)).map(([name,sources])=>({name,sources,coverage:"UNMAPPED",verification:"NOT_RUN"})),
  featureFamilies:[
    {name:"tmux pane/window/session controls",implementation:["server/tmux/client.ts","server/tmux/runtime.ts","src/components/TmuxConsole.tsx"],evidence:["server/tmux/runtime.test.ts","scripts/tmux-workspace-regression.ts"],status:"IMPLEMENTED_TEST_GATE_REQUIRED"},
    {name:"tmux copy mode, buffers, key tables, hooks, options, control mode, pipe-pane",implementation:"Native tmux engine, command prompt and private socket",status:"NATIVE_ACCESS_NOT_EXHAUSTIVELY_TESTED"},
    {name:"cmux native Ghostty GPU renderer and macOS windows",status:"NOT_IMPLEMENTED",reason:"Web xterm renderer is a different engine"},
    {name:"cmux scriptable embedded browser and profile import",status:"NOT_IMPLEMENTED",reason:"Restricted iframe preview is not browser automation"},
    {name:"cmux workspace metadata and PR/port display",status:"PARTIAL",reason:"Selected tmux pane cwd, Git branch/dirty/ahead/behind and descendant listening ports implemented; Herdr sidebar and PR integration remain incomplete"},
    {name:"cmux agent notifications",status:"PARTIAL",reason:"Existing Herdr approval/completion UI; full OSC and cmux CLI compatibility not implemented"},
    {name:"cmux remote SSH/mosh/tmux lifecycle",status:"PARTIAL",reason:"Existing remote machine bridge does not establish native cmux transport parity"}
  ]};
await writeFile(resolve(output),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({tmuxCommands:report.tmuxCommands.length,cmuxMethods:report.cmuxMethods.length,fullParity:false}));
