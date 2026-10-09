import { protectFrontendInput } from "./frontendReloadSafety.ts";
import { machinePath, type BridgeHealth, type HerdrIdentity, type Machine, type SetupAction, type SetupJob, type SetupRequest } from "../../shared/machines.ts";
import type {
  AgentKind,
  DirectoryListing,
  FileInfo,
  ConversationResponse,
  HealthAuth,
  InteractivePrompt,
  OmoActivity,
  PairedDevice,
  PairingCode,
  PaneReadResult,
  PromptAnswer,
  PushKey,
  RemoteAccess,
  SessionSnapshot,
  SlashCommand,
  UsageReport,
  WorkspaceCreated,
} from "../../shared/protocol.ts";
import type { PaneScrollInfo } from "../../shared/herdr-api.generated.ts";
import type { HerdrUpdateStatus, UpdateCommand, UpdateStatus } from "../../shared/update.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { VoiceConfigUpdate, VoiceStatus } from "../../shared/voice.ts";
import { isMoveResult, type PaneMoveRequest, type PaneMoveResult } from "../../shared/paneMove.ts";

/** Settings → Phone: what Tailscale on the server's PC already serves, or the command to run. */
export function fetchRemoteAccess(): Promise<RemoteAccess> {
  return getJson<RemoteAccess>("/api/access");
}

/** The sidebar's plan meters; `refresh` asks the providers again instead of the server's recent answer. */
export function fetchUsage(refresh = false): Promise<UsageReport> {
  return getJson<UsageReport>(refresh ? "/api/usage?refresh=1" : "/api/usage");
}

export function fetchUpdateStatus(): Promise<UpdateStatus> {
  return getJson<UpdateStatus>("/api/updates");
}

