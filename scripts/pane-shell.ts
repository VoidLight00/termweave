/** What a test types into its own pane: herdr on Windows starts PowerShell 7 there, elsewhere a POSIX shell. */
import assert from "node:assert/strict";
import { psQuote } from "../server/powershell.ts";
import { queryIdentity } from "./process-identity.ts";

const windows = process.platform === "win32";
const posixQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** `line` and the key that runs it: in a Windows pane a line feed leaves the line unrun (herdr 0.9.5, pwsh 7), Enter is `\r`. */
export function submitted(line: string, posixEnd: "\n" | "\r"): string {
  return line + (windows ? "\r" : posixEnd);
}

/** A command line that runs `program` in the pane: PowerShell's call operator `&`, or `exec` in place of the POSIX shell. */
export function runInPane(program: string, ...args: string[]): string {
  const quote = windows ? psQuote : posixQuote;
  return `${windows ? "&" : "exec"} ${[program, ...args].map(quote).join(" ")}`;
}

/** A command line that writes the pane shell's own process id to `file`: `$PID` in PowerShell, `$$` in a POSIX shell. */
export function writeShellPid(file: string): string {
  return windows ? `Set-Content -NoNewline -LiteralPath ${psQuote(file)} -Value $PID` : `printf '%s' $$ > '${file}'`;
}

/**
 * Each shell's PID, parent PID and start time, one line per PID: `ps -o pid=,ppid=,lstart=`, or on Windows (no such `ps`)
 * the kernel's answer through process-identity.ts, with the start time as CIM CreationDate.
 */
export async function shellProcesses(pids: readonly number[]): Promise<string> {
  if (!windows) {
    const result = await Bun.$`ps -o pid=,ppid=,lstart= -p ${pids.join(",")}`.quiet();
    assert.equal(result.exitCode, 0);
    return result.text();
  }
  return pids.map(pid => {
    const identity = queryIdentity(pid);
    assert.equal(identity.state, "alive", `shell ${pid}: ${identity.detail ?? identity.state}`);
    return `${pid} ${identity.parentPid} ${identity.startedAt}`;
  }).join("\n");
}

/** Windows herdr first reports a new pane's cwd as `C:\dir\` and later as `C:\dir`: one directory, two spellings. */
export function cwdSpelling<T extends string | null | undefined>(cwd: T): T {
  return (windows && typeof cwd === "string" ? cwd.replace(/\\+$/, "") : cwd) as T;
}
