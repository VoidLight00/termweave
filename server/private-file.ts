/**
 * A state file that holds a secret (an API key, a private key): readable by its owner only, and written whole, so a crash
 * mid-write never leaves half a key. POSIX: mode 0600. Windows has no mode bits (Node reports 0666 for every writable file):
 * the temporary file is created by CreateFileW with a protected DACL granting only the current user and SYSTEM, so it never
 * exists with an inherited ACE, and it stays open unshared (share mode 0) while the secret is written through that handle.
 * The DACL is read back from the handle before the rename and from the final file after it; anything but exactly
 * {user, SYSTEM} full access, inheritance off, fails the write. What this does not cover: principals whose privileges bypass a
 * DACL (backup/restore, take ownership), a parent directory that lets other users delete or replace the file (integrity, not
 * disclosure), and files written by older builds, which keep their ACL until next rewritten. Without bun:ffi it refuses.
 */
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SYSTEM_SID = "S-1-5-18";
const GENERIC_WRITE = 0x4000_0000, READ_CONTROL = 0x2_0000, CREATE_NEW = 1, FILE_ATTRIBUTE_NORMAL = 0x80, INVALID_HANDLE = -1n;
const TOKEN_QUERY = 0x8, TOKEN_USER_CLASS = 1, CURRENT_PROCESS = -1n, SDDL_REVISION_1 = 1;
const SE_FILE_OBJECT = 1, DACL_SECURITY_INFORMATION = 0x4, SE_DACL_PROTECTED = 0x1000, ACCESS_ALLOWED_ACE_TYPE = 0, FILE_ALL_ACCESS = 0x1f_01ff;

/** Test-only observation points of the Windows write (server/private-file.test.ts); production callers pass none. */
export interface PrivateFileSeam { created?(temporary: string): void; renamed?(path: string): void }