export async function requestUpdate(command: UpdateCommand): Promise<void> {
  const url = `/api/updates/${command}`;
  const response = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Settings → Updates: herdr itself, on the PC the server runs on. */
export function fetchHerdrUpdate(): Promise<HerdrUpdateStatus> {
  return getJson<HerdrUpdateStatus>("/api/herdr/update");
}

export async function requestHerdrUpdate(): Promise<void> {
  const url = "/api/herdr/update";
  const response = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/**
 * A non-2xx answer from the herdr-web-ui API. `code` is the server's error-envelope
 * code when it sent one, so callers can branch on `status` (401 = the token gate)
 * without parsing the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(url: string, status: number, detail: string, code: string | null) {
    super(`${url} failed (${status}): ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function errorFrom(url: string, response: Response): Promise<ApiError> {
  let detail = response.statusText;
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) detail = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(url, response.status, detail, code);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as T;
}

export async function fetchSession(machineId = "local"): Promise<SessionSnapshot> {
  const body = await getJson<{ snapshot: SessionSnapshot }>(machinePath(machineId, "session"));
  return body.snapshot;
}

/** PCs whose herdr rejected `recent_unwrapped`: an older herdr, read row by row from then on. */
const wrappedOnly = new Set<string>();

/**
 * GET /api/pane/read as the chat view polls it: herdr's own scrollback (up to
 * `lines`), ANSI-stripped text. herdr owns scrollback — the attach stream cannot
 * serve history, so the transcript reads it back instead. `recent_unwrapped`
 * rejoins the rows the terminal soft-wrapped, so a line reflows to the chat's
 * width instead of breaking where the pty's columns ended.
 */
export async function fetchPaneTranscript(paneId: string, lines: number, machineId = "local"): Promise<PaneReadResult> {
  const read = async (source: "recent" | "recent_unwrapped"): Promise<PaneReadResult> => {
    const query = new URLSearchParams({ pane_id: paneId, source, format: "text", lines: String(lines) });
    return (await getJson<{ read: PaneReadResult }>(machinePath(machineId, `pane/read?${query.toString()}`))).read;
  };
  if (wrappedOnly.has(machineId)) return read("recent");
  try {
    return await read("recent_unwrapped");
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "invalid_request") throw error;
    wrappedOnly.add(machineId);
    return read("recent");
  }
}

/** Which turns (ConversationResponse.cursor): the page `before` a cursor, not past `since`; the newest ones `from` a held start. */
export type ConversationPageQuery = { before?: string; since?: string; from?: string };

/**
 * The last answer per polled conversation URL and its ETag. The chat polls every 2s
 * and a newest page can be megabytes: an unchanged one comes back as a bodyless 304,
 * and the chat gets the very same object back, which tells it nothing changed. An
 * older page (`before`) is asked for once, so it keeps no ETag and takes no slot.
 */
const conversationAnswers = new Map<string, { etag: string; body: ConversationResponse }>();
const CONVERSATION_ANSWERS_KEPT = 16;

/** GET /api/pane/conversation: structured turns, or scrollback fallback; `page` as ConversationResponse.cursor describes. */
export async function fetchPaneConversation(paneId: string, machineId = "local", page: ConversationPageQuery = {}): Promise<ConversationResponse> {
  const query = new URLSearchParams({ pane_id: paneId });
  if (page.before !== undefined) query.set("before", page.before);
  if (page.since !== undefined) query.set("since", page.since);
  if (page.from !== undefined) query.set("from", page.from);
  const url = machinePath(machineId, `pane/conversation?${query.toString()}`);
  const polled = page.before === undefined;
  const known = polled ? conversationAnswers.get(url) : undefined;
  const response = await fetch(url, { cache: "no-store", ...(known ? { headers: { "if-none-match": known.etag } } : {}) });
  if (response.status === 304 && known) {
    // the pane being polled stays among the kept answers
    conversationAnswers.delete(url);
    conversationAnswers.set(url, known);
    return known.body;
  }
  if (!response.ok) throw await errorFrom(url, response);
  const body = (await response.json()) as ConversationResponse;
  const etag = response.headers.get("etag");
  if (!polled) return body;
  conversationAnswers.delete(url);
  if (etag !== null) {
    conversationAnswers.set(url, { etag, body });
    if (conversationAnswers.size > CONVERSATION_ANSWERS_KEPT) conversationAnswers.delete(conversationAnswers.keys().next().value!);
  }
  return body;
}

export interface HealthInfo {
  ok: boolean;
  herdr: HerdrIdentity;
  web_ui?: { boot_id: string | null; revision: string | null };
  /** Absent only on a server that predates the token gate. */
  auth?: HealthAuth;
}

export async function fetchHealth(): Promise<HealthInfo> {
  return await getJson<HealthInfo>("/api/health");
}

/**
 * POST /api/auth. Resolves once the server has set its HttpOnly session cookie;
 * there is nothing to store client-side. Throws ApiError (401 `invalid_token`) on
 * a mismatch.
 */
export async function authenticate(token: string): Promise<void> {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw await errorFrom("/api/auth", response);
}

/** POST /api/devices/pair: the code shown on the PC, once; the server answers with this device's own HttpOnly cookie. */
export async function pairDevice(code: string, label: string): Promise<void> {
  const response = await fetch("/api/devices/pair", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ code, label }) });
  if (!response.ok) throw await errorFrom("/api/devices/pair", response);
}

export async function fetchDevices(): Promise<PairedDevice[]> {
  return (await getJson<{ devices: PairedDevice[] }>("/api/devices")).devices;
}

export async function startPairing(): Promise<PairingCode> {
  return (await sendJson("/api/devices/pair/start", "POST", {})).json();
}

export async function renameDevice(id: string, label: string): Promise<PairedDevice> {
  return (await sendJson(`/api/devices/${encodeURIComponent(id)}`, "PATCH", { label })).json();
}

export async function revokeDevice(id: string): Promise<void> {
  await sendJson(`/api/devices/${encodeURIComponent(id)}`, "DELETE", {});
}

/** DELETE /api/auth: clears the session and device cookies, so the next health check reports the gate again. */
export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth", { method: "DELETE" });
  if (!response.ok) throw await errorFrom("/api/auth", response);
}

