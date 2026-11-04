/** Test support: the DACL Windows actually keeps on a file, read and changed with `icacls`, for owner-only assertions (server/private-file.ts), and a scope without the backup privilege that reads through a DACL. */
import { dlopen, FFIType } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { currentUserSid } from "../scripts/owned-install.ts";
import { trusteeSid } from "../scripts/windows-sid.ts";

export interface Dacl { protected: boolean; aces: string[] }

/** icacls.exe from System32 by absolute path, bounded so a wedged ACL call fails the test instead of hanging it. */
function icacls(args: string[]): number | null {
  const root = process.env["SystemRoot"];
  if (!root || !isAbsolute(root)) throw new Error("SystemRoot is required to use icacls");
  const result = spawnSync(join(root, "System32", "icacls.exe"), args, { windowsHide: true, stdio: "ignore", timeout: 15_000 });
  return result.error ? null : result.status;
}

/** A file's DACL: whether inheritance is off (SDDL `P`) and its ACEs, sorted, each trustee alias (`SY`; `LA` for the built-in Administrator) spelled as the SID Windows resolves it to; one it cannot resolve stays as written, so the comparison fails. */
export function fileDacl(path: string): Dacl {
  const scratch = mkdtempSync(join(tmpdir(), "tw-dacl-"));
  try {
    const saved = join(scratch, "acl");
    if (icacls([path, "/save", saved]) !== 0) throw new Error(`icacls /save failed for ${path}`);
    const sddl = readFileSync(saved).toString("utf16le").split(/\r?\n/)[1]?.trim() ?? "";
    const match = /^D:([A-Z]*)((?:\([^()]*\))*)$/.exec(sddl);
    if (!match) throw new Error(`Unexpected SDDL: ${sddl}`);
    const aces = match[2]!.slice(1, -1).split(")(").filter(Boolean).map((ace) => ace.split(";").map((part, index) => index === 5 ? trusteeSid(part) ?? part : part).join(";"));
    return { protected: match[1]!.includes("P"), aces: aces.sort() };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Corrupts a file's DACL the way a careless tool would: Everyone (S-1-1-0) gets read access next to the owner-only ACEs. */
export function grantEveryoneRead(path: string): void {
  if (icacls([path, "/grant", "*S-1-1-0:R"]) !== 0) throw new Error(`icacls /grant failed for ${path}`);
}

/** What server/private-file.ts promises on Windows: inheritance off, full control for the current user and SYSTEM, nothing else. */
export const ownerOnlyDacl = (): Dacl => ({ protected: true, aces: [`A;;FA;;;${currentUserSid()}`, "A;;FA;;;S-1-5-18"].sort() });

const TOKEN_ADJUST_PRIVILEGES = 0x20, TOKEN_QUERY = 0x8, SE_PRIVILEGE_ENABLED = 0x2, CURRENT_PROCESS = -1n;
let tokenApi: ReturnType<typeof openTokenApi> | undefined;
function openTokenApi() {
  const kernel32 = dlopen("kernel32.dll", { CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 } }).symbols;
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    LookupPrivilegeValueW: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    AdjustTokenPrivileges: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  return { ...kernel32, ...advapi32 };
}

/**
 * Runs `body` with this process's SeBackupPrivilege disabled, restoring it after. Windows opens every directory with backup intent,
 * so a token holding that privilege enabled (an elevated administrator, as on GitHub's windows runner) lists a directory through any
 * deny ACE, the way root reads anything on POSIX. Reports whether it was enabled, for the assertion to show; off Windows it only runs `body`.
 */
export async function withoutBackupPrivilege<T>(body: () => Promise<T>): Promise<{ backupPrivilegeWasEnabled: boolean; answer: T }> {
  if (process.platform !== "win32") return { backupPrivilegeWasEnabled: false, answer: await body() };
  const api = tokenApi ??= openTokenApi(), token = new BigUint64Array(1);
  if (!api.OpenProcessToken(CURRENT_PROCESS, TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, token)) throw new Error("OpenProcessToken failed");
  try {
    // TOKEN_PRIVILEGES with one entry: PrivilegeCount u32 @0, LUID { LowPart u32 @4, HighPart i32 @8 }, Attributes u32 @12
    const disable = new DataView(new ArrayBuffer(16)), previous = new DataView(new ArrayBuffer(16)), size = new Uint32Array(1);
    if (!api.LookupPrivilegeValueW(null, Buffer.from("SeBackupPrivilege\0", "utf16le"), new Uint8Array(disable.buffer, 4, 8))) throw new Error("LookupPrivilegeValueW failed");
    disable.setUint32(0, 1, true);
    if (!api.AdjustTokenPrivileges(token[0]!, 0, new Uint8Array(disable.buffer), 16, new Uint8Array(previous.buffer), size)) throw new Error("AdjustTokenPrivileges failed");
    // PreviousState lists only what the call changed: nothing when the privilege is not held or was already disabled
    const backupPrivilegeWasEnabled = previous.getUint32(0, true) === 1 && (previous.getUint32(12, true) & SE_PRIVILEGE_ENABLED) !== 0;
    try { return { backupPrivilegeWasEnabled, answer: await body() }; }
    finally { if (backupPrivilegeWasEnabled && !api.AdjustTokenPrivileges(token[0]!, 0, new Uint8Array(previous.buffer), 0, null, null)) throw new Error("Could not restore SeBackupPrivilege"); }
  } finally { api.CloseHandle(token[0]!); }
}
