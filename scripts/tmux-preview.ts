#!/usr/bin/env bun
import {mkdir,realpath} from "node:fs/promises";
import {resolve,join} from "node:path";
import {TmuxRuntime} from "../server/tmux/runtime.ts";

/** Local review surface. No connection to an existing native Herdr session. */
const directory=process.argv[2];
const port=Number(process.argv[3]??7327);
if(!directory || !Number.isInteger(port) || port<1024 || port>65535)throw new Error("usage: tmux-preview.ts <private state directory> [port]");
await mkdir(resolve(directory),{recursive:true,mode:0o700});
const root=await realpath(directory);
process.env.HERDR_SOCKET=join(root,"native-herdr-disabled.sock");
const {createServer}=await import("../server/index.ts");
const server=createServer({port,hostname:"127.0.0.1",token:"",stateDir:join(root,"web"),tailscaleOwner:null,machines:false,registerBridge:false,terminalAttach:false,
  tmux:new TmuxRuntime(join(root,"tmux"))});
console.log(`Local tmux preview: http://127.0.0.1:${server.port}/tmux`);
const stop=()=>{server.stop();process.exit(0);};
process.once("SIGINT",stop);process.once("SIGTERM",stop);
