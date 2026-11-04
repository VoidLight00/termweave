import { dlopen, FFIType, ptr } from "bun:ffi";

/**
 * One process of this PC as the kernel reports it, read in-process through ntdll (no PowerShell/CIM spawn, which costs a second
 * or more per query and several under load). Every call returns an NTSTATUS, so no thread-local last error is read afterwards.
 * `gone` only when the kernel says no process has that id (STATUS_INVALID_CID, what OpenProcess reports as ERROR_INVALID_PARAMETER),
 * the process has exited (CIM no longer lists it then either) or the kernel opened another PID; `denied` and `error` never prove a free PID.
 */
export type WindowsProcessInfo =
  | { state: "alive"; pid: number; createdTicks: bigint; parentPid: number; exe?: string; commandLine?: string }
  | { state: "gone" | "denied" | "error"; pid: number; detail: string };

/** PROCESS_QUERY_LIMITED_INFORMATION: the least access that answers every class read here, granted for other users' processes too. */
const QUERY_LIMITED = 0x1000;
export const STATUS_INVALID_CID = 0xc000000b, STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
/** PROCESSINFOCLASS values. */
const BASIC = 0, TIMES = 4, IMAGE_WIN32 = 43, COMMAND_LINE = 60;
/** 100 ns ticks between 1601-01-01 (FILETIME) and 1970-01-01. */
const EPOCH_TICKS = 116_444_736_000_000_000n;

let ntdll: ReturnType<typeof openNtdll> | undefined;
function openNtdll() {
  return dlopen("ntdll.dll", {
    NtOpenProcess: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    NtQueryInformationProcess: { args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    NtClose: { args: [FFIType.u64], returns: FFIType.u32 },
  }).symbols;
}
const hex = (status: number) => `0x${(status >>> 0).toString(16).padStart(8, "0")}`;

/** The raw kernel answers for one PID: the open status, then (after a successful open) both query statuses and what they returned. */
export type KernelReading = { pid: number; opened: number; timed?: number; exitTime?: bigint; based?: number; uniqueProcessId?: bigint };
/**
 * Pure: the non-alive state a reading proves, or undefined when it describes the live process `pid`. Only an open refused with
 * STATUS_INVALID_CID, a nonzero ExitTime or a kernel that opened another PID (it ignores the low 2 bits, so 4n+k opens 4n) is `gone`;
 * STATUS_ACCESS_DENIED is `denied` and any other failure `error`.
 */
export function kernelVerdict(reading: KernelReading): { state: "gone" | "denied" | "error"; detail: string } | undefined {
  const failed = (status: number, what: string) => ({ state: status >>> 0 === STATUS_ACCESS_DENIED ? "denied" as const : "error" as const, detail: `${what} ${hex(status)}` });
  const { pid, opened, timed = 0, exitTime = 0n, based = 0, uniqueProcessId = BigInt(pid) } = reading;
  if (opened >>> 0 === STATUS_INVALID_CID) return { state: "gone", detail: "no such process" };
  if (opened !== 0) return failed(opened, "NtOpenProcess");
  if (timed !== 0) return failed(timed, "process times");
  if (exitTime !== 0n) return { state: "gone", detail: "exited" };
  if (based !== 0) return failed(based, "basic information");
  if (uniqueProcessId !== BigInt(pid)) return { state: "gone", detail: `no such process (the kernel opened pid ${uniqueProcessId})` };
  return undefined;
}

/** A UNICODE_STRING class (image path, command line): the string the kernel wrote into our buffer, or undefined where it refuses. */
function unicodeClass(api: NonNullable<typeof ntdll>, handle: bigint, infoClass: number): string | undefined {
  let buffer = new Uint8Array(4096);
  const needed = new Uint32Array(1);
  for (let attempt = 0; attempt < 3; attempt++) {
    const status = api.NtQueryInformationProcess(handle, infoClass, ptr(buffer), buffer.length, ptr(needed)) >>> 0;
    if (status === STATUS_INFO_LENGTH_MISMATCH && needed[0]! > buffer.length) { buffer = new Uint8Array(needed[0]!); continue; }
    if (status !== 0) return undefined;
    // 64-bit (x64 and ARM64) UNICODE_STRING: Length (bytes) @0, Buffer @8, pointing into this same buffer
    const view = new DataView(buffer.buffer), length = view.getUint16(0, true), at = Number(view.getBigUint64(8, true)) - ptr(buffer);
    if (length === 0) return undefined;
    if (at < 16 || at + length > buffer.length) return undefined;
    return Buffer.from(buffer.buffer, at, length).toString("utf16le");
  }
  return undefined;
}

export function windowsProcessInfo(pid: number): WindowsProcessInfo {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "error", pid, detail: `invalid pid ${pid}` };
  try {
    const api = ntdll ??= openNtdll();
    // 64-bit (x64 and ARM64) OBJECT_ATTRIBUTES (48 bytes, only Length set) and CLIENT_ID { UniqueProcess = pid, UniqueThread = 0 }
    const handleOut = new BigUint64Array(1), attributes = new Uint8Array(48), client = new BigUint64Array([BigInt(pid), 0n]);
    new DataView(attributes.buffer).setUint32(0, attributes.length, true);
    const opened = api.NtOpenProcess(ptr(handleOut), QUERY_LIMITED, ptr(attributes), ptr(client)) >>> 0;
    if (opened !== 0) return { pid, ...kernelVerdict({ pid, opened })! };
    const handle = handleOut[0]!;
    try {
      const length = new Uint32Array(1);
      // KERNEL_USER_TIMES: CreateTime, ExitTime, KernelTime, UserTime
      const times = new BigUint64Array(4);
      const timed = api.NtQueryInformationProcess(handle, TIMES, ptr(times), 32, ptr(length)) >>> 0;
      // 64-bit (x64 and ARM64) PROCESS_BASIC_INFORMATION: ..., UniqueProcessId @32, InheritedFromUniqueProcessId @40
      const basic = new BigUint64Array(6);
      const based = api.NtQueryInformationProcess(handle, BASIC, ptr(basic), 48, ptr(length)) >>> 0;
      const verdict = kernelVerdict({ pid, opened, timed, exitTime: times[1]!, based, uniqueProcessId: basic[4]! });
      if (verdict) return { pid, ...verdict };
      const exe = unicodeClass(api, handle, IMAGE_WIN32), commandLine = unicodeClass(api, handle, COMMAND_LINE);
      return { state: "alive", pid, createdTicks: times[0]!, parentPid: Number(basic[5]!), ...(exe === undefined ? {} : { exe }), ...(commandLine === undefined ? {} : { commandLine }) };
    } finally { api.NtClose(handle); }
  } catch (error) { return { state: "error", pid, detail: String((error as Error).message) }; }
}

/** Creation time in ms since 1970. */
export const createdMs = (ticks: bigint) => Number((ticks - EPOCH_TICKS) / 10_000n);

/**
 * Creation time as CIM's Win32_Process CreationDate.ToUniversalTime().ToString('o') spells it: CIM carries microseconds, so the
 * seventh fractional digit is always 0. The manual recovery command and the acceptance tool compare this token against CIM.
 */
export function createdIso(ticks: bigint): string {
  const micros = (ticks - EPOCH_TICKS) / 10n;
  return `${new Date(Number(micros / 1000n)).toISOString().slice(0, 19)}.${String(micros % 1_000_000n).padStart(6, "0")}0Z`;
}
