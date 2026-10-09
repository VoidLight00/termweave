import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationParser } from "./parser.ts";
import { TerminalNotificationStore, currentTarget } from "./store.ts";
import { TerminalNotifications } from "./api.ts";
import type { TerminalAnnouncement } from "../../shared/terminal-notifications.ts";
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), "tw-notify-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const osc = (text: string) => `\x1b]${text}\x1b\\`;
test("OSC 9/99/777 tolerate every split including ST and Korean", () => {
  const input = osc("9;완료 알림") + "ordinary text" + osc("99;i=a:d=0;제목") + osc("99;i=a:p=body;본문") + "\x1b]777;notify;Build;Done\x07";
  for (let split = 0; split <= input.length; split++) {
    const out: TerminalAnnouncement[] = []; const p = new NotificationParser(n => out.push(n));
    p.feed(input.slice(0, split)); p.feed(input.slice(split));
    expect(out).toEqual([{ protocol: "9", title: "완료 알림", body: "" }, { protocol: "99", title: "제목", body: "본문" }, { protocol: "777", title: "Build", body: "Done" }]);
  }
});
test("malicious controls, unsupported queries and progress are not executed or announced", () => {
  const out: TerminalAnnouncement[] = []; const p = new NotificationParser(n => out.push(n));
  p.feed(osc("9;4;1;70") + osc("52;c;secret") + osc("99;p=?;query") + osc("99;e=1;YQ==") + osc("99;i=../../bad;bad") + osc("777;exec;evil;body"));
  p.feed(osc("9;safe\x00\u202eevil<script>"));
  expect(out).toEqual([{ protocol: "9", title: "safeevil<script>", body: "" }]);
});
test("oversized/unterminated sequences discard nested content and recover after end", () => {
  const out: TerminalAnnouncement[] = []; const p = new NotificationParser(n => out.push(n));
  p.feed("\x1b]9;" + "x".repeat(100000)); p.feed("\x1b]9;injected\x07");
  expect(out).toHaveLength(0); p.feed(osc("9;valid")); expect(out[0]?.title).toBe("valid");
});
test("multipart state is separate per parser and expires", () => {
  let now = 0; const out: TerminalAnnouncement[] = []; const a = new NotificationParser(n => out.push(n), () => now); const b = new NotificationParser(n => out.push(n));
  a.feed(osc("99;i=x:d=0;A")); b.feed(osc("99;i=x;B")); a.feed(osc("99;i=x:p=body;body"));
  expect(out.map(n => n.title)).toEqual(["B", "A"]);
  a.feed(osc("99;i=z:d=0;expired")); now = 31000; a.feed(osc("99;i=z;new")); expect(out[2]?.title).toBe("new");
});
const panes = [{ terminal_id: "terminal-A", pane_id: "pane-new", workspace_id: "workspace-other", global_pane_number: 43 }];
test("stable terminal identity routes across workspace and rejects reuse, duplicate identity, missing P", () => {
  expect(currentTarget("terminal-A", panes)).toEqual({ terminalId: "terminal-A", paneId: "pane-new", workspaceId: "workspace-other", paneNumber: 43 });
  expect(currentTarget("terminal-old", panes)).toBeNull(); expect(currentTarget("terminal-A", [...panes, ...panes])).toBeNull();
  expect(currentTarget("terminal-A", [{ ...panes[0]!, global_pane_number: undefined }])).toBeNull();
});
test("persistent read/clear, dedupe and per-terminal rate bound", () => {
  const root = temp(); let now = 100000; let store = new TerminalNotificationStore(root, () => now);
  const item: TerminalAnnouncement = { protocol: "9", title: "test", body: "" };
  expect(store.add("terminal-A", item)).toBe(true); expect(store.add("terminal-A", item)).toBe(false);
  const id = store.list(panes)[0]!.id; store.read(id); store.close(); store = new TerminalNotificationStore(root, () => now);
  expect(store.list(panes)[0]?.read).toBe(true);
  for (let i = 0; i < 19; i++) expect(store.add("terminal-A", { ...item, title: String(i) })).toBe(true);
  expect(store.add("terminal-A", { ...item, title: "over" })).toBe(false);
  now += 60001; expect(store.add("terminal-A", item)).toBe(true);
  store.clear(); expect(store.list(panes)).toEqual([]); store.close();
});
test("retention caps at 200 and terminal output cannot spoof identity", () => {
  const store = new TerminalNotificationStore(temp());
  for (let i = 0; i < 240; i++) store.add(`terminal-${i}`, { protocol: "9", title: `P999 ${i}`, body: "workspace spoof" });
  const rows = store.list(panes); expect(rows).toHaveLength(200); expect(rows.every(r => r.target === null)).toBe(true); store.close();
});
test("API watch read-only, current target fresh, missing target 410, no raw failure", async () => {
  let current = panes; const service = new TerminalNotifications(temp(), async () => ({ panes: current }));
  service.stream("terminal-A")(osc("9;message"));
  const req = (path = "", method = "GET") => new Request(`http://localhost/api/terminal-notifications${path}`, { method });
  let response = await service.handle(req(), true); expect(response?.status).toBe(200);
  const list = await response!.json(); const id = list.items[0].id;
  expect(list.collection).toBe("native-live-output"); expect(list.items[0].target.paneNumber).toBe(43);
  expect((await service.handle(req(`/${id}/target`), true))?.status).toBe(200);
  expect((await service.handle(req(`/${id}/read`, "POST"), true))?.status).toBe(403);
  expect((await service.handle(req("/clear", "POST"), true))?.status).toBe(403);
  expect((await service.handle(req(`/${id}/read`, "POST"), false))?.status).toBe(200);
  current = [{ ...panes[0]!, terminal_id: "replacement" }]; expect((await service.handle(req(`/${id}/target`), true))?.status).toBe(410);
  expect((await service.handle(req("/clear", "POST"), false))?.status).toBe(200); service.close();
});
test("over-limit multipart content is rejected as a whole, not published as a truncated tail", () => {
  const out: TerminalAnnouncement[] = []; const parser = new NotificationParser(item => out.push(item));
  parser.feed(osc("99;i=big:d=0;" + "x".repeat(3000)));
  parser.feed(osc("99;i=big:d=0:p=body;" + "y".repeat(3000)));
  parser.feed(osc("99;i=big:p=body;tail"));
  expect(out).toEqual([]); parser.feed(osc("99;i=next;valid")); expect(out[0]?.title).toBe("valid");
});

