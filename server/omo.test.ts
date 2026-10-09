import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { heldRuntime, heldSessionIds, isOmoProcess, omoAgentDir, omoSessionFolder, omoCandidates, omoTranscriptsOfCwd, selectOmoTranscript, type OmoRuntime } from "./omo.ts";
import { processStartedAt } from "./process-start.ts";
import { parseOmpTranscript } from "./transcript-records.ts";

const runtime = (paneId: string, startedAt: number | null = 10_000, paths: string[] = [], ids: string[] = []): OmoRuntime => ({ paneId, startedAt, paths, ids });
const files = [
  { path: "/old.jsonl", id: "old-session", createdAt: 100 },
  { path: "/fresh.jsonl", id: "fresh-session", createdAt: 10_000 },
];

const OMO_AI = "/home/u/.nvm/versions/node/v24.18.0/lib/node_modules/omo-ai"; // leakscan:allow: test fixture

it("takes omo from the program a process runs: its own binary, or the script of node or bun", () => {
  // argv as herdr 0.9.0's pane.process_info reported them for omo 5.1.7 and its MCP child
  expect(isOmoProcess(["/home/u/.bun/bin/bun", `${OMO_AI}/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${OMO_AI}/plugin`])).toBeTrue(); // leakscan:allow: test fixture
  expect(isOmoProcess(["/home/u/.bun/bin/bun", `${OMO_AI}/plugin/runtime/ast-grep-mcp/cli.js`, "mcp"])).toBeTrue(); // leakscan:allow: test fixture
  expect(isOmoProcess(["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeTrue(); // leakscan:allow: test fixture
  expect(isOmoProcess(["node", "--enable-source-maps", `${OMO_AI}/bin/omo.js`, "--session-id", "abcdefgh"])).toBeTrue();
  expect(isOmoProcess(["omo"])).toBeTrue();
  expect(isOmoProcess(["/home/u/.local/bin/omo", "--session-id", "abcdefgh"])).toBeTrue(); // leakscan:allow: test fixture
  expect(isOmoProcess([`${OMO_AI}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, "--output-format", "stream-json"])).toBeTrue();
});

it("reads a Windows PC's process words: bun.exe, backslashes, and a drive's colon", () => {
  const modules = "C:\\Users\\me\\.bun\\install\\global\\node_modules";
  expect(isOmoProcess(["C:\\Users\\me\\.bun\\bin\\bun.exe", `${modules}\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js`, "--extension", `${modules}\\omo-ai\\plugin`])).toBeTrue();
  expect(isOmoProcess(["bun.exe", `${modules}\\omo-ai\\plugin\\runtime\\ast-grep-mcp\\cli.js`, "mcp"])).toBeTrue();
  expect(isOmoProcess(["node.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\omo-ai\\bin\\omo.js"])).toBeTrue();
  expect(isOmoProcess(["C:\\Users\\me\\AppData\\Roaming\\npm\\omo.cmd"])).toBeTrue();
  // still only the program: bun.exe running something else, or a PATH list, is not omo
  expect(isOmoProcess(["bun.exe", "C:\\work\\app\\server.js"])).toBeFalse();
  expect(isOmoProcess(["bun.exe", "C:\\a\\omo-ai\\bin;D:\\b"])).toBeFalse();
  expect(isOmoProcess(["/bin/sh", "-c", "a:/x/omo-ai/bin"])).toBeFalse();
});

it("takes the engine a global bun install hoists next to omo-ai for omo when it loads omo-ai's plugin", () => {
  const modules = "/home/u/.bun/install/global/node_modules"; // leakscan:allow: test fixture
  // omo-ai 5.1.6 installed with `bun add -g omo-ai`: senpi is not under omo-ai
  expect(isOmoProcess(["/home/u/.bun/bin/bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${modules}/omo-ai/plugin`])).toBeTrue(); // leakscan:allow: test fixture
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/cli.js`, "--extension", `${modules}/omo-ai/plugin`, "--model", "anthropic/claude-opus-4-1", "--thinking", "medium"])).toBeTrue();
  // senpi on its own, or with another extension, is not omo
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`])).toBeFalse();
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", "/home/u/ext/other"])).toBeFalse(); // leakscan:allow: test fixture
  // an omo-ai plugin path handed to another script, or not as an extension, is still not omo
  expect(isOmoProcess(["bun", "/home/u/tools/watch.js", "--extension", `${modules}/omo-ai/plugin`])).toBeFalse(); // leakscan:allow: test fixture
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, `${modules}/omo-ai/plugin`])).toBeFalse();
  expect(isOmoProcess([`${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${modules}/omo-ai/plugin`])).toBeFalse();
  // words after `--` are the prompt: senpi loads no extension from them
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--", "Explain", "--extension", `${modules}/omo-ai/plugin`])).toBeFalse();
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${modules}/omo-ai/plugin`, "--", "Explain"])).toBeTrue();
});

it("does not take an omo path given to another program for omo", () => {
  expect(isOmoProcess(["grep", "-q", `${OMO_AI}/x`])).toBeFalse();
  expect(isOmoProcess(["cat", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeFalse(); // leakscan:allow: test fixture
  expect(isOmoProcess(["ls", "omo"])).toBeFalse();
  expect(isOmoProcess(["node", "/home/u/tools/watch.js", `${OMO_AI}/plugin`])).toBeFalse(); // leakscan:allow: test fixture
  expect(isOmoProcess(["bun", "--version"])).toBeFalse();
  expect(isOmoProcess(["/home/u/omo-ai-tools/bun", "/home/u/x.js"])).toBeFalse(); // leakscan:allow: test fixture
  expect(isOmoProcess([])).toBeFalse();
});

it("uses only a unique session created during the sole runtime, never cwd recency", () => {
  expect(selectOmoTranscript("a", files, [runtime("a")], 20_000)).toBe("/fresh.jsonl");
  expect(selectOmoTranscript("a", files, [runtime("a"), runtime("b", 11_000)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a"), runtime("unreadable", null)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", null)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 10_000, [], ["missing-session"])], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 30_000)], 40_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a")], 5_000)).toBeNull();
  expect(selectOmoTranscript("a", [...files, { path: "/second.jsonl", id: "second", createdAt: 11_000 }], [runtime("a")], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", [{ ...files[1]!, createdAt: null }], [runtime("a")], 20_000)).toBeNull();
});

it("binds explicit sessions independently in one cwd but rejects conflicting claims", () => {
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, [], ["old-session"]), runtime("b", 20_000, ["/fresh.jsonl"])] )).toBe("/old.jsonl");
  expect(selectOmoTranscript("b", files, [runtime("a", 20_000, [], ["old-session"]), runtime("b", 20_000, ["/fresh.jsonl"])] )).toBe("/fresh.jsonl");
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, ["/fresh.jsonl"]), runtime("b", 20_000, [], ["fresh-session"])] )).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, ["/fresh.jsonl"], ["old-session"])] )).toBeNull();
});

it("reads session identity from bounded headers and rejects foreign cwd and escaped paths", () => {
  // candidates come back canonical; macOS's tmpdir is a symlink into /private
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-candidates-")));
  try {
    const dir = join(home, ".omo", "agent", "sessions", "--project--");
    mkdirSync(dir, { recursive: true });
    const session = (path: string, cwd: string) => writeFileSync(path, JSON.stringify({ type: "session", id: "session-1", cwd, timestamp: "2026-09-27T00:00:00Z" }) + "\n");
    session(join(dir, "valid.jsonl"), "/project");
    session(join(dir, "foreign.jsonl"), "/elsewhere");
    session(join(home, "outside.jsonl"), "/project");
    symlinkSync(join(home, "outside.jsonl"), join(dir, "escaped.jsonl"));
    writeFileSync(join(dir, "broken.jsonl"), "{");
    expect(omoCandidates("/project", home)).toEqual([{ path: join(dir, "valid.jsonl"), id: "session-1", createdAt: Date.parse("2026-09-27T00:00:00Z") }]);
    expect(omoCandidates("/missing", home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads only the live process's own holder records, never a reused pid's leftovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-omo-holders-"));
  try {
    const hold = (id: string, pid: number, processStartedAtMs: number) => {
      const holders = join(dir, "session-holders", encodeURIComponent(id));
      mkdirSync(holders, { recursive: true });
      writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, bootAtMs: 0, processStartedAtMs, cwd: "/project" }));
    };
    hold("current", 42, 10_000);
    hold("crashed-earlier", 42, 2_000);
    hold("another-process", 7, 10_000);
    hold("odd/id", 43, 10_000);
    expect(heldSessionIds(dir, 42, 10_900)).toEqual(["current"]);
    expect(heldSessionIds(dir, 42, null).sort()).toEqual(["crashed-earlier", "current"]);
    expect(heldSessionIds(dir, 43, 10_000)).toEqual(["odd/id"]);
    expect(heldSessionIds(dir, 99, 10_000)).toEqual([]);
    expect(heldSessionIds(join(dir, "missing"), 42, 10_000)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("shows no earlier conversation after /new, while the session held now has no file yet", () => {
  // the process started at 10s and wrote /fresh.jsonl; /new then made it hold a session not written yet
  const afterNew = heldRuntime(runtime("a"), ["new-session"], files);
  expect(selectOmoTranscript("a", files, [runtime("a")], 20_000)).toBe("/fresh.jsonl");
  expect(selectOmoTranscript("a", files, [afterNew], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [heldRuntime(runtime("a", 10_000, [], ["fresh-session"]), ["new-session"], files)], 20_000)).toBeNull();
  // its first message writes the file, and the chat follows it
  const written = [...files, { path: "/new.jsonl", id: "new-session", createdAt: 15_000 }];
  expect(selectOmoTranscript("a", written, [heldRuntime(runtime("a"), ["new-session"], written)], 20_000)).toBe("/new.jsonl");
  // holding nothing changes nothing
  expect(heldRuntime(runtime("a", 10_000, ["/old.jsonl"]), [], files)).toEqual(runtime("a", 10_000, ["/old.jsonl"]));
});

it("does not pin a launch session id after a new unclaimed session appears", () => {
  const newer = [...files, { path: "/new.jsonl", id: "new-session", createdAt: 15_000 }];
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, [], ["old-session"])], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, ["/old.jsonl"], ["old-session"])], 20_000)).toBe("/old.jsonl");
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, [], ["old-session"]), runtime("b", 14_000, ["/new.jsonl"])], 20_000)).toBe("/old.jsonl");
});

it("finds omo's agent directory where the process's environment moved it", () => {
  expect(omoAgentDir(null, "/home/u", "/project")).toBe("/home/u/.omo/agent"); // leakscan:allow: test fixture
  expect(omoAgentDir(["PATH=/bin"], "/home/u", "/project")).toBe("/home/u/.omo/agent"); // leakscan:allow: test fixture
  expect(omoAgentDir(["OMO_CODING_AGENT_DIR=/state/omo/agent"], "/home/u", "/project")).toBe("/state/omo/agent");
  // the brand's own prefix first, then senpi's and pi's, as senpi reads them
  expect(omoAgentDir(["PI_CODING_AGENT_DIR=/pi", "SENPI_CODING_AGENT_DIR=/senpi"], "/home/u", "/project")).toBe("/senpi");
  expect(omoAgentDir(["SENPI_CODING_AGENT_DIR=/senpi", "OMO_CODING_AGENT_DIR=/omo"], "/home/u", "/project")).toBe("/omo");
  expect(omoAgentDir(["OMO_CODING_AGENT_DIR=~/.local/state/omo"], "/home/u", "/project")).toBe("/home/u/.local/state/omo"); // leakscan:allow: test fixture
  expect(omoAgentDir(["OMO_CODING_AGENT_DIR=rel/agent"], "/home/u", "/project")).toBe("/project/rel/agent");
  // set but empty: senpi keeps its default and looks no further
  expect(omoAgentDir(["OMO_CODING_AGENT_DIR=", "SENPI_CODING_AGENT_DIR=/senpi"], "/home/u", "/project")).toBe("/home/u/.omo/agent"); // leakscan:allow: test fixture
});

it("binds an omo pane whose launcher moved its agent directory out of ~/.omo", () => {
  // A launcher profile (OMO_CODING_AGENT_DIR=<state>/.omo/agent) wrote the session and its
  // holder record there, and ~/.omo/agent/sessions had no folder for the cwd: the chat lens
  // answered { source: "scrollback", turns: [] } and showed nothing.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-agent-dir-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const agentDir = join(root, "state", "profile", ".omo", "agent");
    mkdirSync(join(home, ".omo", "agent", "sessions"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const dir = join(agentDir, "sessions", `-${cwd.replaceAll("/", "-")}--`);
    const id = "01a0fd83-0000-7000-8000-000000000001";
    const pid = process.pid;
    mkdirSync(join(dir, "session-holders", id), { recursive: true });
    writeFileSync(join(dir, "session-holders", id, `${pid}.json`), JSON.stringify({ pid, processStartedAtMs: processStartedAt(pid) ?? 0, cwd }));
    // the record shapes of a real omo 5.1.10 session, contents replaced
    const path = join(dir, `2026-10-02T16-47-10-905Z_${id}.jsonl`);
    writeFileSync(path, [
      { type: "session", version: 3, id, timestamp: "2026-10-02T16:47:10.905Z", cwd },
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-02T16:47:11.562Z", provider: "anthropic-subscription", modelId: "model" },
      { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-10-02T16:47:11.563Z", thinkingLevel: "medium" },
      { type: "message", id: "u1", parentId: "t1", timestamp: "2026-10-02T16:47:20.000Z", message: { role: "user", content: [{ type: "text", text: "research the direction" }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-02T16:47:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "here is the direction" }], stopReason: "stop", timestamp: 2 } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const pane = { pane_id: "w1:p1", cwd } as HerdrPane;
    const argv = ["/usr/bin/bun", "/opt/omo/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js", "--extension", "/opt/omo/node_modules/omo-ai/plugin"];
    const infos = new Map([[pane.pane_id, { process_info: { foreground_processes: [{ pid, argv }] } }]]);
    const moved = () => ["HOME=" + home, `OMO_CODING_AGENT_DIR=${agentDir}`];

    expect(omoTranscriptsOfCwd(cwd, [pane], infos, home, () => ["HOME=" + home]).get(pane.pane_id)?.path).toBeNull();
    const bound = omoTranscriptsOfCwd(cwd, [pane], infos, home, moved).get(pane.pane_id)?.path;
    expect(bound).toBe(path);
    expect(parseOmpTranscript(readFileSync(bound!, "utf8")).map((turn) => turn.role)).toEqual(["user", "assistant"]);
    // a store the environment names is the only other place a session may come from
    expect(omoCandidates(cwd, home)).toEqual([]);
    expect(omoCandidates(cwd, home, [], [join(home, ".omo", "agent"), agentDir]).map((file) => file.path)).toEqual([path]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("names a cwd's session folder as omo's engine does, a Windows cwd included", () => {
  expect(omoSessionFolder("/home/u/dev/app")).toBe("--home-u-dev-app--"); // leakscan:allow: test fixture
  expect(omoSessionFolder("C:\\Users\\me\\dev\\app")).toBe("--C--Users-me-dev-app--");
  expect(omoSessionFolder("C:/Users/me/app")).toBe("--C--Users-me-app--"); // leakscan:allow: test fixture
});
