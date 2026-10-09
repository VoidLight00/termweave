/**
 * Paired devices: the per-device credential a phone (or anyone the owner lets in) uses
 * instead of the shared token. The owner starts a pairing on the PC and gets a short code
 * that lives ten minutes; the device sends the code once and receives a token of its own
 * in an HttpOnly cookie. Only a hash of that token is stored, so devices.json in the state
 * dir (0600, written whole) reveals nothing if read. Revocation also closes that device's
 * active streams. A device is either allowed to drive (type, answer, manage) or only to watch.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceRole, PairedDevice } from "../shared/protocol.ts";
import type { Access } from "./access.ts";
import { deviceCookie, isSecureRequest, noContent } from "./auth.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";

const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const LAST_SEEN_WRITE_MS = 60_000;
const LABEL_MAX = 48;

interface StoredDevice {
  id: string;
  label: string;
  role: DeviceRole;
  token_hash: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface PairingCode {
  code: string;
  expires_at: string;
}

/** What a request's device cookie resolved to. */
export interface DeviceMatch {
  id: string;
  label: string;
  role: DeviceRole;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function normalizeLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  return label || fallback;
}

export function isDeviceRole(value: unknown): value is DeviceRole {
  return value === "drive" || value === "watch";
}

/** Owner-only, and written whole: a crash mid-write must not leave half a device list. */
function writeJsonPrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export class DeviceStore {
  private devices: StoredDevice[] = [];
  /** when the first device was paired: from then on, only this PC, the owner's login, a device or the token get in */
  private gateClosedAt: string | null = null;
  private pending: { code: string; expires: number; attempts: number } | null = null;
  private readonly path: string;
  private readonly revocations = new Map<string, Set<() => void>>();
  readonly error: string | null = null;

  constructor(stateDir: string) {
    this.path = join(stateDir, "devices.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!isJsonObject(parsed) || !Array.isArray(parsed.devices)
        || !(parsed.gate_closed_at === null || typeof parsed.gate_closed_at === "string")
        || !parsed.devices.every((d) => isJsonObject(d) && typeof d.id === "string"
          && typeof d.token_hash === "string" && isDeviceRole(d.role)
          && typeof d.label === "string" && typeof d.created_at === "string"
          && (d.last_seen_at === null || typeof d.last_seen_at === "string"))) {
        throw new Error("invalid device registry");
      }
      this.gateClosedAt = parsed.gate_closed_at;
      this.devices = parsed.devices as StoredDevice[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // A damaged registry is not a first installation. Keep it intact for recovery and
      // let the existing local/token/Tailscale routes provide access to the owner.
      this.error = `Cannot read ${this.path}. Restore a valid devices.json or fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
      console.error(this.error);
    }
  }

  /**
   * Whether the gate is closed to strangers: it is from the first pairing on, and stays so when
   * every device is revoked (revoking must never reopen the LAN); this PC itself always gets in.
   */
  get gated(): boolean {
    return this.error !== null || this.gateClosedAt !== null || this.devices.length > 0;
  }

  /** Called immediately for an already-revoked identity, including an upgrade still in flight. */
  onRevoke(id: string, close: () => void): () => void {
    if (!this.devices.some((device) => device.id === id)) { close(); return () => {}; }
    const listeners = this.revocations.get(id) ?? new Set<() => void>();
    listeners.add(close);
    this.revocations.set(id, listeners);
    return () => {
      listeners.delete(close);
      if (listeners.size === 0) this.revocations.delete(id);
    };
  }

  private assertWritable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  list(currentId: string | null): PairedDevice[] {
    return this.devices.map((d) => ({ id: d.id, label: d.label, role: d.role, created_at: d.created_at, last_seen_at: d.last_seen_at, current: d.id === currentId }));
  }

  /** A fresh six-digit code, replacing any code still pending. */
  startPairing(now = Date.now()): PairingCode {
    this.assertWritable();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pending = { code, expires: now + CODE_TTL_MS, attempts: 0 };
    return { code, expires_at: new Date(this.pending.expires).toISOString() };
  }

  /** `{ token }` when the code is right; null when it is wrong, spent or expired. */
  pair(code: string, label: string, role: DeviceRole, now = Date.now()): { token: string; device: DeviceMatch } | null {
    this.assertWritable();
    const pending = this.pending;
    if (pending === null || now > pending.expires) { this.pending = null; return null; }
    if (!same(code.replace(/\D/g, ""), pending.code)) {
      pending.attempts += 1;
      if (pending.attempts >= CODE_ATTEMPTS) this.pending = null;
      return null;
    }
    const token = randomBytes(32).toString("hex");
    const device: StoredDevice = { id: randomBytes(8).toString("hex"), label, role, token_hash: hash(token), created_at: new Date(now).toISOString(), last_seen_at: null };
    const next = [...this.devices, device];
    const gate = this.gateClosedAt ?? device.created_at;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    this.pending = null;
    return { token, device: { id: device.id, label: device.label, role: device.role } };
  }

  /** The device a cookie token belongs to, noting when it was last seen (at most once a minute on disk). */
  match(token: string | undefined, now = Date.now()): DeviceMatch | null {
    if (!token) return null;
    const digest = hash(token);
    for (const device of this.devices) {
      if (!same(digest, device.token_hash)) continue;
      const seen = device.last_seen_at === null ? 0 : Date.parse(device.last_seen_at);
      if (now - seen >= LAST_SEEN_WRITE_MS) {
        try {
          const next = this.devices.map((d) => d === device ? { ...d, last_seen_at: new Date(now).toISOString() } : d);
          this.save(next);
          this.devices = next;
        } catch { /* last-seen telemetry must not deny an otherwise valid credential */ }
      }
      return { id: device.id, label: device.label, role: device.role };
    }
    return null;
  }

  update(id: string, patch: { label?: string; role?: DeviceRole }): PairedDevice | null {
    this.assertWritable();
    const device = this.devices.find((d) => d.id === id);
    if (!device) return null;
    const updated = { ...device, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.role === undefined ? {} : { role: patch.role }) };
    const next = this.devices.map((d) => d === device ? updated : d);
    this.save(next);
    this.devices = next;
    return { id: updated.id, label: updated.label, role: updated.role, created_at: updated.created_at, last_seen_at: updated.last_seen_at, current: false };
  }

  revoke(id: string): boolean {
    this.assertWritable();
    const next = this.devices.filter((d) => d.id !== id);
    if (next.length === this.devices.length) return false;
    this.save(next);
    this.devices = next;
    const listeners = this.revocations.get(id);
    this.revocations.delete(id);
    for (const close of listeners ?? []) close();
    return true;
  }

  has(id: string): boolean { return this.devices.some((device) => device.id === id); }

  private save(devices = this.devices, gateClosedAt = this.gateClosedAt): void {
    writeJsonPrivate(this.path, { gate_closed_at: gateClosedAt, devices });
  }
}

/**
 * /api/devices*. Pairing itself is public, like /api/auth: it is how a device gets in. The
 * rest reaches here only through the gate in index.ts, and anything that changes the list
 * needs the app's own mutation guard (same origin + X-Herdr-Machine), like the other mutations.
 */
export async function handleDeviceRequest(request: Request, pathname: string, store: DeviceStore, access: Access): Promise<Response> {
  if (store.error !== null) return jsonResponse({ error: { code: "device_store_unavailable", message: access.level === "full" ? store.error : "Device pairing is unavailable; ask the owner to check Settings → Devices on the host." } }, 503);
  const json = async (): Promise<Record<string, unknown> | Response> => {
    try {
      const body = (await request.json()) as unknown;
      return isJsonObject(body) ? body : badRequest("invalid_body", "request body must be a JSON object");
    } catch { return badRequest("invalid_json", "request body must be JSON"); }
  };
  if (pathname === "/api/devices/pair") {
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const body = await json();
    if (body instanceof Response) return body;
    if (typeof body["code"] !== "string") return badRequest("missing_code", "code is required");
    const paired = store.pair(body["code"], normalizeLabel(body["label"], "Device"), "drive");
    if (paired === null) return jsonResponse({ error: { code: "invalid_code", message: "the code is wrong, spent or expired; start a new pairing on the PC" } }, 401);
    return noContent(deviceCookie(paired.token, isSecureRequest(request)));
  }
  if (pathname === "/api/devices") {
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse({ devices: store.list(access.level === "full" ? access.device?.id ?? null : null) }, 200, { "cache-control": "no-store" });
  }
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return jsonResponse({ error: { code: "invalid_origin", message: "Manage devices from this app" } }, 403);
  if (access.level === "full" && access.role === "watch") return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  if (pathname === "/api/devices/pair/start") {
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    return jsonResponse(store.startPairing(), 200, { "cache-control": "no-store" });
  }
  const id = pathname.slice("/api/devices/".length);
  if (!/^[0-9a-f]{16}$/.test(id)) return badRequest("invalid_device", "no such device");
  if (request.method === "DELETE") return store.revoke(id) ? noContent() : jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
  if (request.method === "PATCH") {
    const body = await json();
    if (body instanceof Response) return body;
    const updated = store.update(id, { label: normalizeLabel(body["label"], "Device") });
    return updated ? jsonResponse(updated) : jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
  }
  return badRequest("method_not_allowed", "use PATCH or DELETE");
}
