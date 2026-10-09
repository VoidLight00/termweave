import {expect,test} from "bun:test";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {gitMetadata} from "./metadata.ts";

test("Git metadata observes branch and dirty state without running fsmonitor or exposing file names",async()=>{
  const root=await mkdtemp("/tmp/twg-");
  const run=async(args:string[])=>{const p=Bun.spawn(["git","-C",root,...args],{stdout:"ignore",stderr:"ignore"});expect(await p.exited).toBe(0);};
  try{
    expect(await gitMetadata(root)).toBeNull();
    await run(["init","--initial-branch","owned-branch"]);
    expect(await gitMetadata(root)).toEqual({branch:"owned-branch",dirty:false,ahead:0,behind:0});
    await writeFile(root+"/private-name.txt","owned fixture");
    await run(["config","core.fsmonitor",`touch ${root}/MUST_NOT_EXIST`]);
    const result=await gitMetadata(root);
    expect(result).toEqual({branch:"owned-branch",dirty:true,ahead:0,behind:0});
    expect(JSON.stringify(result)).not.toContain("private-name");
    expect(await Bun.file(root+"/MUST_NOT_EXIST").exists()).toBe(false);
    expect(await gitMetadata("relative")).toBeNull();
  }finally{await rm(root,{recursive:true,force:true});}
});