test("native cursor persists atomically and clear does not replay records", () => {
  const root = temp(); let store = new TerminalNotificationStore(root);
  const batch = {source:"live-pty-notifications-v1" as const,epoch:"epoch1",cursor:7,truncated:false,items:[{sequence:7,terminal_id:"terminal-A",protocol:"9" as const,title:"native",body:""}]};
  store.ingestNative(batch); expect(store.list(panes)).toHaveLength(1);store.close();store=new TerminalNotificationStore(root);
  expect(store.nativeCursor()).toEqual({epoch:"epoch1",cursor:7});store.clear();store.ingestNative(batch);expect(store.list(panes)).toHaveLength(0);
  expect(()=>store.ingestNative({...batch,cursor:6,items:[]})).toThrow("stale_notification_cursor");
  expect(()=>store.ingestNative({...batch,cursor:8,items:[{...batch.items[0]!,sequence:9}]})).toThrow();expect(store.nativeCursor().cursor).toBe(7);store.close();
});
test("native polling exposes unsupported runtime honestly and stops after close", async () => {
  const service = new TerminalNotifications(temp(), async () => ({panes}));
  let calls = 0;
  service.startNative(async () => { calls++; throw new Error("unknown_method"); });
  await Bun.sleep(30);
  const response = await service.handle(new Request("http://localhost/api/terminal-notifications"), true);
  expect((await response!.json()).sourceStatus).toBe("unavailable");expect(calls).toBe(1);service.close();await Bun.sleep(30);expect(calls).toBe(1);
});
