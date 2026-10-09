/**
 * Agents herdr's agent.start cannot launch (`herdr agent start --kind` lists its
 * kinds; omo and gjc are not among them). The pane's shell runs the command
 * instead, and the pane's process tree, not the prompt, says when it is up.
 *
 * A Windows pane differs in three ways, each live-verified on a Windows PC (herdr 0.9.3):
 * - its shell is PowerShell or cmd: a quoted path alone is a string there, not a call;
 * - a newline in sent text is a line break in PowerShell's editor (it waits at `>>`): the
 *   command is run by the Enter key;
 * - process_info names only the shell, so the shell's children say whether the agent runs.
 */
import { herdrRpc } from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { isOmoProcess } from "./omo.ts";
import { psQuote } from "./powershell.ts";
import { descendantArgv, windowsProcessTable } from "./windows-processes.ts";

/** kind -> the foreground-process test that proves the agent is running in the pane. */
export const SHELL_AGENTS: Record<string, (argv: readonly string[]) => boolean> = {
  omo: isOmoProcess,
  gjc: isGjcProcess,
};
/** The shell-started agents known to start on Windows; the others are not offered there. */
const WINDOWS_SHELL_AGENTS = new Set(["gjc"]);

export function isShellAgentKind(kind: string): boolean { return Object.hasOwn(SHELL_AGENTS, kind); }

/** Where this server finds `kind`; the pane's shell is herdr's child and may carry another PATH. */
export function shellAgentExecutable(kind: string, platform: string = process.platform): string | null {
  if (platform === "win32" && !WINDOWS_SHELL_AGENTS.has(kind)) return null;
  return Bun.which(kind, { PATH: process.env["PATH"] ?? "" });
}

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;
/** cmd.exe has no escape for a quote inside quotes, and expands %NAME%. */
function cmdQuote(word: string): string {
  if (/["%\r\n]/.test(word)) throw new Error("this argument cannot be typed into cmd.exe");
  // a backslash right before the closing quote would escape it for the program's own parser
  return `"${word.replace(/\\+$/, (run) => run + run)}"`;
}

export type PaneShell = "posix" | "powershell" | "cmd";
/** Which shell a pane runs, from the program herdr reports in front of it. */
export function paneShell(argv0: string): PaneShell {
  const name = argv0.split(/[\\/]/).pop()!.toLowerCase();
  if (name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh") return "powershell";
  if (name === "cmd.exe") return "cmd";
  return "posix";
}

/** The line that runs `executable` with `args` in that shell. */
export function shellCommandLine(shell: PaneShell, executable: string, args: readonly string[]): string {
  if (shell === "powershell") return ["&", psQuote(executable), ...args.map(psQuote)].join(" ");
  if (shell === "cmd") return [executable, ...args].map(cmdQuote).join(" ");
  return [executable, ...args].map(quote).join(" ");
}

interface ProcessInfo { process_info?: { shell_pid?: number; foreground_processes?: { argv?: string[] }[] } }
const processInfo = (paneId: string) => herdrRpc<ProcessInfo>("pane.process_info", { pane_id: paneId }).catch(() => null);

/**
 * Types the agent's absolute path and args into the pane's shell and resolves once
 * `kind` is its foreground process. The path is the one `/api/agents` discovered,
 * so the offer and the start agree whatever the pane shell's PATH says.
 */
export async function startShellAgent(kind: string, paneId: string, args: string[] = [], options: { command?: string; timeoutMs?: number } = {}): Promise<void> {
  const isProcess = SHELL_AGENTS[kind];
  if (!isProcess) throw new Error(`${kind} is not a shell-started agent`);
  const windows = process.platform === "win32";
  if (options.command !== undefined || !windows) {
    let command = options.command;
    if (command === undefined) {
      const executable = shellAgentExecutable(kind);
      if (!executable) throw new Error(`${kind} is not on this server's PATH`);
      command = quote(executable);
    }
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${[command, ...args.map(quote)].join(" ")}\n` });
  } else {
    const executable = shellAgentExecutable(kind);
    if (!executable) throw new Error(`${kind} is not on this server's PATH`);
    const shell = paneShell((await processInfo(paneId))?.process_info?.foreground_processes?.[0]?.argv?.[0] ?? "powershell.exe");
    await herdrRpc("pane.send_text", { pane_id: paneId, text: shellCommandLine(shell, executable, args) });
    await herdrRpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });
  }
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const info = await processInfo(paneId);
    if (info?.process_info?.foreground_processes?.some((process) => isProcess(process.argv ?? []))) return;
    const shellPid = info?.process_info?.shell_pid;
    // the table query never outlasts what is left of the start's own time
    if (windows && typeof shellPid === "number" && descendantArgv(await windowsProcessTable(Math.max(500, Math.min(10_000, deadline - Date.now()))), shellPid).some(isProcess)) return;
    await Bun.sleep(250);
  }
  throw new Error(`${kind} did not start in the pane`);
}
