import { expect, it } from "bun:test";
import { isGjcProcess } from "./gjc-runtime.ts";
import { paneShell, shellAgentExecutable, shellCommandLine } from "./shell-agent.ts";
import { descendantArgv, parseProcessTable, windowsArgv, windowsProcessTable } from "./windows-processes.ts";

const SYNTHETIC_GJC_PATH = String.raw`C:\Users\fixture\AppData\Local\gjc\gjc.exe`;

it("preserves exact synthetic Windows executable path bytes", () => {
  expect(SYNTHETIC_GJC_PATH.split(String.fromCharCode(92))).toEqual(["C:", "Users", "fixture", "AppData", "Local", "gjc", "gjc.exe"]);
  expect([...SYNTHETIC_GJC_PATH].filter(char => char.charCodeAt(0) < 32)).toEqual([]);
  expect(SYNTHETIC_GJC_PATH).toBe("C:" + String.fromCharCode(92) + ["Users", "fixture", "AppData", "Local", "gjc", "gjc.exe"].join(String.fromCharCode(92)));
});

it("tells a pane's shell from the program herdr reports in front", () => {
  expect(paneShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
  expect(paneShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
  expect(paneShell("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
  expect(paneShell("/bin/zsh")).toBe("posix");
});

it("writes the line each shell runs as a command, not as a string", () => {
  const exe = SYNTHETIC_GJC_PATH;
  expect(shellCommandLine("powershell", exe, ["--resume", "a b"])).toBe(`& '${SYNTHETIC_GJC_PATH}' '--resume' 'a b'`);
  expect(shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["a b"])).toBe('"C:\\gjc\\gjc.exe" "a b"');
  expect(shellCommandLine("posix", "/usr/local/bin/gjc", ["it's"])).toBe("'/usr/local/bin/gjc' 'it'\\''s'");
  // a trailing backslash must not escape the closing quote for the program that parses it
  expect(shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["C:\\work\\", "--resume"])).toBe('"C:\\gjc\\gjc.exe" "C:\\work\\\\" "--resume"');
  // cmd cannot carry these inside quotes
  expect(() => shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["%PATH%"])).toThrow();
  expect(() => shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ['say "hi"'])).toThrow();
});

it("recognizes gjc as Windows reports it", () => {
  expect(isGjcProcess([SYNTHETIC_GJC_PATH])).toBe(true);
  expect(isGjcProcess(["C:\\Program Files\\nodejs\\node.exe", "C:\\tools\\gjc\\dist\\gjc.mjs"])).toBe(true);
  expect(isGjcProcess(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoExit"])).toBe(false);
  expect(isGjcProcess(["C:\\tools\\gjc-helper.exe"])).toBe(false);
});

it("finds what runs under a pane's shell in the process table", () => {
  // Entirely synthetic PowerShell-format process rows; no real process capture.
  const table = parseProcessTable(JSON.stringify([
    { ProcessId: 41948, ParentProcessId: 26540, ExecutablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", CommandLine: "powershell.exe -NoExit" },
    { ProcessId: 12156, ParentProcessId: 41948, ExecutablePath: SYNTHETIC_GJC_PATH, CommandLine: `"${SYNTHETIC_GJC_PATH}"` },
    { ProcessId: 700, ParentProcessId: 12156, ExecutablePath: null, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\x y\\tool.js" --flag' },
    { ProcessId: 9, ParentProcessId: 4, ExecutablePath: "C:\\other\\gjc.exe", CommandLine: "gjc.exe" },
    { ProcessId: "bad" },
  ]));
  const under = descendantArgv(table, 41948);
  expect(under).toEqual([
    [SYNTHETIC_GJC_PATH],
    ["C:\\Program Files\\nodejs\\node.exe", "C:\\x y\\tool.js", "--flag"],
  ]);
  expect(under.some(isGjcProcess)).toBe(true);
  // another pane's shell has no gjc under it, though one runs elsewhere on the PC
  expect(descendantArgv(table, 26540).length).toBe(3);
  expect(descendantArgv(table, 4242)).toEqual([]);
  expect(parseProcessTable("not json")).toEqual([]);
  // the process's start, as the table script reads it (ms since 1970), comes along when present
  expect(parseProcessTable(JSON.stringify({ ProcessId: 2, ParentProcessId: 1, ExecutablePath: null, CommandLine: "x", Started: 1790886000123 }))).toEqual([{ pid: 2, parent: 1, path: null, commandLine: "x", started: 1790886000123 }]);
  expect(windowsArgv('"C:\\a b\\x.exe" one "two three"')).toEqual(["C:\\a b\\x.exe", "one", "two three"]);
});

it("gives up on a process-table query that stalls, and kills it", async () => {
  const started = Date.now();
  expect(await windowsProcessTable(200, ["sleep", "30"])).toEqual([]);
  expect(Date.now() - started).toBeLessThan(5000);
  // a query that answers is read
  expect(await windowsProcessTable(5000, ["printf", '[{"ProcessId":2,"ParentProcessId":1,"ExecutablePath":null,"CommandLine":"x"}]'])).toEqual([{ pid: 2, parent: 1, path: null, commandLine: "x" }]);
});

it("offers on Windows only the shell-started agents known to start there", () => {
  expect(shellAgentExecutable("omo", "win32")).toBeNull();
});
