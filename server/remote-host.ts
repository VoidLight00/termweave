/**
 * What setup does on a PC, in that PC's own shell. A Linux or macOS host runs sh; a
 * Windows host runs PowerShell (OpenSSH there defaults to cmd, which cannot even find
 * `sh`). Both keep the same contract: the bridge registry under ~/.config/termweave,
 * one runtime directory per bundle version, and a descriptor per herdr socket.
 *
 * Windows differs in three places that are easy to get wrong:
 * - herdr's socket is a marker file plus a named pipe of the same path (herdr/client.ts).
 * - A process started inside the SSH session dies with it. The bridge is created through
 *   WMI (Win32_Process.Create), whose parent is the WMI host, so it survives logout like
 *   herdr's own server does.
 * - An administrator's authorized keys live in %ProgramData%\ssh\administrators_authorized_keys
 *   with a fixed ACL; everyone else's in ~\.ssh\authorized_keys.
 */
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { shellQuote } from "./machine-security.ts";
import { bundleFile, type InstallStage } from "./remote-bundle.ts";
import type { SshConnection } from "./ssh.ts";
import { psQuote } from "./powershell.ts";

export const REMOTE_PATH = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
export const BUNDLE_DIR = `.local/share/termweave/remote-v${REMOTE_BUNDLE_VERSION}`;
/** the Windows runtime directory, under %LOCALAPPDATA%; `$base` in the scripts below */
export const WINDOWS_BUNDLE_BASE = "$env:LOCALAPPDATA\\termweave";
export const UNSUPPORTED_HOST = "Only Linux, macOS (x64 or arm64) and Windows (x64) PCs are supported.";
export const HERDR_INSTALL_CMD = "https://herdr.dev/install.cmd";

export interface HostInspection {
  platform: "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";
  home: string;
  /** an installed herdr, empty when the bundle's (or, on Windows, herdr's installer) is needed */
  herdrPath: string;
  /** the socket the bridge will register, exactly as its own bridgeIdentity() spells it */
  expectedSocket: string;
  bundleReady: boolean;
  bundleOlder: boolean;
  descriptors: BridgeDescriptor[];
  /** this bundle version's runtime directory and the bridge registry, as absolute paths on the PC */
  runtimeDir: string;
  registryDir: string;
}
export interface StartOptions { session?: string; herdrPath: string; inspection: HostInspection }
export interface InstallOptions { cacheDir?: string; onProgress?(stage: InstallStage, done: number, total: number | null): void }

export interface RemoteHost {
  readonly kind: "posix" | "windows";
  /** the words the approval list uses for the runtime bundle */
  readonly bundleDescription: string;
  readonly logHint: string;
  inspect(ssh: SshConnection, session?: string): Promise<HostInspection>;
  herdrVersion(ssh: SshConnection, herdrPath: string): Promise<string>;
  alive(ssh: SshConnection, pid: number): Promise<boolean>;
  authorizeKey(ssh: SshConnection, keyLine: string): Promise<void>;
  installBundle(ssh: SshConnection, platform: string, signal: AbortSignal, options?: InstallOptions): Promise<void>;
  /** Windows only: herdr's own installer, when the host has none (a bundle carries none there) */
  installHerdr?(ssh: SshConnection): Promise<string>;
  stop(ssh: SshConnection, pid: number): Promise<void>;
  start(ssh: SshConnection, options: StartOptions): Promise<void>;
  descriptors(ssh: SshConnection): Promise<BridgeDescriptor[]>;
}

function parseDescriptors(lines: string[]): BridgeDescriptor[] {
  return lines.flatMap((line) => { try { return [JSON.parse(line) as BridgeDescriptor]; } catch { return []; } });
}

/** sha256 asset upload, both-sides verification, extraction, atomic activation: shared by both hosts. */
async function fetchBundle(platform: string, signal: AbortSignal, options: InstallOptions) {
  const report = options.onProgress ?? (() => {});
  const asset = await bundleFile(platform, signal, { cacheDir: options.cacheDir, onProgress: (done, total) => report("download", done, total) });
  report("upload", 0, asset.size);
  return { asset, input: { path: asset.path, onProgress: (done: number) => report("upload", done, asset.size), onUploaded: () => report("install", 0, null) } };
}

