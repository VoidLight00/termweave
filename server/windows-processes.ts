/**
 * What runs under a pane's shell on Windows. herdr's pane.process_info names only the shell
 * there, even while a program runs in it (live-verified, herdr 0.9.3: gjc.exe was a child of
 * the pane's powershell.exe and not in foreground_processes), because Windows has no
 * foreground process group to ask. It does give `shell_pid`, and the bridge runs on that
 * PC, so the process table answers instead.
 */
export interface ProcessRow {
  pid: number; parent: number; path: string | null; commandLine: string | null;
  /** when the process started, in ms since 1970: Windows hands a finished process's number to the next one */
  started?: number;
}

/** A Windows command line as argv: double quotes group, nothing else is special here. */
export function windowsArgv(commandLine: string): string[] {
  const words: string[] = [];
  for (const match of commandLine.matchAll(/"([^"]*)"|(\S+)/g)) words.push(match[1] ?? match[2]!);
  return words;
}

/** argv of every process below `pid`, nearest first; the executable's full path stands for argv[0]. */
export function descendantArgv(rows: readonly ProcessRow[], pid: number): string[][] {
  const found: string[][] = [];
  const seen = new Set<number>([pid]);
  let level = [pid];
  while (level.length > 0) {
    const next: number[] = [];
    for (const row of rows) {
      if (!level.includes(row.parent) || seen.has(row.pid)) continue;
      seen.add(row.pid);
      next.push(row.pid);
      const argv = windowsArgv(row.commandLine ?? "");
      found.push(row.path ? [row.path, ...argv.slice(1)] : argv);
    }
    level = next;
  }
  return found;
}

export function parseProcessTable(json: string): ProcessRow[] {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return []; }
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const pid = row["ProcessId"], parent = row["ParentProcessId"];
    if (typeof pid !== "number" || typeof parent !== "number") return [];
    const started = row["Started"];
    return [{
      pid, parent, path: typeof row["ExecutablePath"] === "string" ? row["ExecutablePath"] : null, commandLine: typeof row["CommandLine"] === "string" ? row["CommandLine"] : null,
      ...(typeof started === "number" ? { started } : {}),
    }];
  });
}

const TABLE_SCRIPT = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, @{n='Started';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress";

/**
 * The process table of this PC, or nothing when it cannot be read. A query that stalls is
 * killed at `timeoutMs`, so a caller with a deadline keeps it.
 */
export async function windowsProcessTable(timeoutMs = 10_000, command: string[] = ["powershell", "-NoProfile", "-NonInteractive", "-Command", TABLE_SCRIPT]): Promise<ProcessRow[]> {
  try {
    const probe = Bun.spawn(command, { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: timeoutMs, killSignal: "SIGKILL" });
    const [code, out] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
    return code === 0 ? parseProcessTable(out) : [];
  } catch { return []; }
}