/** Chunked btoa: the naive one-liner blows the stack on multi-MB screenshots. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * POST /api/pane/image: stores one pasted or file-picked image next to the pane and
 * resolves to the absolute path the prompt should reference (the composer inserts
 * `@path`). ApiError 413 image_too_large / 415 unsupported_media_type on bad input.
 */
/** Any file: an image is stored as a paste, anything else under its own (sanitised) name. */
export async function uploadPaneImage(paneId: string, image: Blob, machineId = "local"): Promise<string> {
  return protectFrontendInput(async () => {
    const data_base64 = base64FromBytes(new Uint8Array(await image.arrayBuffer()));
    const response = await fetch(machinePath(machineId, "pane/image"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1" },
      body: JSON.stringify({ pane_id: paneId, content_type: image.type, data_base64, ...(image instanceof File ? { name: image.name } : {}) }),
    });
    if (!response.ok) throw await errorFrom(machinePath(machineId, "pane/image"), response);
    return ((await response.json()) as { path: string }).path;
  });
}

async function sendJson(url: string, method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFrom(url, response);
  return response;
}

/** GET /api/pane/scroll: where the pane's viewport sits in its history (null: herdr reports none). */
export async function fetchPaneScroll(paneId: string, machineId = "local"): Promise<PaneScrollInfo | null> {
  return (await getJson<{ scroll: PaneScrollInfo | null }>(machinePath(machineId, `pane/scroll?pane_id=${encodeURIComponent(paneId)}`))).scroll;
}

/** POST /api/pane/scroll: moves the viewport; herdr redraws the attached terminal. */
export async function scrollPane(paneId: string, offsetFromBottom: number, machineId = "local"): Promise<PaneScrollInfo | null> {
  const response = await sendJson(machinePath(machineId, "pane/scroll"), "POST", { pane_id: paneId, offset_from_bottom: offsetFromBottom });
  return ((await response.json()) as { scroll: PaneScrollInfo | null }).scroll;
}

/** A cell in a pane's whole history: rows count from the top of the scrollback. */
export interface PaneTextPoint { row: number; col: number }

/** GET /api/pane/selection: the text between two history cells, both inclusive, wrapped lines joined. */
export async function fetchPaneSelection(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, machineId = "local"): Promise<string> {
  const query = new URLSearchParams({
    pane_id: paneId,
    anchor_row: String(anchor.row), anchor_col: String(anchor.col),
    cursor_row: String(cursor.row), cursor_col: String(cursor.col),
  });
  return (await getJson<{ text: string }>(machinePath(machineId, `pane/selection?${query.toString()}`))).text;
}

/**
 * POST /api/pane/close: closes the pane in herdr itself (the `pane.close` RPC).
 * The sidebar updates on its own when the server's session-changed broadcast lands;
 * a failure (e.g. the pane already gone) throws ApiError and the 5s poll reconciles.
 */
export async function closePane(paneId: string, machineId = "local", terminalId?: string): Promise<void> {
  await sendJson(machinePath(machineId, "pane/close"), "POST", { pane_id: paneId, ...(terminalId ? { terminal_id: terminalId } : {}) });
}

export interface CreatedShellPane { pane_id: string; workspace_id: string; tab_id: string | null; cwd: string }

export async function createShellPane(paneId: string, workspaceId: string, machineId = "local"): Promise<CreatedShellPane> {
  const response = await sendJson(machinePath(machineId, "pane/split"), "POST", { pane_id: paneId, workspace_id: workspaceId });
  return response.json();
}

/** Native move on one selected PC. Never retries a mutation or substitutes pane/split. */
export async function movePane(request: PaneMoveRequest, machineId = "local"): Promise<PaneMoveResult> {
  const response = await sendJson(machinePath(machineId, "pane/move"), "POST", request);
  const result: unknown = await response.json();
  if (!isMoveResult(result, request)) throw new Error("Move outcome unknown. Refresh before another move.");
  return result;
}