let win32: ReturnType<typeof openWin32> | undefined;
/** 64-bit Windows (x64 and ARM64 share these LLP64 signatures); handles are i64 as in scripts/release/activate.ts. */
function openWin32() {
  const kernel32 = dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
    WriteFile: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    FlushFileBuffers: { args: [FFIType.i64], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
    lstrlenW: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [FFIType.i64, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    GetTokenInformation: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetSecurityInfo: { args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    GetNamedSecurityInfoW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    GetSecurityDescriptorControl: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  return { ...kernel32, ...advapi32 };
}
type Win32 = ReturnType<typeof openWin32>;

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");

/** The S-1-… spelling of the SID at `sid` (never an SDDL alias such as SY or LA). */
function sidString(api: Win32, sid: bigint): string {
  const out = new BigUint64Array(1);
  if (!api.ConvertSidToStringSidW(sid, out)) throw new Error("ConvertSidToStringSidW failed");
  try { return Buffer.from(toArrayBuffer(out[0]!, 0, api.lstrlenW(out[0]!) * 2)).toString("utf16le"); } finally { api.LocalFree(out[0]!); }
}

let userSid: string | undefined;
/** The user SID of this process's token, read in-process (no `whoami` spawn). */
function currentUserSid(api: Win32): string {
  if (userSid) return userSid;
  const token = new BigUint64Array(1);
  if (!api.OpenProcessToken(CURRENT_PROCESS, TOKEN_QUERY, token)) throw new Error("The current user's SID is unavailable; refusing to write a private file");
  try {
    // TOKEN_USER { SID_AND_ATTRIBUTES { PSID Sid @0, DWORD Attributes @8 } } followed by the SID it points to; a SID is at most 68 bytes
    const info = new BigUint64Array(32), needed = new Uint32Array(1);
    if (!api.GetTokenInformation(token[0]!, TOKEN_USER_CLASS, info, info.byteLength, needed)) throw new Error("The current user's SID is unavailable; refusing to write a private file");
    return userSid = sidString(api, info[0]!);
  } finally { api.CloseHandle(token[0]!); }
}

/** Why the DACL read back is not exactly {`sids`} full access with inheritance off, or undefined when it is. */
function daclProblem(api: Win32, descriptor: bigint, dacl: bigint, sids: string[]): string | undefined {
  const control = new Uint16Array(1), revision = new Uint32Array(1);
  if (!api.GetSecurityDescriptorControl(descriptor, control, revision)) return "unreadable security descriptor";
  if (!(control[0]! & SE_DACL_PROTECTED)) return "inheritance is on";
  if (!dacl) return "no DACL, which grants everyone";
  // ACL header: AclRevision u8, Sbz1 u8, AclSize u16 @2, AceCount u16 @4, Sbz2 u16; then ACEs of { AceType u8, AceFlags u8, AceSize u16, Mask u32, SID @8 }
  const size = new DataView(toArrayBuffer(dacl, 0, 8)).getUint16(2, true), acl = new DataView(toArrayBuffer(dacl, 0, size));
  const seen: string[] = [];
  for (let index = 0, at = 8; index < acl.getUint16(4, true); index++) {
    const aceSize = at + 8 <= size ? acl.getUint16(at + 2, true) : 0;
    if (aceSize < 16 || at + aceSize > size) return "a malformed ACE";
    if (acl.getUint8(at) !== ACCESS_ALLOWED_ACE_TYPE || acl.getUint8(at + 1) !== 0 || acl.getUint32(at + 4, true) !== FILE_ALL_ACCESS) return `ACE ${index} is not a plain full-access allow`;
    seen.push(sidString(api, dacl + BigInt(at + 8)));
    at += aceSize;
  }
  const expected = [...new Set(sids)].sort();
  return seen.sort().join() === expected.join() ? undefined : `ACEs for ${seen.join(", ") || "nobody"}`;
}

/** Reads a DACL through `query` (GetSecurityInfo or GetNamedSecurityInfoW) and judges it; the descriptor is freed on every path. */
function readBack(api: Win32, sids: string[], query: (dacl: BigUint64Array, descriptor: BigUint64Array) => number): string | undefined {
  const dacl = new BigUint64Array(1), descriptor = new BigUint64Array(1);
  const status = query(dacl, descriptor);
  if (status !== 0) return `DACL unreadable (error ${status})`;
  try { return daclProblem(api, descriptor[0]!, dacl[0]!, sids); } finally { api.LocalFree(descriptor[0]!); }
}

/** CREATE_NEW with the protected owner-only descriptor in the same call, writable and unshared: no window without the DACL. */
function createProtected(api: Win32, path: string, sids: string[]): bigint {
  const sddl = `D:P${[...new Set(sids)].map((sid) => `(A;;FA;;;${sid})`).join("")}`, descriptor = new BigUint64Array(1);
  if (!api.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), SDDL_REVISION_1, descriptor, null)) throw new Error("Could not build the private file's security descriptor");
  try {
    // SECURITY_ATTRIBUTES (64-bit): nLength u32 @0, lpSecurityDescriptor @8, bInheritHandle u32 @16
    const attributes = new DataView(new ArrayBuffer(24));
    attributes.setUint32(0, 24, true);
    attributes.setBigUint64(8, descriptor[0]!, true);
    const handle = api.CreateFileW(wide(path), GENERIC_WRITE | READ_CONTROL, 0, new Uint8Array(attributes.buffer), CREATE_NEW, FILE_ATTRIBUTE_NORMAL, null);
    if (handle === INVALID_HANDLE) throw new Error(`Could not create the private file ${path}`);
    return handle;
  } finally { api.LocalFree(descriptor[0]!); }
}

function writeAll(api: Win32, handle: bigint, bytes: Buffer): void {
  const written = new Uint32Array(1);
  for (let at = 0; at < bytes.length; at += written[0]!) {
    if (!api.WriteFile(handle, bytes.subarray(at), Math.min(bytes.length - at, 0x4000_0000), written, null) || written[0] === 0) throw new Error("Could not write the private file");
  }
}

/**
 * Writes `content` to `path` owner-only and whole (a temporary file renamed over it). Throws, leaving no file and any previous
 * secret as it was, when the temporary cannot be protected; a final file that fails the read-back after the rename is deleted.
 */
export function writePrivateFile(path: string, content: string, seam: PrivateFileSeam = {}): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  if (process.platform !== "win32") {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    return;
  }
  let api: Win32;
  try { api = win32 ??= openWin32(); } catch (error) { throw new Error(`Windows security APIs are unavailable (${(error as Error).message}); refusing to write a private file`); }
  const sids = [currentUserSid(api), SYSTEM_SID];
  // a leftover of a crashed write is not ours to reuse: CREATE_NEW fails rather than open a file someone else may hold
  rmSync(temporary, { force: true });
  const handle = createProtected(api, temporary, sids);
  let renamed = false;
  try {
    try {
      seam.created?.(temporary);
      writeAll(api, handle, Buffer.from(content, "utf8"));
      if (!api.FlushFileBuffers(handle)) throw new Error("Could not flush the private file");
      const problem = readBack(api, sids, (dacl, descriptor) => api.GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, dacl, null, descriptor));
      if (problem) throw new Error(`The private file is not owner-only (${problem})`);
    } finally { api.CloseHandle(handle); }
    // a rename within the directory keeps the DACL; the read-back below proves it on the name readers open
    renameSync(temporary, path);
    renamed = true;
    seam.renamed?.(path);
    const problem = readBack(api, sids, (dacl, descriptor) => api.GetNamedSecurityInfoW(wide(path), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, null, null, dacl, null, descriptor));
    if (problem) throw new Error(`The private file is not owner-only (${problem})`);
  } catch (error) {
    rmSync(renamed ? path : temporary, { force: true });
    throw error;
  }
}