export const posixHost: RemoteHost = {
  kind: "posix",
  bundleDescription: "Private web bridge bundle (Bun, Node and node-pty; no build tools needed)",
  logHint: "~/.config/termweave/bridges/bridge.log",
  async inspect(ssh, session) {
    const inspection = await ssh.run(REMOTE_PATH + `printf '%s\\n' "$(uname -s)" "$(uname -m)" "$(cd -P "$HOME" && pwd -P)" "\${XDG_CONFIG_HOME:-$HOME/.config}" "$(command -v herdr || true)"; test -x "$HOME/${BUNDLE_DIR}/bin/bun" && printf 'bundle-ready\\n' || true; for d in "$HOME/.local/share/termweave/remote-v"*; do if test -x "$d/bin/bun"; then printf 'bundle-older\\n'; break; fi; done; for f in "$HOME/.config/termweave/bridges/"*.json; do test ! -f "$f" || cat "$f"; printf '\\n'; done`);
    const [os, arch, home, xdgConfig, herdrPath, ...lines] = inspection.split("\n");
    if (!["Linux", "Darwin"].includes(os ?? "") || !["x86_64", "aarch64", "arm64"].includes(arch ?? "")) throw new Error(UNSUPPORTED_HOST);
    if (!home?.startsWith("/")) throw new Error("The SSH account's home directory ($HOME) could not be read on this PC");
    // the same XDG_CONFIG_HOME rule remote-entry.ts and herdr itself follow
    const herdrConfig = `${xdgConfig?.startsWith("/") ? xdgConfig : `${home}/.config`}/herdr`;
    const nominalSocket = session ? `${herdrConfig}/sessions/${session}/herdr.sock` : `${herdrConfig}/herdr.sock`;
    const expectedSocket = await ssh.run(`socket=${shellQuote(nominalSocket)}; if test -d "\${socket%/*}"; then cd -P "\${socket%/*}" && printf '%s/herdr.sock' "$PWD"; else printf '%s' "$socket"; fi`);
    return {
      platform: `${os === "Darwin" ? "darwin" : "linux"}-${arch === "x86_64" ? "x64" : "arm64"}`,
      home, herdrPath: herdrPath ?? "", expectedSocket,
      bundleReady: lines.includes("bundle-ready"), bundleOlder: lines.includes("bundle-older"),
      descriptors: parseDescriptors(lines),
      runtimeDir: `${home}/${BUNDLE_DIR}`, registryDir: `${home}/.config/termweave/bridges`,
    };
  },
  herdrVersion: (ssh, herdrPath) => ssh.run(`${shellQuote(herdrPath)} --version`),
  alive: async (ssh, pid) => await ssh.run(`kill -0 ${pid} 2>/dev/null && printf live || true`) === "live",
  async authorizeKey(ssh, keyLine) {
    await ssh.run(`set -eu; umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; key=${shellQuote(keyLine)}; grep -qxF "$key" "$HOME/.ssh/authorized_keys" || printf '\\n%s\\n' "$key" >> "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"`);
  },
  async installBundle(ssh, platform, signal, options = {}) {
    const { asset, input } = await fetchBundle(platform, signal, options);
    // Verify on BOTH hosts, extract into staging and atomically rename. No user-wide
    // Bun/Node/herdr installation is changed; the complete runtime lives in this dir.
    await ssh.run(`set -eu; umask 077; base="$HOME/.local/share/termweave"; mkdir -p "$base"; mkdir "$base/install.lock" || { printf 'Another installation is in progress; retry shortly\\n' >&2; exit 1; }; tmp=$(mktemp -d "$base/install.XXXXXX"); trap 'rm -rf "$tmp"; rmdir "$base/install.lock"' EXIT HUP INT TERM; cat > "$tmp/bundle.tgz"; if command -v sha256sum >/dev/null; then actual=$(sha256sum "$tmp/bundle.tgz" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$tmp/bundle.tgz" | cut -d ' ' -f 1); fi; test "$actual" = ${shellQuote(asset.sha256)}; mkdir "$tmp/runtime"; tar xzf "$tmp/bundle.tgz" -C "$tmp/runtime"; test -x "$tmp/runtime/bin/bun"; test -x "$tmp/runtime/bin/node"; test -x "$tmp/runtime/bin/herdr"; "$tmp/runtime/bin/bun" --version; "$tmp/runtime/bin/herdr" --version; "$tmp/runtime/bin/node" "$tmp/runtime/server/pty/smoke.mjs"; release="$HOME/${BUNDLE_DIR}-${asset.sha256.slice(0, 16)}"; if test ! -d "$release"; then mv "$tmp/runtime" "$release"; fi; ln -s "$release" "$tmp/current"; if test -d "$HOME/${BUNDLE_DIR}" && test ! -L "$HOME/${BUNDLE_DIR}"; then mv "$HOME/${BUNDLE_DIR}" "$HOME/${BUNDLE_DIR}-legacy-$(date +%s)"; fi; "$release/bin/bun" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$tmp/current" "$HOME/${BUNDLE_DIR}"`, input, 30 * 60_000);
  },
  stop: async (ssh, pid) => { await ssh.run(`kill -TERM ${pid}`); },
  async start(ssh, { session, herdrPath, inspection }) {
    await ssh.run(REMOTE_PATH + `umask 077; mkdir -p "$HOME/.config/termweave/bridges"; HERDR_REMOTE_SESSION=${shellQuote(session ?? "")} HERDR_WEB_HERDR_BIN=${shellQuote(herdrPath || `${inspection.home}/${BUNDLE_DIR}/bin/herdr`)} nohup "$HOME/${BUNDLE_DIR}/bin/bun" "$HOME/${BUNDLE_DIR}/server/remote-entry.ts" </dev/null >>"$HOME/.config/termweave/bridges/bridge.log" 2>&1 &`);
  },
  async descriptors(ssh) {
    return parseDescriptors((await ssh.run(`for f in "$HOME/.config/termweave/bridges/"*.json; do test ! -f "$f" || cat "$f"; printf '\\n'; done`)).split("\n"));
  },
};

