import {expect,test} from "bun:test";
import {listeningPorts} from "./ports.ts";

test("port metadata belongs only to the selected process tree", async () => {
  // This server deliberately does not belong to the selected child's process tree.
  const unrelated = Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("fixture")});
  const child = Bun.spawn([process.execPath,"-e",'const s=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("owned")}); console.log(s.port);'],{stdout:"pipe",stderr:"pipe"});
  const reader = child.stdout.getReader();
  try {
    const line = await reader.read();
    const port = Number(new TextDecoder().decode(line.value).trim());
    expect(port).toBeGreaterThan(0);
    const ports = await listeningPorts(child.pid);
    expect(ports).not.toBeNull();
    expect(ports).toContain(port);
    expect(ports).not.toContain(unrelated.port);
    expect(await listeningPorts(-1)).toBeNull();
  } finally { reader.releaseLock();child.kill();await child.exited;unrelated.stop(true); }
},10000);
