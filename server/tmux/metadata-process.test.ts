import {expect,test} from "bun:test";
import {metadataProcess} from "./metadata-process.ts";

test("metadata probes fail closed on excessive output and timeout",async()=>{
  expect(await metadataProcess([process.execPath,"-e",'process.stdout.write("x".repeat(300000))'])).toBeNull();
  expect(await metadataProcess([process.execPath,"-e",'setTimeout(()=>{},10000)'])).toBeNull();
  expect(await metadataProcess([process.execPath,"-e",'process.stdout.write("ok")'])).toEqual({out:"ok",err:"",code:0});
},5000);