/** POST /api/pane/rename: sets the pane's label in herdr (an empty label clears it). */
export async function renamePane(paneId: string, label: string, machineId = "local", terminalId?: string): Promise<void> {
  await sendJson(machinePath(machineId, "pane/rename"), "POST", { pane_id: paneId, label, ...(terminalId ? { terminal_id: terminalId } : {}) });
}

/** GET /api/agents: the agent kinds herdr can start, for the new-session dialog. */
export async function fetchAgentKinds(machineId = "local"): Promise<AgentKind[]> {
  return (await getJson<{ agents: AgentKind[] }>(machinePath(machineId, "agents"))).agents;
}

/** GET /api/workspace/directories: the folders in `path` (empty: home), for the folder browser. */
export async function fetchDirectories(path: string, hidden: boolean, machineId = "local", files = false, paneId: string | null = null): Promise<DirectoryListing> {
  const query = new URLSearchParams({ path, ...(hidden ? { hidden: "1" } : {}), ...(files ? { files: "1" } : {}), ...(paneId ? { pane_id: paneId } : {}) });
  return getJson<DirectoryListing>(machinePath(machineId, `workspace/directories?${query.toString()}`));
}

function fileQuery(path: string, paneId: string | null): string {
  return new URLSearchParams({ path, ...(paneId ? { pane_id: paneId } : {}) }).toString();
}

/**
 * GET /api/fs/stat: a file to open; `path` is absolute, `~/…` or relative to the pane's
 * folder. A bare name that several files under the folder end in answers with them.
 */
export async function fetchFileInfo(path: string, paneId: string | null, machineId = "local"): Promise<FileInfo | { candidates: string[] }> {
  const url = machinePath(machineId, `fs/stat?${fileQuery(path, paneId)}`);
  const response = await fetch(url);
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: { candidates?: unknown } } | null;
    if (Array.isArray(body?.error?.candidates)) return { candidates: body.error.candidates.map(String) };
  }
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as FileInfo;
}

/** GET /api/fs/file: the file itself, streamed (ranges for media); `download` saves it instead. */
export function fileUrl(path: string, paneId: string | null, machineId = "local", download = false): string {
  return machinePath(machineId, `fs/file?${fileQuery(path, paneId)}${download ? "&download=1" : ""}`);
}

export interface CreateWorkspaceRequest {
  cwd?: string | null;
  label?: string | null;
  agent?: { kind: string; name?: string; args?: string[] } | null;
}

/**
 * POST /api/workspace/create: a new herdr workspace (and an agent started in its root
 * pane when `agent` is given). Slow when an agent starts: herdr waits for the agent's
 * interactive prompt (up to 60s) before answering.
 */
export async function createWorkspace(request: CreateWorkspaceRequest, machineId = "local"): Promise<WorkspaceCreated> {
  const response = await sendJson(machinePath(machineId, "workspace/create"), "POST", request);
  return (await response.json()) as WorkspaceCreated;
}

export async function renameWorkspace(workspaceId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/rename"), "POST", { workspace_id: workspaceId, label });
}

/** POST /api/workspace/move: places the workspace at `insertIndex` in herdr's order (the sidebar order). */
export async function moveWorkspace(workspaceId: string, insertIndex: number, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/move"), "POST", { workspace_id: workspaceId, insert_index: insertIndex });
}

export async function closeWorkspace(workspaceId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/close"), "POST", { workspace_id: workspaceId });
}

/** GET /api/pane/commands: the slash commands the pane's agent understands (built-in + custom). */
export async function fetchPaneCommands(paneId: string, machineId = "local"): Promise<SlashCommand[]> {
  return (await getJson<{ commands: SlashCommand[] }>(machinePath(machineId, `pane/commands?pane_id=${encodeURIComponent(paneId)}`))).commands;
}

/** GET /api/pane/omo-tasks: the background tasks and workflows the pane's OmO session started, and that PC's clock. */
export async function fetchPaneOmoActivity(paneId: string, machineId = "local"): Promise<{ tasks: OmoActivity["tasks"]; runs: OmoActivity["runs"]; serverTime: string | null }> {
  const activity = await getJson<Partial<OmoActivity>>(machinePath(machineId, `pane/omo-tasks?pane_id=${encodeURIComponent(paneId)}`));
  // a bridge from before workflows answers tasks only
  return { tasks: activity.tasks ?? [], runs: activity.runs ?? [], serverTime: activity.server_time ?? null };
}