export { psQuote };
/** A cmd.exe `set "NAME=value"` cannot hold a quote; nothing legitimate here has one. */
function cmdValue(value: string): string {
  if (/["\r\n\0%!]/.test(value)) throw new Error("Invalid characters for a remote path");
  return value;
}

/**
 * A bridge's log and launcher on Windows, one pair per herdr session. cmd holds the file it
 * redirects into, so a second bridge sent to the same log never starts: "The process cannot
 * access the file because it is being used by another process" (live-verified).
 */
export function windowsBridgeFiles(session?: string): { log: string; launcher: string } {
  const suffix = session ? `-${session}` : "";
  return { log: `bridge${suffix}.log`, launcher: `start-bridge${suffix}.cmd` };
}

const WINDOWS_BUNDLE = `${WINDOWS_BUNDLE_BASE}\\remote-v${REMOTE_BUNDLE_VERSION}`;
const WINDOWS_REGISTRY = "$env:USERPROFILE\\.config\\termweave\\bridges";
// a script's exit code follows its last statement: a listing of a registry not there yet must
// not count as a failure, so the directory is checked first
const WINDOWS_DESCRIPTORS = `if (Test-Path ${WINDOWS_REGISTRY}) { Get-ChildItem ${WINDOWS_REGISTRY} -Filter *.json | ForEach-Object { Write-Output (Get-Content $_.FullName -Raw) } }; Write-Output ''`;

export const windowsHost: RemoteHost = {
  kind: "windows",
  bundleDescription: "Private web bridge bundle (Bun only: herdr owns every terminal on Windows)",
  logHint: "%USERPROFILE%\\.config\\termweave\\bridges\\bridge.log (bridge-<session>.log for a named session)",
  async inspect(ssh, session) {
    const inspection = await ssh.runPowerShell([
      "$ErrorActionPreference = 'Continue'",
      // herdr's installer keeps a stable alias here (PATH's herdr.exe is one versioned release,
      // which the next update replaces); a fresh sshd session may not have the PATH it added yet
      "$herdr = \"$env:LOCALAPPDATA\\Programs\\Herdr\\bin\\herdr.exe\"",
      "if (-not (Test-Path $herdr)) { $herdr = (Get-Command herdr.exe -ErrorAction SilentlyContinue).Source }",
      "Write-Output 'Windows'; Write-Output $env:PROCESSOR_ARCHITECTURE; Write-Output $env:USERPROFILE; Write-Output $env:APPDATA; Write-Output $env:LOCALAPPDATA; Write-Output \"$herdr\"",
      `if (Test-Path "${WINDOWS_BUNDLE}\\bin\\bun.exe") { Write-Output 'bundle-ready' }`,
      `if (Get-ChildItem "${WINDOWS_BUNDLE_BASE}" -Directory -Filter 'remote-v*' -ErrorAction SilentlyContinue | Where-Object { Test-Path "$($_.FullName)\\bin\\bun.exe" }) { Write-Output 'bundle-older' }`,
      WINDOWS_DESCRIPTORS,
    ].join("\n"));
    const [os, arch, home, appData, localAppData, herdrPath, ...lines] = inspection.split("\n");
    if (os !== "Windows" || arch !== "AMD64") throw new Error(UNSUPPORTED_HOST);
    const drive = /^[A-Za-z]:\\/;
    if (!home || !drive.test(home) || !appData || !drive.test(appData) || !localAppData || !drive.test(localAppData)) throw new Error("The SSH account's profile directory (%USERPROFILE%) could not be read on this PC");
    const herdrDir = `${appData}\\herdr`;
    return {
      platform: "win32-x64", home, herdrPath: herdrPath ?? "",
      // the marker file's own path: the bridge's realpath of it is the same string (live-verified)
      expectedSocket: session ? `${herdrDir}\\sessions\\${session}\\herdr.sock` : `${herdrDir}\\herdr.sock`,
      bundleReady: lines.includes("bundle-ready"), bundleOlder: lines.includes("bundle-older"),
      descriptors: parseDescriptors(lines),
      runtimeDir: `${localAppData}\\termweave\\remote-v${REMOTE_BUNDLE_VERSION}`, registryDir: `${home}\\.config\\termweave\\bridges`,
    };
  },
  herdrVersion: (ssh, herdrPath) => ssh.runPowerShell(`& ${psQuote(herdrPath)} --version`),
  alive: async (ssh, pid) => (await ssh.runPowerShell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Write-Output 'live' }`)).trim() === "live",
  async authorizeKey(ssh, keyLine) {
    await ssh.runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `$key = ${psQuote(keyLine)}`,
      "$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
      // sshd reads an administrator's keys from one shared file with a fixed ACL; SIDs, since the group's name is localized
      "if ($admin) { $file = \"$env:ProgramData\\ssh\\administrators_authorized_keys\" } else { New-Item -ItemType Directory -Force \"$env:USERPROFILE\\.ssh\" | Out-Null; $file = \"$env:USERPROFILE\\.ssh\\authorized_keys\" }",
      "if (-not (Test-Path $file)) { New-Item -ItemType File $file | Out-Null }",
      // a last line without its newline would take the key onto itself (Add-Content only ends what it adds)
      "if (@(Get-Content $file) -notcontains $key) { $raw = [IO.File]::ReadAllText($file); if ($raw.Length -gt 0 -and -not $raw.EndsWith(\"`n\")) { Add-Content -Path $file -Value '' -Encoding ascii }; Add-Content -Path $file -Value $key -Encoding ascii }",
      // sshd refuses the file while anyone but Administrators and SYSTEM may write it: a grant
      // to Users, Authenticated Users or Everyone that the file already had goes too
      "if ($admin) { icacls $file /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' /remove:g '*S-1-5-32-545' '*S-1-5-11' '*S-1-1-0' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Could not set the permissions of administrators_authorized_keys' } }",
    ].join("\n"));
  },
  async installBundle(ssh, platform, signal, options = {}) {
    const { asset, input } = await fetchBundle(platform, signal, options);
    const release = `${WINDOWS_BUNDLE}-${asset.sha256.slice(0, 16)}`;
    const base = (await ssh.runPowerShell(`Write-Output "${WINDOWS_BUNDLE_BASE}"`)).trim();
    if (!/^[A-Za-z]:\\/.test(base)) throw new Error("%LOCALAPPDATA% could not be read on this PC");
    // the same shape as the POSIX install: verify here and there, stage, then swap the
    // `remote-vN` junction (no privilege needed, unlike a symlink). The upload is its own
    // step (sftp, see SshConnection.upload), so the lock is taken around it by hand.
    const stage = `${base}\\install.${process.pid}`;
    await ssh.runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `New-Item -ItemType Directory -Force ${psQuote(base)} | Out-Null`,
      `try { New-Item -ItemType Directory ${psQuote(base + "\\install.lock")} -ErrorAction Stop | Out-Null } catch { throw 'Another installation is in progress; retry shortly' }`,
      `New-Item -ItemType Directory -Force ${psQuote(stage)} | Out-Null`,
    ].join("\n"));
    const archive = `${stage}\\bundle.tgz`;
    const cleanup = () => ssh.runPowerShell(`Remove-Item -Recurse -Force ${psQuote(stage)} -ErrorAction SilentlyContinue; Remove-Item -Force ${psQuote(base + "\\install.lock")} -ErrorAction SilentlyContinue`).catch(() => {});
    try {
      // sftp says nothing about how far it is: the file's size on the PC does
      const upload = ssh.upload(input.path, archive);
      let settled = false;
      void upload.finally(() => { settled = true; });
      while (!settled) {
        await Promise.race([upload.catch(() => {}), Bun.sleep(2000)]);
        if (settled) break;
        const size = Number((await ssh.runPowerShell(`(Get-Item ${psQuote(archive)} -ErrorAction SilentlyContinue).Length`).catch(() => "")).trim());
        if (Number.isFinite(size) && size > 0) input.onProgress?.(size);
      }
      await upload;
      input.onProgress?.(asset.size);
      input.onUploaded?.();
    } catch (error) { await cleanup(); throw error; }
    await ssh.runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `$base = ${psQuote(base)}`,
      `$tmp = ${psQuote(stage)}`,
      "try {",
      `  if ((Get-FileHash -Algorithm SHA256 "$tmp\\bundle.tgz").Hash.ToLower() -ne '${asset.sha256}') { throw 'Remote bundle checksum mismatch' }`,
      "  New-Item -ItemType Directory \"$tmp\\runtime\" | Out-Null",
      "  & tar.exe -xzf \"$tmp\\bundle.tgz\" -C \"$tmp\\runtime\"; if ($LASTEXITCODE -ne 0) { throw 'Bundle extraction failed' }",
      "  & \"$tmp\\runtime\\bin\\bun.exe\" --version | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Bundled Bun does not run on this PC' }",
      `  $release = "${release}"`,
      "  if (-not (Test-Path $release)) { Move-Item \"$tmp\\runtime\" $release }",
      `  $current = "${WINDOWS_BUNDLE}"`,
      "  if (Test-Path $current) { if ((Get-Item $current).Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($current) } else { Move-Item $current \"$current-legacy-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())\" } }",
      "  New-Item -ItemType Junction -Path $current -Target $release | Out-Null",
      "} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue; Remove-Item -Force \"$base\\install.lock\" -ErrorAction SilentlyContinue }",
    ].join("\n"), undefined, 10 * 60_000);
  },
  async installHerdr(ssh) {
    // herdr's stable installer (the one its docs give for endpoint-security-blocked PowerShell)
    await ssh.runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      "$tmp = Join-Path $env:TEMP \"herdr-install-$PID\"; New-Item -ItemType Directory -Force $tmp | Out-Null",
      `curl.exe -fsSLo "$tmp\\install.cmd" ${HERDR_INSTALL_CMD}; if ($LASTEXITCODE -ne 0) { throw 'Could not download the herdr installer' }`,
      "& cmd.exe /d /c \"$tmp\\install.cmd\"; if ($LASTEXITCODE -ne 0) { throw 'The herdr installer failed' }",
      "Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue",
    ].join("\n"), undefined, 10 * 60_000);
    const herdr = (await ssh.runPowerShell("Write-Output \"$env:LOCALAPPDATA\\Programs\\Herdr\\bin\\herdr.exe\"")).trim();
    if (!/^[A-Za-z]:\\/.test(herdr)) throw new Error("herdr's installer left no herdr.exe behind");
    return herdr;
  },
  // no SIGTERM on Windows, so the bridge cannot withdraw its descriptor itself; a stale one
  // left here would be found before the next bridge writes its own
  stop: async (ssh, pid) => {
    await ssh.runPowerShell([
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
      `if (Test-Path ${WINDOWS_REGISTRY}) { Get-ChildItem ${WINDOWS_REGISTRY} -Filter *.json | Where-Object { try { (Get-Content $_.FullName -Raw | ConvertFrom-Json).pid -eq ${pid} } catch { $false } } | Remove-Item -Force }`,
      "Write-Output ''",
    ].join("\n"));
  },
  async start(ssh, { session, herdrPath, inspection }) {
    if (!herdrPath) throw new Error("herdr is not installed on this PC");
    const files = windowsBridgeFiles(session);
    // a launcher script: cmd can set the environment and redirect the log without any
    // quoting the WMI command line would have to survive
    const launcher = [
      "@echo off",
      // the paths below are UTF-8: a profile such as C:\Users\홍길동 is lost in an ANSI batch file
      "chcp 65001 >nul",
      `set "HERDR_REMOTE_SESSION=${cmdValue(session ?? "")}"`,
      `set "HERDR_WEB_HERDR_BIN=${cmdValue(herdrPath)}"`,
      `"${cmdValue(`${inspection.runtimeDir}\\bin\\bun.exe`)}" "${cmdValue(`${inspection.runtimeDir}\\server\\remote-entry.ts`)}" >> "${cmdValue(`${inspection.registryDir}\\${files.log}`)}" 2>&1`,
    ];
    await ssh.runPowerShell([
      "$ErrorActionPreference = 'Stop'",
      `$dir = "${WINDOWS_REGISTRY}"; New-Item -ItemType Directory -Force $dir | Out-Null`,
      // one literal per line: WriteAllLines ends each with the CRLF cmd expects
      `[IO.File]::WriteAllLines("$dir\\${files.launcher}", [string[]]@(${launcher.map(psQuote).join(", ")}), (New-Object Text.UTF8Encoding $false))`,
      // not Start-Process: that child belongs to the SSH session's job and dies with it
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /d /c \`"$dir\\${files.launcher}\`""; CurrentDirectory = $env:USERPROFILE }`,
      "if ($r.ReturnValue -ne 0) { throw \"Could not start the bridge (Win32_Process.Create returned $($r.ReturnValue))\" }",
    ].join("\n"));
  },
  async descriptors(ssh) {
    return parseDescriptors((await ssh.runPowerShell(WINDOWS_DESCRIPTORS)).split("\n"));
  },
};

/**
 * Which shell the PC answers to. sh first (every Linux and macOS host); a host that
 * cannot run it is asked in PowerShell, and one that answers neither gets sh's own error,
 * which names the real problem (a refused connection, a wrong key).
 */
export async function detectHost(ssh: SshConnection, session?: string): Promise<{ host: RemoteHost; inspection: HostInspection }> {
  let posixError: unknown;
  try { return { host: posixHost, inspection: await posixHost.inspect(ssh, session) }; }
  catch (error) { posixError = error; }
  try { return { host: windowsHost, inspection: await windowsHost.inspect(ssh, session) }; }
  catch (error) {
    if (error instanceof Error && error.message === UNSUPPORTED_HOST) throw error;
    throw posixError instanceof Error ? posixError : new Error(String(posixError));
  }
}
