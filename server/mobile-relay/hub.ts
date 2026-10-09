import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
export type Role = "device" | "viewer";
export interface Peer { send(data: string | Uint8Array): unknown; close(code?: number, reason?: string): void }
export interface Input { type: "input"; streamId: string; seq: number; expiresAt: number; action: "tap" | "swipe" | "home" | "back"; x?: number; y?: number; x2?: number; y2?: number }
const hash = (s: string) => createHash("sha256").update(s).digest();
/** One enrolled device per hub. Never persist media, input, or credentials. */
export class MobileRelayHub {
  private credentials: Record<Role, Buffer>;
  private peers: Partial<Record<Role, Peer>> = {};
  private streamId = randomUUID();
  private lastSeq = 0;
  private active = false;
  private inputAllowed = false;
  private lastFrameAt = 0;
  private lastInputAt = 0;
  private revoked = false;
  constructor(deviceToken: string, viewerToken: string, private expiresAt: number, private now = Date.now, private onRevoke: () => void = () => {}) {
    if (deviceToken.length < 43 || viewerToken.length < 43 || deviceToken === viewerToken) throw new Error("Distinct 256-bit credentials required");
    this.credentials = { device: hash(deviceToken), viewer: hash(viewerToken) };
  }
  authenticate(role: string, bearer: string): role is Role {
    return !this.revoked && this.now() < this.expiresAt && (role === "device" || role === "viewer") && timingSafeEqual(this.credentials[role], hash(bearer));
  }
  attach(role: Role, peer: Peer) {
    if (this.revoked || this.now() >= this.expiresAt) { peer.close(1008, "Enrollment expired"); return; }
    if (role === "device") { this.active = false; this.inputAllowed = false; }
    const old = this.peers[role]; this.peers[role] = peer; old?.close(1000, "Replaced");
    this.rotate();
  }
  detach(role: Role, peer: Peer) {
    if (this.peers[role] !== peer) return;
    delete this.peers[role]; this.active = false; this.rotate();
  }
  private rotate() {
    this.streamId = randomUUID(); this.lastSeq = 0;
    const state = JSON.stringify({ type: "session", streamId: this.streamId, connected: Boolean(this.peers.device && this.peers.viewer), sharing: this.active });
    for (const peer of Object.values(this.peers)) peer.send(state);
  }
  receive(role: Role, peer: Peer, message: string | Uint8Array): boolean {
    if (this.peers[role] !== peer || this.revoked || this.now() >= this.expiresAt) { peer.close(1008, "Unauthorized"); return false; }
    if (typeof message !== "string") {
      if (role !== "device" || !this.active || message.byteLength > 1_048_576 || message.byteLength < 4) return false;
      if (this.now() - this.lastFrameAt < 150) return false;
      this.lastFrameAt = this.now();
      if (message[0] !== 0xff || message[1] !== 0xd8) return false;
      this.peers.viewer?.send(message); return true;
    }
    if (message.length > 4096) return false;
    let data: any; try { data = JSON.parse(message); } catch { return false; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    if (role === "viewer" && data.type === "revoke") { this.revoke(); return true; }
    if (role === "device" && data.type === "status") {
      this.active = data.sharing === true; this.inputAllowed = data.inputAllowed === true;
      this.peers.viewer?.send(JSON.stringify({ type: "status", sharing: this.active, inputAllowed: data.inputAllowed === true, consentNeeded: !this.active }));
      return true;
    }
    if (role !== "viewer" || data.type !== "input" || !this.active || !this.inputAllowed || !this.peers.device) return false;
    const now = this.now();
    if (data.streamId !== this.streamId || !Number.isSafeInteger(data.seq) || data.seq <= this.lastSeq || !Number.isSafeInteger(data.expiresAt) || data.expiresAt < now || data.expiresAt > now + 2000 || now - this.lastInputAt < 30) return false;
    if (!["tap", "swipe", "home", "back"].includes(data.action)) return false;
    const keys = data.action === "tap" ? ["x", "y"] : data.action === "swipe" ? ["x", "y", "x2", "y2"] : [];
    for (const key of keys) if (!Number.isFinite(data[key]) || data[key] < 0 || data[key] > 1) return false;
    const clean: Record<string, unknown> = { type: "input", streamId: this.streamId, seq: data.seq, expiresAt: data.expiresAt, action: data.action };
    for (const key of keys) clean[key] = data[key];
    this.lastSeq = data.seq; this.lastInputAt = now;
    this.peers.device.send(JSON.stringify(clean)); return true;
  }
  revoke() { this.onRevoke(); this.revoked = true; this.active = false; this.peers.viewer?.send(JSON.stringify({ type: "revoked" })); for (const peer of Object.values(this.peers)) peer.close(1008, "Revoked"); this.peers = {}; }
  close() { this.active = false; for (const peer of Object.values(this.peers)) peer.close(1001, "Stopped"); this.peers = {}; }
}