/** GET /api/pane/files: paths under the pane's cwd matching `query`, for @-mentions. */
export async function fetchPaneFiles(paneId: string, query: string, limit = 20, machineId = "local"): Promise<string[]> {
  const params = new URLSearchParams({ pane_id: paneId, q: query, limit: String(limit) });
  return (await getJson<{ files: string[] }>(machinePath(machineId, `pane/files?${params.toString()}`))).files;
}

/** GET /api/pane/prompt: the agent's interactive menu currently on screen, or null. */
export async function fetchPanePrompt(paneId: string, machineId = "local"): Promise<InteractivePrompt | null> {
  return (await fetchPanePromptState(paneId, machineId)).prompt;
}

/** The waiting prompt, and with none, the next prompt the agent suggests (older servers send no suggestion). */
export async function fetchPanePromptState(paneId: string, machineId = "local"): Promise<{ prompt: InteractivePrompt | null; suggestion: string | null }> {
  const body = await getJson<{ prompt: InteractivePrompt | null; suggestion?: string | null }>(machinePath(machineId, `pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
  return { prompt: body.prompt, suggestion: typeof body.suggestion === "string" && body.suggestion !== "" ? body.suggestion : null };
}

/** POST /api/pane/prompt/answer: ApiError 409 `prompt_changed` when the menu moved on. */
export async function answerPanePrompt(answer: PromptAnswer, machineId = "local"): Promise<void> {
  await protectFrontendInput(() => sendJson(machinePath(machineId, "pane/prompt/answer"), "POST", answer));
}

/** GET /api/push: the server's VAPID key, the `applicationServerKey` this device subscribes with. */
export async function fetchPushKey(): Promise<string> {
  return (await getJson<PushKey>("/api/push")).public_key;
}

/** `alerts`: what this device wants to hear about; the server applies it to every alert it sends here. */
export async function registerPushSubscription(subscription: PushSubscriptionJSON, alerts?: AlertPrefs): Promise<void> {
  await sendJson("/api/push/subscribe", "POST", alerts === undefined ? { subscription } : { subscription, alerts });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await sendJson("/api/push/subscribe", "DELETE", { endpoint });
}

/** One confirmation push to this device only; ApiError 502 `push_failed` when the push service refused it. */
export async function sendTestPush(endpoint: string): Promise<void> {
  await sendJson("/api/push/test", "POST", { endpoint });
}

export function fetchBridgeHealth(): Promise<BridgeHealth> { return getJson("/api/health?scope=bridge"); }
export async function fetchMachines(signal?: AbortSignal): Promise<Machine[]> {
  const response = await fetch("/api/machines", { signal });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return ((await response.json()) as { machines: Machine[] }).machines;
}
export async function machineRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/machines${path}`, { method, headers: { "content-type": "application/json", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return response.json();
}
export const startMachineSetup = (request: SetupRequest) => machineRequest<SetupJob>("/setup", "POST", request);
export const fetchMachineSetup = (id: string) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`);
export const answerMachineSetup = (id: string, action: SetupAction) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`, "POST", action);

/** GET /api/voice: whether the server holds a key; the key itself never comes back. */
export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const response = await fetch("/api/voice", { cache: "no-store" });
  if (!response.ok) throw await errorFrom("/api/voice", response);
  return (await response.json()) as VoiceStatus;
}

/** PUT /api/voice/config: ApiError 409 `key_from_env` when the key comes from HERDR_WEB_OPENAI_API_KEY. */
export async function saveVoiceConfig(update: VoiceConfigUpdate): Promise<VoiceStatus> {
  const response = await fetch("/api/voice/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
  if (!response.ok) throw await errorFrom("/api/voice/config", response);
  return (await response.json()) as VoiceStatus;
}
