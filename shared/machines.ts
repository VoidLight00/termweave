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
 * PC's panes have the chat lens and a mirrored terminal (terminal_mirror). Absent on older
 * bridges, which are never Windows.
 */
export interface HerdrIdentity {
  version: string;
  protocol: number;
  terminal_attach?: boolean;
  /** without attach, the terminal lens shows the pane's screen repainted a few times a second (server/mirror.ts) */
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
export interface BridgeHealth { ok: true; auth: HealthAuth; bridge_protocol: number }
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
