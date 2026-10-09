import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { TmuxRuntime } from "./runtime.ts";
import { actionCommand } from "./actions.ts";

test("action arguments reject injection, invalid directions and ambiguous target IDs", () => {
  for (const action of [{type:"resize",direction:"R;kill-server",cells:1}, {type:"layout",layout:"tiled;kill-server"},
    {type:"swap",otherPaneId:"session:0.0"}, {type:"rename-session",name:"a;kill-server"}, {type:"synchronize",enabled:"false"},
    {type:"rename-session",name:"trailing-newline\n"}, {type:"swap",otherPaneId:"%0\n"},
    {type:"resize",direction:"R",cells:NaN}, {type:"split",direction:"diagonal"}, {type:"command",command:"kill-server"}])
    expect(() => actionCommand("%0", action as never)).toThrow("invalid_action");
});

test("private real tmux runtime: split, indexes, layouts, resize, zoom, move, swap, persistence and stale rejection", async () => {
  const root = await realpath(await mkdtemp("/tmp/twp-"));
  const runtime = new TmuxRuntime(root + "/runtime");
  let socket = "";
  try {
    expect(await runtime.state()).toBeNull();
    let state = await runtime.create("owned"); socket = state.socket;
    const client = await runtime.client(socket);
    const control: typeof client.control = async (target, action) => {
      try { return await client.control(target, action); }
      catch (error) { throw new Error(`owned action ${action.type}: ${error}`); }
    };
    const a = state.panes[0]!;
    await control(a, {type:"split",direction:"horizontal"});
    state = (await runtime.state())!;
    expect(state.panes.map(p => p.paneIndex).sort()).toEqual([0,1]);
    const b = state.panes.find(p => p.paneId !== a.paneId)!;
    expect(b.windowId).toBe(a.windowId);
    for (const layout of ["even-horizontal","even-vertical","main-horizontal","main-vertical","tiled"] as const)
      await control(a, {type:"layout",layout});
    await control(a, {type:"resize",direction:"R",cells:3});
    await control(a, {type:"zoom"});
    expect((await runtime.state())!.panes.find(p => p.paneId === a.paneId)!.zoomed).toBe(true);
    await control(a, {type:"zoom"});
    await control(a, {type:"synchronize",enabled:true});
    expect((await runtime.state())!.panes.every(p => p.synchronized)).toBe(true);
    await control(a, {type:"synchronize",enabled:false});
    await control(a, {type:"swap",otherPaneId:b.paneId});
    expect((await runtime.state())!.panes.find(p => p.paneId === a.paneId)!.paneIndex).toBe(1);
    await control(b, {type:"break"});
    expect(new Set((await runtime.state())!.panes.map(p => p.windowId)).size).toBe(2);
    await control(a, {type:"join",otherPaneId:b.paneId});
    expect(new Set((await runtime.state())!.panes.map(p => p.windowId)).size).toBe(1);
    await control(a, {type:"new-window"});
    expect(new Set((await runtime.state())!.panes.map(p => p.windowId)).size).toBe(2);
    await control(a, {type:"rename-session",name:"renamed"});
    await control(a, {type:"rename-window",name:"window-renamed"});
    expect((await runtime.state())!.panes.find(p => p.paneId === a.paneId)!.sessionName).toBe("renamed");
    expect((await runtime.state())!.panes.find(p => p.paneId === a.paneId)!.windowName).toBe("window-renamed");
    for (const title of ["", "tab\tand\nnewline", "#{pane_id}; $(not-executed)"]) {
      const p = Bun.spawn([runtime.binary!,"-S",socket,"rename-window","-t",a.paneId,title], {stdout:"pipe",stderr:"pipe"});
      await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
      const named = (await runtime.state())!.panes.find(p => p.paneId === a.paneId)!;
      expect(named.windowName).not.toMatch(/[\x01-\x1f\x7f]/);
      // rename-window itself expands formats; reading the resulting label must not reframe rows.
      if (!/[\x01-\x1f\x7f]/.test(title)) expect(named.windowName).toBe(title.replace("#{pane_id}", a.paneId));
    }
    await control(b, {type:"select"});
    expect((await runtime.state())!.panes.find(p => p.paneId === b.paneId)!.active).toBe(true);
    const other = await runtime.create("second");
    expect(new Set(other.panes.map(p => p.sessionId)).size).toBe(2);
    expect((await new TmuxRuntime(root + "/runtime").state())!.generation).toBe(a.generation);
    await expect(client.control({...a,generation:"0".repeat(64)}, {type:"close"})).rejects.toThrow("stale_generation");
    await control(b, {type:"close"});
    expect((await runtime.state())!.panes.some(p => p.paneId === b.paneId)).toBe(false);
    expect((await client.attachment(a, a.sessionId, false)).args).toContain("if-shell");
  } finally {
    socket ||= root + "/runtime/server.sock";
    if (socket) {
      const p = Bun.spawn([runtime.binary!,"-S",socket,"kill-server"], {stdout:"ignore",stderr:"ignore"});
      await p.exited;
    }
    await rm(root, {recursive:true,force:true});
  }
}, 30000);
