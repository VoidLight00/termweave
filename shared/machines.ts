import type { HealthAuth, ServerMessage, SessionSnapshot } from "./protocol.ts";

export const LOCAL_MACHINE = "local";
export const BRIDGE_PROTOCOL = 1;
export const REMOTE_BUNDLE_VERSION = "12";
export interface PaneTarget { machine_id: string; pane_id: string }
export type MachineState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
export interface SshTarget {
  destination: string;
  port?: number;
  identity_file?: string;
  session?: string;
}
export interface Machine {
  id: string;
  name: string;
  kind: "local" | "ssh";
  target?: SshTarget;
  enabled: boolean;
  state: MachineState;
  error: string | null;
  /** set when retrying cannot help: the user has to update the remote bridge or approve setup */
  action_required?: MachineAction | null;
  /** a bridge update running for this PC right now (in the background, or from its dialog) */
  updating?: MachineUpdate | null;
  snapshot: SessionSnapshot | null;
  herdr?: HerdrIdentity;
}
/**
 * The herdr behind a PC, as its bridge can serve it. terminal_attach is false on a Windows
 * host: herdr has no `terminal attach` there yet (herdrdev/herdr#4821), and it is false on
 * any bridge whose runtime cannot run the PTY sidecar (the win32 bundle ships none). Such a
 * PC's panes have the chat lens and a terminal lens without attach (terminal_mirror). Absent on
 * older bridges, which are never Windows.
 */
export interface HerdrIdentity {
  version: string;
  protocol: number;
  terminal_attach?: boolean;
  /**
   * without attach the terminal lens still exists: herdr's session control streams each pane
   * (server/herdr/terminal-session.ts; its input-ready says `session`), and a pane where that
   * cannot start shows its screen repainted a few times a second (server/mirror.ts). Which one a
   * pane got is told per pane, not here: the fallback is decided as it is attached.
   */
  terminal_mirror?: boolean;
}
export type MachineAction = "update_bridge" | "setup";
export interface MachineUpdate { job_id: string; step: string; progress: SetupProgress | null }
/**
 * Where a bridge install is. download (the web server fetching the bundle) and upload (the
 * bundle going to the PC over SSH) count bytes; install and restart have no size.
 * rate is bytes per second over the stage so far; elapsed_ms is how long the stage has run.
 */
export interface SetupProgress { stage: "download" | "upload" | "install" | "restart"; done: number; total: number | null; rate: number | null; elapsed_ms: number }
/** Server-side PC preferences (machine-settings.json in the state directory). */
export interface MachineSettings { auto_update_bridges: boolean }
export interface SetupRequest extends SshTarget { name?: string; machine_id?: string; update_remote?: boolean }
export type SetupPhase = "connecting" | "authentication" | "checking" | "approval" | "installing" | "starting" | "connected" | "failed" | "cancelled";
export interface SetupChallenge { id: string; kind: "host_key" | "secret"; prompt: string }
export interface SetupJob {
  id: string;
  machine_id: string;
  phase: SetupPhase;
  step: string;
  challenge: SetupChallenge | null;
  installations: string[];
  error: string | null;
  /**
   * ssh's latest stderr lines while the connection is being made, null otherwise. Some of them
   * ask the user to act while ssh keeps waiting (Tailscale SSH's browser check URL).
   */
  ssh_output: string | null;
  target: SshTarget;
  progress?: SetupProgress | null;
}
export type SetupAction = { action: "answer"; challenge_id: string; answer: string } | { action: "approve" } | { action: "cancel" };
export type MachineEvent = { type: "machines"; machines: Machine[] } | { type: "machine-message"; machine_id: string; message: ServerMessage };
/**
 * The owned lifecycle's stop request (scripts/install-lifecycle.ts stop, the owned launcher's Ctrl+C). The server has it only when
 * its launcher handed it a stop token, and answers a loopback CLI alone: POST, its own port in Host, no Origin or Sec-Fetch-Site
 * (even same-origin), and that token in OWNED_STOP_HEADER. The token never goes in a URL.
 */
export const OWNED_STOP_PATH = "/api/lifecycle/stop";
export const OWNED_STOP_HEADER = "x-termweave-stop-token";
/** Bridge liveness, never waiting for herdr; boot_id is this launch's HERDR_WEB_BOOT_ID (null when launched without one). */
export interface BridgeHealth { ok: true; auth: HealthAuth; bridge_protocol: number; boot_id: string | null }
export interface BridgeIdentity {
  pid: number;
  managed_remote: boolean;
  bridge_protocol: number;
  bundle_version: string;
  socket_path: string;
  socket_id: string;
  herdr: HerdrIdentity;
}

/** Local storage keeps its historical keys; remote IDs occupy a separate namespace. */
export function paneStorageId(machineId: string, paneId: string): string {
  return machineId === LOCAL_MACHINE ? paneId : `remote:${encodeURIComponent(machineId)}:${encodeURIComponent(paneId)}`;
}
export function machinePath(machineId: string, path: string): string {
  return machineId === LOCAL_MACHINE ? `/api/${path}` : `/api/machines/${encodeURIComponent(machineId)}/${path}`;
}
