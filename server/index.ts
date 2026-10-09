import { AndroidRuntime } from "./android/runtime.ts";
import { handleAndroidRequest } from "./android/api.ts";
import { OpenRigRuntime } from "./openrig/runtime.ts";
import { handleOpenRigRequest } from "./openrig/api.ts";
import { OpenRigService, OpenRigServiceError } from "./openrig-service.ts";
import { TerminalNotifications } from "./terminal-notifications/api.ts";
import { boundedJson } from "./openrig/runtime.ts";
import { MobileRelayGateway } from "./mobile-relay/gateway.ts";
import { randomBytes } from "node:crypto";
import { statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import type { ServerWebSocket } from "bun";

import type { AgentKind, AgentStatus, ClientMessage, ClientRole, HealthAuth, HerdrPane, ServerFeature, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { paneTitle } from "../shared/notify-policy.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { DEVICE_COOKIE, handleAuthRequest, isAuthenticated, parseCookies, requiresAuth, unauthorizedJson } from "./auth.ts";
import { cameThroughProxy, decideAccess, isLoopbackAddress } from "./access.ts";
import { DeviceStore, handleDeviceRequest } from "./devices.ts";
import { remoteAccess, tailscaleIdentity } from "./tailscale.ts";
import { paneCommands } from "./commands.ts";
import { paneFiles } from "./files.ts";
import { badRequest, errorResponse, isCount, isJsonObject, jsonResponse } from "./http.ts";
import { serveStatic } from "./static.ts";
import { startStatusCollector } from "./collector.ts";
import { createPaneMesh } from "./pane-mesh.ts";
import { conversationImage, ConversationUnavailable, HistoryChanged, paneConversation, paneRunsOmo, toolOutput } from "./conversation.ts";
import { omoPanes } from "./omo.ts";
import { OMO_ALIASES, OmoStatus, processAlive } from "./omo-status.ts";
import { omoRuns, omoTasks } from "./omo-tasks.ts";
import { CompletionTracker } from "./completion.ts";
import { freeAgentName } from "./agent-name.ts";
import { SHELL_AGENTS, isShellAgentKind, shellAgentExecutable, startShellAgent } from "./shell-agent.ts";
import { listDirectories } from "./directories.ts";
import { fileResponse, locateFile } from "./file-view.ts";
import {
  agentManifests,
  agentPrompt,
  agentStart,
  HerdrError,
  herdrSocketPath,
  paneClose,
  paneRead,
  paneScroll,
  paneScrollInfo,
  paneSelectionRead,
  paneRename,
  paneSendKeys,
  paneSendText,
  ping,
  sessionSnapshot,
  workspaceClose,
  workspaceCreate,
  workspaceMove,
  workspaceRename,
} from "./herdr/client.ts";
import { type AlertTiming, createPushService, defaultStateDir, handlePushRequest } from "./push.ts";
import { codexQuestionsCollapsed, handlePromptRequest } from "./prompt.ts";
import { secretPrompt, validSecret } from "../shared/secret-prompt.ts";
import { PasteImageError, savePaneImage } from "./paste.ts";
import { PtySession } from "./pty/session.ts";
import { attachableIdentity, sidecarAvailable } from "./pty/sidecar.ts";
import { MirrorSession } from "./mirror.ts";
import { mirrorInput } from "./mirror-input.ts";
import { OutputWindow, OUTPUT_HIGH_BYTES, OUTPUT_HARD_BYTES, OUTPUT_STALL_MS, ReplayBuffer } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import { connectUpdater, handleUpdateRequest, type UpdateService } from "./update-api.ts";
import { handleHerdrUpdateRequest, HerdrUpdater } from "./herdr-update.ts";
import { handleUsageRequest, UsageService } from "./usage.ts";
import { handleVoiceRequest, VoiceService } from "./voice.ts";

import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { bridgeIdentity, registerBridge } from "./bridge.ts";
import { MachineManager } from "./machines.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineRelay } from "./machine-relay.ts";
import { sameOrigin } from "./machine-security.ts";
import { handlePaneSplit } from "./pane-split.ts";
import { handlePaneMove } from "./pane-move.ts";
import { TmuxRuntime } from "./tmux/runtime.ts";
import { PaneNumbers } from "./pane-numbers.ts";
import { handleTmuxRequest } from "./tmux/api.ts";
import { TmuxTerminal } from "./tmux/terminal.ts";

const MAX_REPLAY_BYTES = 256 * 1024;
/**
 * herdr's refusal of an attach while a read of the same terminal is in progress; it asks
 * for a retry. A read of more lines than an idle alt-screen agent (Codex) shows, like the
 * transcript match's 400, makes herdr scroll the agent's history back with wheel events:
 * up to 15 s, and 5 more to restore it (herdr 0.9, src/server/alt_screen_read.rs). A
 * 400-line read of an idle Codex pane took about a second, refusing every attach meanwhile.
 */
const ATTACH_READ_RACE_RE = /has a read in progress; retry/;
/**
 * herdr's refusal when another client holds the terminal's one attach slot. It is the attach's
 * last line, after its teardown: the same words earlier in the pane's own output are not it.
 */
const ATTACH_HELD_RE = /terminal attach failed: [^\r\n]*(?:already has an attached client|retry with --takeover)[^\r\n]*\s*$/;
/** how long refused attaches are retried: herdr's longest read of that kind */
const ATTACH_RETRY_FOR_MS = 20_000;
const ATTACH_RETRY_MS = 50;
const ATTACH_RETRY_MAX_MS = 500;
/** a refused attach says so within milliseconds of its first bytes: those are held this long */
const ATTACH_HOLD_MS = 100;
/**
 * What `herdr terminal attach` writes itself before herdr has answered: terminal modes set and
 * reset only (mouse reporting off, the alternate screen on; the last one maybe cut short). The
 * answer can come any time after them, later than the hold on a busy PC, so they say nothing
 * about whether the attach took and do not start the hold. A refusal and a screen both begin
 * with something else.
 */
const ATTACH_PREAMBLE_RE = /^(?:\x1b\[\?[\d;]+[hl])*(?:\x1b(?:\[(?:\?[\d;]*)?)?)?$/;
/** how often a terminal another web bridge holds is tried again, while clients here still want it */
const ATTACH_HELD_RETRY_MS = 3_000;
/**
 * herdr refusing an attach, its line (maybe not all of it yet) the last output, before the
 * exit has come. The same words earlier in the pane's own output, with more after them, are not it.
 */
const ATTACH_REFUSING_RE = /terminal attach failed[^\r\n]*\s*$/;
/** how long a refusal's exit is waited for before its output is taken for the pane's own */
const ATTACH_REFUSAL_EXIT_MS = 2_000;
const ATTACH_HELD_MESSAGE = "Another web bridge has this pane open. It connects here as soon as that bridge lets go.";
/**
 * How long a pane whose attach herdr ended is looked up again before its terminal is taken for
 * ended. A live handoff (`herdr update --handoff`, `herdr server live-handoff`) moves every pane
 * to a new server under a new terminal id and cuts each attach with "server shut down", the
 * words a pane that exited gets too. Measured on herdr 0.9.3: the socket answers
 * server_unavailable for ~200 ms, then the pane is back under its new terminal; an exited
 * pane is gone from the snapshot within ~30 ms.
 */
const ATTACH_RELOOKUP_FOR_MS = 5_000;
const ATTACH_RELOOKUP_MS = 100;
/** what a pane lookup answers for a pane that has no terminal to attach any more */
const PANE_GONE_CODES = new Set(["pane_not_found", "pane_not_restored", "no_terminal"]);
/** The gap between a composer message's text and its Enter (see submitText). */
export const SUBMIT_DELAY_MS = 120;
/**
 * herdr holds a lone ESC typed through the attach pty ~150ms (measured) to tell it from
 * an Alt+key: a composer message waits this long after the pane's last keystroke, so a
 * Stop tapped just before Send still reaches the pane first.
 */
const TYPED_SETTLE_MS = 300;
/**
 * Nothing of a composer message is typed once this long has passed since it reached the
 * server (it can wait behind a stalled one in the pane's queue): it answers submit_timeout
 * instead. A send that starts in time ends within two more 10s RPCs, before the client
 * stops waiting (SUBMIT_TIMEOUT_MS in src/lib/ws.ts), so a message it gave up on never
 * reaches the pane later.
 */
export const SUBMIT_DEADLINE_MS = 45_000;
const SERVER_FEATURES: ServerFeature[] = ["submit", "secret-input", "input-ready"];

/** Bind addresses only this machine can reach, so an unset token is nobody else's business. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  omp: "Oh My Pi",
  omo: "OmO",
  gjc: "Gajae Code",
  pi: "pi",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  kimi: "Kimi",
  amp: "Amp",
};

function expandedDirectory(value: string): string | null {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
  try {
    return statSync(expanded).isDirectory() ? expanded : null;
  } catch {
    return null;
  }
}

async function paneContext(paneId: string): Promise<{ agent: string | null; cwd: string }> {
  const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (!cwd) throw new HerdrError("cwd_not_found", `pane ${paneId} has no working directory`);
  return { agent: pane.agent ?? pane.agent_session?.agent ?? null, cwd };
}

interface SocketData {
  deviceId?: string;
  readOnly?: boolean;
  revoked?: boolean;
  unwatchDevice?: () => void;
  relay?: MachineRelay;
  tmux?: TmuxTerminal;
  mobileRelay?: boolean;
  attached: Set<string>;
  output: Map<string, OutputWindow>;
  closing: boolean;
  /** the connection's authority: observe connections cannot type or resize */
  mode: ClientRole;
}

type Client = ServerWebSocket<SocketData>;

/**
 * One live PTY per pane, shared by every client watching that pane.
 *
 * The terminal is a real `herdr terminal attach` on a PTY rather than repeated
 * `pane.read` snapshots, so the browser receives an actual byte stream: xterm.js
 * keeps screen state and selection, while herdr owns scrollback.
 */
interface PaneAttachment {
  ready: boolean;
  pty: PtySession | MirrorSession;
  /** set when herdr cannot attach here: `pty` repaints the pane's screen (server/mirror.ts), on the pane's own grid */
  mirror?: MirrorSession;
  clients: Set<Client>;
  /** the pty's current grid: interact clients set it, observe clients adopt it */
  cols: number;
  rows: number;
  /** bounded tail so a client joining late still sees the current screen */
  replay: ReplayBuffer;
  stalled: Map<Client, number>;
  /** another web bridge holds herdr's one attach slot for this terminal: waiting for it to let go */
  held?: boolean;
  /** the next try at a held terminal; a closed attachment cancels it */
  heldRetry?: ReturnType<typeof setTimeout>;
  /** the next look for the terminal a pane lives on after herdr ended its attach; a closed attachment cancels it */
  relookup?: ReturnType<typeof setTimeout>;
}

function send(client: Client, message: ServerMessage): number {
  if (client.data.closing) return 0;
  try {
    const encoded = JSON.stringify(message);
    // Include JSON escaping in the transport budget, before Bun could drop a
    // frame at its own cap. An overload close is explicit and never auto-replayed.
    if (client.getBufferedAmount() + Buffer.byteLength(encoded) > OUTPUT_HARD_BYTES) {
      client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output transport stalled");
      return 0;
    }
    // -1 means ALREADY queued. Never retry that frame, or terminal bytes repeat.
    const result = client.send(encoded);
    if (result === 0) client.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
    return result;
  } catch {
    /* client vanished mid-send */
    return 0;
  }
}

export function createServer(
  options: {
    port?: number;
    hostname?: string;
    token?: string;
    /** where VAPID keys and push subscriptions persist; tests pass a temp dir */
    stateDir?: string;
    /** the PC's own Tailscale login, for the identity check; tests set it, otherwise `tailscale status` says */
    tailscaleOwner?: string | null;
    /** Native Codex store; defaults to CODEX_HOME. Tests use an isolated store. */
    codexHome?: string;
    updates?: UpdateService;
    /** updates herdr itself (server/herdr-update.ts); unset, the app offers no herdr update. Tests pass one that runs a stand-in herdr. */
    herdrUpdate?: HerdrUpdater;
    /** plan limits of the AI subscriptions signed in here; tests pass one without real sign-ins */
    usage?: UsageService;
    /** voice input's key, provider and models; tests pass one with their own env and fetch */
    voice?: VoiceService;
    machines?: boolean;
    registerBridge?: boolean;
    /** SUBMIT_DEADLINE_MS; tests shorten it */
    submitDeadlineMs?: number;
    /** Monotonic elapsed time. Tests can advance this without relying on RPC timing. */
    submitNow?: () => number;
    /** how long a push alert waits for the pane to change first (server/push.ts); tests send at once */
    alertTiming?: Partial<AlertTiming>;
    /** ATTACH_RETRY_FOR_MS; tests shorten it */
    attachRetryForMs?: number;
    /** ATTACH_HELD_RETRY_MS; tests shorten it */
    attachHeldRetryMs?: number;
    /** ATTACH_RELOOKUP_FOR_MS; tests shorten it */
    attachRelookupForMs?: number;
    /** whether herdr can `terminal attach`; unset, its ping says, and this runtime's PTY sidecar has to be runnable. Tests give a Windows herdr's answer, at once or as late as a ping's. */
    terminalAttach?: boolean | (() => Promise<boolean>);
    /** whether this runtime can run the PTY sidecar; unset, server/pty/sidecar.ts says. Tests give a runtime without Node or node-pty, while herdr keeps its own answer. */
    sidecar?: boolean;
    /** Private tmux runtime; injectable for isolated tests. */
    tmux?: TmuxRuntime;
    android?: AndroidRuntime;
    openrig?: OpenRigRuntime;
    openrigService?: OpenRigService;
    mobileRelay?: MobileRelayGateway;
  } = {},
): { port: number; hostname: string; stop: () => void } {
  const attachments = new Map<string, PaneAttachment>();
  const android = options.android ?? new AndroidRuntime(options.stateDir ?? defaultStateDir());
  const openrig = options.openrig ?? new OpenRigRuntime({
    stateDir: options.stateDir ?? defaultStateDir(),
    nativeSnapshot: async () => clientSnapshot(),
  });
  const openrigService = options.openrigService ?? new OpenRigService(options.stateDir ?? defaultStateDir());
  let openrigRequests = 0;
  void openrigService.restore();
  const mobileRelay = options.mobileRelay ?? new MobileRelayGateway(options.stateDir ?? defaultStateDir());
  const tmux = options.tmux ?? new TmuxRuntime(join(options.stateDir ?? defaultStateDir(), "tmux"));
  const tmuxClients = new Set<TmuxTerminal>();
  const paneNumbers = new PaneNumbers(options.stateDir ?? defaultStateDir());
  /** whether this bridge can `terminal attach`: herdr is asked once, and the PTY sidecar has to be runnable here (server/pty/sidecar.ts) */
  /** whether the sidecar can run, settled as the server starts so that attach, /api/health and /api/bridge tell one answer; a forced answer (tests) stands in for it */
  const sidecar = options.sidecar ?? (options.terminalAttach === undefined ? sidecarAvailable() : options.terminalAttach !== false);
  let terminalAttachKnown: boolean | null = typeof options.terminalAttach === "boolean" ? options.terminalAttach : null;
  const terminalAttach = async (): Promise<boolean> => {
    if (terminalAttachKnown === null) {
      terminalAttachKnown = typeof options.terminalAttach === "function" ? await options.terminalAttach() : attachableIdentity(await ping(), sidecar).terminal_attach !== false;
    }
    return terminalAttachKnown;
  };
  const retryFor = options.attachRetryForMs ?? ATTACH_RETRY_FOR_MS;
  const heldRetry = options.attachHeldRetryMs ?? ATTACH_HELD_RETRY_MS;
  const relookupFor = options.attachRelookupForMs ?? ATTACH_RELOOKUP_FOR_MS;
  /** attachments still resolving their terminal, so concurrent attaches share one pty */
  const pendingAttachments = new Map<string, Promise<PaneAttachment>>();
  // herdr releases its exclusive attach slot only after the old process exits.
  const retiringAttachments = new Map<string, Promise<void>>();
  const clients = new Set<Client>();
  /** each pane's input while a composer message is in flight, one step after another */
  const paneQueues = new Map<string, Promise<unknown>>();
  /** when each pane last got keystrokes through its attach pty */
  const lastTyped = new Map<string, number>();
  const hostname = options.hostname ?? process.env["HOST"] ?? "127.0.0.1";
  /** Empty token = gate disabled; every route then behaves exactly as it did before auth existed. */
  const token = options.token ?? process.env["HERDR_WEB_TOKEN"] ?? "";
  /** paired devices (server/devices.ts) and the PC's Tailscale login: the two ways in besides the token and this PC itself */
  const devices = new DeviceStore(options.stateDir ?? defaultStateDir());
  const usage = options.usage ?? new UsageService();
  const voice = options.voice ?? new VoiceService({ stateDir: options.stateDir ?? defaultStateDir(), env: process.env, fetch });
  /** a login named here is taken as it is: a tagged node has none of its own to read (HERDR_WEB_TAILSCALE_OWNER) */
  const namedOwner = options.tailscaleOwner !== undefined ? options.tailscaleOwner : process.env["HERDR_WEB_TAILSCALE_OWNER"]?.trim() || undefined;
  const identityOf = namedOwner !== undefined ? () => ({ owner: namedOwner, tagged: false }) : tailscaleIdentity;
  identityOf();

  /**
   * Runs `task` after everything queued for the pane. While a composer message is in
   * flight, the pane's other input (keystrokes, keys, prompt answers) waits behind it:
   * a Stop tapped right after Send must not land between the text and its Enter.
   */
  function serialize<T>(paneId: string, task: () => T | Promise<T>): Promise<T> {
    const run = (paneQueues.get(paneId) ?? Promise.resolve()).catch(() => {}).then(task);
    paneQueues.set(paneId, run);
    run.catch(() => {}).finally(() => { if (paneQueues.get(paneId) === run) paneQueues.delete(paneId); });
    return run;
  }

  /**
   * Types a composer message and submits it, with its own Enter after the text: arriving
   * in the same chunk as the paste, a TUI still busy with it (turning an image path into
   * an attachment, redrawing after the phone keyboard closed) could take it for a newline
   * and leave the message unsent in its input box. Done here rather than in the browser,
   * the gap survives a jittery connection and the Enter still goes when the phone locks.
   *
   * An agent gets it through herdr's agent.prompt (the paste, then Enter 300ms later),
   * which refuses while the agent waits for an answer: the message is not typed into its
   * menu. A pane without an agent in front gets `payload`, shaped for its own paste mode,
   * through send_text, then Enter SUBMIT_DELAY_MS later; both return once the pane has
   * the bytes, so the pane sees the whole gap. So does a Codex "blocked" only by questions
   * waiting collapsed in its queue: its main prompt still takes the message.
   */
  async function submitText(paneId: string, text: string, payload: string, arrivedAt: number, fromTerminal = false, authorize: () => void = () => {}): Promise<void> {
    const inTime = (): void => {
      authorize();
      if ((options.submitNow ?? performance.now.bind(performance))() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) {
        throw new HerdrError("submit_timeout", "the message waited too long behind earlier input; nothing was typed");
      }
    };
    const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
    if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
    lastTyped.delete(paneId);
    inTime();
    // the terminal's input line stands in for the keyboard: it types what the user wrote, an
    // answer into an open menu included, where agent.prompt would refuse
    if (!fromTerminal) try {
      await agentPrompt(paneId, text);
      return;
    } catch (error) {
      if (!(error instanceof HerdrError)) throw error;
      const queuedOnly = error.code === "agent_blocked" && await blockedOnlyByCodexQueue(paneId);
      if (error.code !== "agent_not_found" && error.code !== "agent_not_ready" && !queuedOnly) throw error;
    }
    inTime();
    // a mirrored pane's browser never learned the program's paste mode, so `payload` came as bare
    // lines: several of them are shaped here as the same block typed into the mirror is. herdr is
    // asked only for such a block, so a one-line message never waits on it.
    const shaped = await mirrorInput(payload, async () => await terminalAttach() ? null : (await paneContext(paneId)).agent);
    inTime();
    await paneSendText(paneId, shaped);
    await Bun.sleep(SUBMIT_DELAY_MS);
    authorize();
    await paneSendKeys(paneId, ["Enter"]);
  }

  function authorizeSocket(client: Client): void {
    if (client.data.revoked) throw new HerdrError("device_revoked", "this device's access was revoked");
    if (client.data.readOnly || client.data.mode === "observe") throw new HerdrError("read_only", "this connection can only watch");
  }

  /** Is this pane's agent Codex, blocked only by questions waiting collapsed in its queue (codexQuestionsCollapsed)? */
  async function blockedOnlyByCodexQueue(paneId: string): Promise<boolean> {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if ((pane?.agent ?? pane?.agent_session?.agent) !== "codex") return false;
    return codexQuestionsCollapsed((await paneRead({ paneId, source: "visible", format: "text" })).text);
  }

  function stopSlowClient(client: Client): void {
    if (client.data.closing) return;
    client.data.closing = true;
    clients.delete(client);
    for (const paneId of client.data.attached) detach(paneId, client);
    client.data.attached.clear();
    client.data.output.clear();
    client.close(OUTPUT_STALLED_CLOSE_CODE, "terminal output consumer stalled");
  }

  function reconcileOutput(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment?.pty) return;
    let paused = false;
    for (const client of attachment.clients) {
      const window = client.data.output.get(paneId);
      const buffered = client.getBufferedAmount();
      const blocked = window?.blocked || buffered >= OUTPUT_HIGH_BYTES;
      if (!blocked) {
        attachment.stalled.delete(client);
        continue;
      }
      const since = attachment.stalled.get(client) ?? Date.now();
      attachment.stalled.set(client, since);
      if (Date.now() - since >= OUTPUT_STALL_MS || buffered >= OUTPUT_HARD_BYTES) {
        stopSlowClient(client);
      } else {
        paused = true;
      }
    }
    if (attachments.get(paneId) !== attachment) return;
    if (paused) attachment.pty.pause();
    else attachment.pty.resume();
  }

  function sendOutput(client: Client, paneId: string, data: string): void {
    const window = client.data.output.get(paneId);
    const bytes = Buffer.byteLength(data);
    if ((window && window.pending + bytes > OUTPUT_HARD_BYTES) || client.getBufferedAmount() >= OUTPUT_HARD_BYTES) {
      stopSlowClient(client);
      return;
    }
    send(client, {
      type: "pty-data", pane_id: paneId, data,
      ...(window ? { flow: { stream_id: window.id, offset: window.write(bytes) } } : {}),
    });
  }
  const push = createPushService({
    stateDir: options.stateDir ?? defaultStateDir(),
    timing: options.alertTiming,
    canDeliver: (id) => id === null || (id === undefined ? !devices.gated : devices.has(id)),
    lookupTitle: async (paneId) => {
      const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
      return pane ? paneTitle(pane) : undefined;
    },
  });

  /** `done` for agents herdr loses track of (server/completion.ts), kept across restarts */
  const completions = new CompletionTracker(join(options.stateDir ?? defaultStateDir(), "completions.json"));
  /** OmO panes get their status from OmO's session files: herdr reports none for them (server/omo-status.ts) */
  const omo = new OmoStatus({
    discover: (panes) => omoPanes(panes),
    snapshot: sessionSnapshot,
    onChange: (paneId, derived, background, turn) => omoChanged(paneId, derived, background, turn),
    // herdr called it `claude` or `pi` until now: what it finished under that name is its own
    onFound: (paneId) => completions.adopt(paneId, "omo", OMO_ALIASES),
  });
  /** herdr's snapshot with OmO's own status in it: what the completion tracker and web push are given */
  const rawSnapshot = async (): Promise<SessionSnapshot> => {
    const snapshot = await sessionSnapshot();
    await omo.refresh(snapshot.panes);
    return omo.apply(snapshot);
  };
  /** the snapshot clients get: finishes settled, OmO panes named, their running background tasks counted */
  const clientSnapshot = async (): Promise<SessionSnapshot> => {
    const snapshot = paneNumbers.annotate(await completions.readSnapshot(rawSnapshot));
    if (!snapshot.panes.some((pane) => omo.backgroundOf(pane.pane_id) > 0)) return snapshot;
    return { ...snapshot, panes: snapshot.panes.map((pane) => omo.backgroundOf(pane.pane_id) > 0 ? { ...pane, background_tasks: omo.backgroundOf(pane.pane_id) } : pane) };
  };
  const terminalNotifications = new TerminalNotifications(options.stateDir ?? defaultStateDir(), clientSnapshot);
  const machines = options.machines === false ? null : new MachineManager(options.stateDir ?? defaultStateDir(), push, completions, clientSnapshot);
  const bridgeToken = randomBytes(32).toString("hex");

  function broadcast(paneId: string, message: ServerMessage): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) send(client, message);
  }

  function broadcastAll(message: ServerMessage): void {
    machines?.localMessage(message);
    for (const client of clients) send(client, message);
  }

  async function terminalInfoFor(paneId: string, timeoutMs?: number): Promise<{ terminalId: string; rect: { width: number; height: number } | null }> {
    const snapshot = await sessionSnapshot(undefined, timeoutMs);
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    // herdr (0.9.3+) could not restore it after a restart: its terminal has no process
    // and an attach would only die with "not found". The client shows the reason instead.
    if (pane.restore_error) throw new HerdrError("pane_not_restored", pane.restore_error);
    const terminalId = (pane as HerdrPane & { terminal_id?: string }).terminal_id;
    if (!terminalId) throw new HerdrError("no_terminal", `pane ${paneId} has no terminal`);
    // the pane's grid as the operator's layout holds it: an observe connection must
    // create the pty at THIS size, never at the observer's own viewport
    const rect = snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    return { terminalId, rect: rect ? { width: rect.width, height: rect.height } : null };
  }

  function closeAttachment(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachments.delete(paneId);
    clearTimeout(attachment.heldRetry);
    clearTimeout(attachment.relookup);
    // its members hold nothing on this pane any more (a pty that exited leaves them on
    // the "terminal ended" screen): a stale entry would read as a live claim in
    // releaseUnclaimed and keep a later, empty pty on this pane running
    for (const member of attachment.clients) member.data.attached.delete(paneId);
    for (const member of attachment.clients) member.data.output.delete(paneId);
    const retired = attachment.pty.exited.finally(() => {
      if (retiringAttachments.get(paneId) === retired) retiringAttachments.delete(paneId);
    });
    retiringAttachments.set(paneId, retired);
    attachment.pty.kill();
  }

  /** Clamp surface for the shared pty, mirroring the sidecar's own limits. */
  function validGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
    if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
      return null;
    }
    if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return null;
    return { cols, rows };
  }

  function resizePty(paneId: string, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    // a mirrored pane's grid is herdr's own: no browser resizes it
    if (!attachment || attachment.mirror || (attachment.cols === cols && attachment.rows === rows)) return;
    attachment.cols = cols;
    attachment.rows = rows;
    attachment.pty.resize(cols, rows);
    broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows });
  }

  function ensureAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    const existing = attachments.get(paneId);
    if (existing) return Promise.resolve(existing);
    // a second attach arriving while the first is still resolving the terminal joins
    // that creation: two creations would spawn two ptys, and the orphaned one keeps
    // streaming into the surviving attachment and kills it when it exits
    const pending = pendingAttachments.get(paneId);
    if (pending) return pending;

    const created = spawnAttachment(paneId, cols, rows, forObserver).finally(() => pendingAttachments.delete(paneId));
    pendingAttachments.set(paneId, created);
    return created;
  }

  async function spawnAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    await retiringAttachments.get(paneId);
    const mirrored = !(await terminalAttach());
    const { terminalId, rect } = await terminalInfoFor(paneId);
    // an observer-first attachment spawns at the pane's own grid (fallback 80x24 when
    // the layout has no rect for it): the attach must not seed the shared pty with a
    // watching phone's viewport
    const spawnCols = forObserver || mirrored ? (rect?.width ?? 80) : cols;
    const spawnRows = forObserver || mirrored ? (rect?.height ?? 24) : rows;
    const attachment: PaneAttachment = {
      ready: mirrored,
      pty: undefined as unknown as PtySession,
      clients: new Set<Client>(),
      cols: spawnCols,
      rows: spawnRows,
      replay: new ReplayBuffer(MAX_REPLAY_BYTES),
      stalled: new Map(),
    };
    attachments.set(paneId, attachment);

    if (mirrored) {
      const mirror = new MirrorSession({
        cols: spawnCols,
        rows: spawnRows,
        size: async () => {
          const now = (await terminalInfoFor(paneId)).rect;
          return now ? { cols: now.width, rows: now.height } : null;
        },
        // the grid follows herdr's layout: the clients adopt the new size before the screen
        onResize: (cols, rows) => {
          if (attachments.get(paneId) !== attachment) return;
          attachment.cols = cols;
          attachment.rows = rows;
          broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows, fixed: true });
        },
        read: async () => (await paneRead({ paneId, source: "visible", format: "ansi" })).text,
        write: (data) => paneSendText(paneId, data),
        onData: (frame) => {
          if (attachments.get(paneId) !== attachment) return;
          for (const client of attachment.clients) sendOutput(client, paneId, frame);
          reconcileOutput(paneId);
        },
        onExit: (code) => {
          if (attachments.get(paneId) !== attachment) return;
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        },
      });
      attachment.pty = mirror;
      attachment.mirror = mirror;
      return attachment;
    }

    // No --takeover: another web bridge may own the exclusive attach slot.
    // Report that conflict without displacing it or the user's own TUI.
    // herdr also refuses an attach while a read of the same terminal is in progress ("has a
    // read in progress; retry"), and this server reads panes all the time (prompt polls,
    // transcript matches): an attach that races one, typically a phone reconnecting just as
    // Codex finished an answer, is started again for the same clients, for as long as such
    // a read can last, instead of ending their terminal.
    const forward = (data: string): void => {
      if (attachments.get(paneId) !== attachment) return;
      attachment.replay.append(data);
      for (const client of attachment.clients) sendOutput(client, paneId, data);
      reconcileOutput(paneId);
    };
    let retries = 0;
    let refusedSince: number | null = null;
    /** the terminal attached to: a pane keeps its id across a server handoff, its terminal does not */
    let attachedTerminal = terminalId;
    const start = (): PtySession => {
      const collectNotifications = terminalNotifications.stream(attachedTerminal);
      const forwardLive = (data: string): void => {
        if (attachments.get(paneId) !== attachment) return;
        collectNotifications(data);
        forward(data);
      };
      let output = ""; // this attach's own last words: herdr's refusal is in them
      // its first bytes wait ATTACH_HOLD_MS: a refusal (herdr's setup, teardown and message)
      // is dropped then, never painted into the clients' terminal
      let held: string | null = "";
      let heldSince = 0;
      let holding = false;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      /** ended before its exit came: what it still prints is no attach's */
      let retired = false;
      const release = (): void => {
        clearTimeout(holdTimer);
        if (held === null) return;
        const data = held;
        held = null;
        if (data) forwardLive(data);
      };
      const took = (): void => {
        // a closed attachment's kill skips onExit, which would clear this timer: a newer
        // attachment on the pane must not hear this one's resume
        if (attachments.get(paneId) !== attachment) return;
        // a refusal whose exit comes late (a busy PC) is not an attach: resuming would free
        // the input to a pane another bridge may hold. Only output after it is an attach's.
        if (ATTACH_REFUSING_RE.test(output)) {
          if (Date.now() - heldSince < ATTACH_REFUSAL_EXIT_MS) {
            holdTimer = setTimeout(took, ATTACH_HOLD_MS);
            return;
          }
          // its exit is overdue: this try ends here, as that exit would have ended it (a pane
          // whose own output ends the same way waits for more output on a later try)
          retired = true;
          session.kill();
          ended(null);
          return;
        }
        // the attach took: a pane that waited for another bridge is this bridge's again
        if (attachment.held) {
          attachment.held = false;
          broadcast(paneId, { type: "attach-resumed", pane_id: paneId });
        }
        attachment.ready = true;
        broadcast(paneId, { type: "input-ready", pane_id: paneId });
        release();
      };
      const ended = (code: number | null): void => {
        clearTimeout(holdTimer);
        if (attachments.get(paneId) !== attachment) return;
        if (attachment.ready) broadcast(paneId, { type: "input-ready", pane_id: paneId, ready: false });
        attachment.ready = false;
        const now = Date.now();
        if (code !== 0 && ATTACH_READ_RACE_RE.test(output) && now - (refusedSince ??= now) < retryFor) {
          held = null;
          retries += 1;
          setTimeout(() => {
            if (attachments.get(paneId) !== attachment) return;
            try {
              attachment.pty = start();
            } catch (error) {
              // a throw here is uncaught and takes the whole server down: end this
              // pane's terminal instead, on the exited pty the record still holds
              const message = spawnFailure(paneId, error);
              broadcast(paneId, { type: "error", code: "command_failed", message });
              broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
              closeAttachment(paneId);
            }
          }, Math.min(ATTACH_RETRY_MS * 2 ** (retries - 1), ATTACH_RETRY_MAX_MS));
          return;
        }
        if (code !== 0 && ATTACH_HELD_RE.test(output)) {
          held = null; // herdr's refusal is not the pane's output: never painted, and it repeats
          // waiting for the other bridge is not a read race: the next one gets its full budget
          refusedSince = null;
          retries = 0;
          // Another web bridge holds herdr's one attach slot (two bridges on one herdr, e.g. a
          // second install beside the first). Its attach is left alone; this pane waits for it
          // to let go, trying again while anyone here still has it open, instead of ending.
          if (!attachment.held) broadcast(paneId, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: paneId });
          attachment.held = true;
          attachment.heldRetry = setTimeout(() => {
            if (attachments.get(paneId) !== attachment) return;
            if (attachment.clients.size === 0) {
              closeAttachment(paneId);
              return;
            }
            try {
              attachment.pty = start();
            } catch (error) {
              const message = spawnFailure(paneId, error);
              broadcast(paneId, { type: "error", code: "command_failed", message });
              broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
              closeAttachment(paneId);
            }
          }, heldRetry);
          return;
        }
        release();
        const finish = (): void => {
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        };
        // a refusal whose exit never came ended this try itself, on a terminal that is still there
        if (retired) return finish();
        // herdr ended the attach, maybe not the pane: after a live handoff the pane lives on under
        // a new terminal, and the same clients attach to that one. A pane that is gone, or still
        // on this terminal once the lookups run out, ended.
        const deadline = Date.now() + relookupFor;
        const again = (): void => {
          if (Date.now() >= deadline) return finish();
          attachment.relookup = setTimeout(relookup, ATTACH_RELOOKUP_MS);
        };
        const relookup = (): void => {
          // a herdr that takes the request and never answers must not hold the terminal past the
          // deadline: the lookup gets what is left of it, not the RPC's own 10 s
          terminalInfoFor(paneId, Math.max(1, deadline - Date.now())).then(({ terminalId: now }) => {
            if (attachments.get(paneId) !== attachment) return;
            if (now === attachedTerminal) return again();
            if (attachment.clients.size === 0) {
              closeAttachment(paneId);
              return;
            }
            attachedTerminal = now;
            // a new terminal gets the whole read-race budget
            refusedSince = null;
            retries = 0;
            try {
              attachment.pty = start();
            } catch (error) {
              const message = spawnFailure(paneId, error);
              broadcast(paneId, { type: "error", code: "command_failed", message });
              finish();
            }
          }, (error: unknown) => {
            if (attachments.get(paneId) !== attachment) return;
            if (error instanceof HerdrError && PANE_GONE_CODES.has(error.code)) return finish();
            // herdr is between servers (server_unavailable, connect_failed) or not answering (timeout): ask again
            again();
          });
        };
        relookup();
      };
      const session = new PtySession({
        command: process.env["HERDR_WEB_HERDR_BIN"] || "herdr",
        args: ["terminal", "attach", attachedTerminal],
        // herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET: the stream must reach
        // the same session the RPCs talk to, or a named session's terminals are
        // looked up on the default socket and the attach dies.
        env: { HERDR_SOCKET_PATH: herdrSocketPath() },
        cols: attachment.cols,
        rows: attachment.rows,
        onData: (data) => {
          if (retired || attachments.get(paneId) !== attachment) return;
          output = (output + data).slice(-1024);
          if (held === null) return forwardLive(data);
          held += data;
          if (!holding && !ATTACH_PREAMBLE_RE.test(held)) {
            holding = true;
            heldSince = Date.now();
            holdTimer = setTimeout(took, ATTACH_HOLD_MS);
          }
        },
        onExit: ended,
      });
      return session;
    };
    try {
      attachment.pty = start();
    } catch (error) {
      // Bun.spawn throws synchronously (node missing from PATH, fd or process limits): the
      // placeholder must go with it, or the next attach joins a record with no pty and
      // its close dereferences one (#154). The waiting attaches get the error in-band.
      attachments.delete(paneId);
      spawnFailure(paneId, error);
      throw error;
    }

    return attachment;
  }

  /** The attaching client sees the error in-band; the log is the only record the operator gets. */
  function spawnFailure(paneId: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`terminal attach for pane ${paneId} failed to start: ${message}`);
    return message;
  }

  function detach(paneId: string, client: Client): void {
    client.data.output.delete(paneId);
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    attachment.stalled.delete(client);
    if (attachment.clients.size === 0) closeAttachment(paneId);
    else reconcileOutput(paneId);
  }

  /**
   * Closes an attachment whose creating client detached or disconnected before it was
   * ready, unless a client still wants it: every attach records its pane in
   * `attached` before awaiting, so a joiner of the same creation that has not resumed
   * yet still counts and is not left holding a dead record.
   */
  function releaseUnclaimed(paneId: string, attachment: PaneAttachment): void {
    if (attachments.get(paneId) !== attachment || attachment.clients.size > 0) return;
    for (const other of clients) if (other.data.attached.has(paneId)) return;
    closeAttachment(paneId);
  }

  /** A broken state file must cost the alert, never the server (an unhandled rejection would). */
  const logPushError = (error: unknown): void => {
    console.error(`web push: ${error instanceof Error ? error.message : String(error)}`);
  };

  /** Status of EVERY pane, attached or not: one collector feeds all connected clients and web push. */
  function omoChanged(paneId: string, derived: AgentStatus, background: number, turn: boolean): void {
    // a background task starting or ending is no turn: the status stands, and nothing is alerted
    const status = turn ? completions.observe(paneId, derived, "omo") : completions.current(paneId) ?? completions.observe(paneId, derived, "omo");
    broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: status, background_tasks: background });
    if (turn) push.onStatus(paneId, status).catch(logPushError);
  }

  /** every new terminal gets a "pane N" name the agents in its workspace can address (docs/pane-mesh.md) */
  const paneMesh = createPaneMesh({
    snapshot: sessionSnapshot,
    rename: (paneId, label) => paneRename(paneId, label),
    // Numbering is metadata. Never rename existing user terminals automatically.
    enabled: () => false,
  });
  const collector = startStatusCollector({
    onStatus: (paneId, raw, agent, replay) => {
      // read back from a snapshot around a gap between subscriptions. An OmO pane's status there
      // is OmO's own or herdr's by turns (server/omo-status.ts), and a difference is no change
      if (replay && (omo.runs(paneId) || !completions.replayed(paneId, raw, replay))) return;
      // another agent took an OmO pane: what OmO worked on there is not that agent's to finish
      if (omo.named(paneId, agent)) completions.forget(paneId);
      // herdr says `claude/idle` for an OmO pane whatever it does: its own status stands
      if (omo.tracks(paneId)) return;
      // an agent herdr lost on the way still works and finishes as such (server/completion.ts);
      // an OmO pane whose session is not known keeps herdr's status, under its own name
      const status = completions.observe(paneId, raw, omo.runs(paneId) ? "omo" : agent);
      broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: status });
      push.onStatus(paneId, status).catch(logPushError);
    },
    // a finish reported as done, now in front at herdr's terminal: seen, idle again
    onFocus: (paneId) => {
      if (!completions.seen(paneId)) return;
      broadcastAll({ type: "pane-status", pane_id: paneId, agent_status: "idle" });
      push.onStatus(paneId, "idle").catch(logPushError);
    },
    onBaseline: (panes) => push.seed(panes),
    // the tracker first: what it makes of each pane (a finish after work is done, not idle) is
    // what the alerts are measured against from here, or the next event would alert of it
    onResync: (panes, newer) => {
      completions.resync(panes, newer);
      push.resync(panes.map((pane) => ({ ...pane, agent_status: completions.current(pane.pane_id) ?? pane.agent_status })), newer);
    },
    onPaneEnded: (paneId) => {
      completions.forget(paneId);
      broadcastAll({ type: "pane-exited", pane_id: paneId });
      push.onEnded(paneId).catch(logPushError);
    },
    onStructureChange: () => broadcastAll({ type: "session-changed" }),
    onPaneCreated: (pane) => void paneMesh.onPaneCreated(pane),
  }, { snapshot: rawSnapshot });
  omo.start();

  const envPort = process.env["PORT"];
  const server = Bun.serve<SocketData>({
    port: options.port ?? (envPort ? Number(envPort) : DEFAULT_PORT),
    hostname,

    async fetch(request, bunServer) {
      const url = new URL(request.url);
      let { pathname } = url;
      const bridgeAuthorized = isAuthenticated(request, bridgeToken);
      const bridgePath = pathname === "/api/bridge" || pathname === "/api/session" || pathname === "/api/agents" || pathname.startsWith("/api/pane/") || pathname.startsWith("/api/workspace/") || pathname.startsWith("/api/fs/") || pathname === "/ws";
      const ip = bunServer.requestIP(request);
      const access = decideAccess({
        loopback: ip !== null && isLoopbackAddress(ip.address),
        forwarded: cameThroughProxy(request.headers),
        funnel: request.headers.has("tailscale-funnel-request"),
        tailscaleLogin: request.headers.get("tailscale-user-login"),
        tokenMatched: token !== "" && isAuthenticated(request, token),
        device: devices.match(parseCookies(request.headers.get("cookie")).get(DEVICE_COOKIE)),
        ...identityOf(),
        tokenConfigured: token !== "",
        gated: devices.gated,
      });
      const authenticated = access.level === "full" || (bridgePath && bridgeAuthorized);

      if (requiresAuth(pathname) && !authenticated) {
        // The WS client never parses a body, so the upgrade refusal stays plain text.
        return pathname === "/ws" ? new Response("unauthorized", { status: 401 }) : unauthorizedJson(access.level === "none" ? access.reason : "token_required");
      }

      const readOnly = access.level === "full" && access.role === "watch";
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (pathname.startsWith("/api/") && mutating && !sameOrigin(request)) {
        return jsonResponse({ error: { code: "invalid_origin", message: "Use controls from this app" } }, 403);
      }
      // An empty segment ("//") reads as another route to the checks below, while the PC proxy
      // drops it before forwarding: `/api/machines/<id>//fs/file` would pass as not a file read.
      if (pathname.startsWith("/api/") && pathname.includes("//")) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
      // Watching a terminal grants no arbitrary filesystem access: those files include credentials.
      const fileRead = /^\/api\/(?:machines\/[^/]+\/)?fs\//.test(pathname);
      const ownPreferences = pathname === "/api/auth" || pathname === "/api/push/subscribe" || pathname === "/api/push/test";
      if (readOnly && (fileRead || mutating && !ownPreferences)) {
        return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
      }

      if (pathname === "/api/terminal-notifications" || pathname.startsWith("/api/terminal-notifications/")) {
        const notificationResponse = await terminalNotifications.handle(request, readOnly);
        if (notificationResponse) return notificationResponse;
      }
      if (pathname === "/api/android" || pathname.startsWith("/api/android/")) return handleAndroidRequest(request, android, readOnly);
      if (pathname === "/api/mobile-relay/stream") {
        if (request.method !== "GET" || !sameOrigin(request)) return new Response("invalid origin", { status: 403 });
        const deviceId = access.level === "full" ? access.device?.id : undefined;
        if (bunServer.upgrade(request, { data: { attached: new Set<string>(), mode: readOnly ? "observe" : "interact", output: new Map(), closing: false, deviceId, readOnly, mobileRelay: true } })) return undefined;
        return new Response("websocket required", { status: 400 });
      }
      if (pathname === "/api/mobile-relay" || pathname.startsWith("/api/mobile-relay/")) return mobileRelay.handle(request, readOnly);
      if (pathname === "/api/openrig/service") {
        const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
        try {
          if (request.method === "GET") return response(await openrigService.status());
          if (request.method !== "POST") return response({ error: { code: "method_not_allowed" } }, 405);
          if (openrigRequests) return response({ error: { code: "service_busy" } }, 409);
          const body = await boundedJson(request, 1024) as Record<string, unknown>;
          if (!body || Array.isArray(body) || typeof body.enabled !== "boolean" || Object.keys(body).length !== 1)
            return response({ error: { code: "invalid_request" } }, 400);
          // Reading a streamed request can yield while a launch or restore starts.
          // setEnabled takes its lock synchronously, so this final check closes that gap.
          if (openrigRequests) return response({ error: { code: "service_busy" } }, 409);
          return response(await openrigService.setEnabled(body.enabled));
        } catch (error) {
          return response({ error: { code: error instanceof OpenRigServiceError ? error.code : "service_control_failed" } }, error instanceof OpenRigServiceError ? error.status : 503);
        }
      }
      if (pathname === "/api/openrig" || pathname.startsWith("/api/openrig/")) {
        if (!openrigService.enabled || openrigService.busy) return Response.json({ error: { code: openrigService.busy ? "service_busy" : "openrig_disabled" } }, { status: 409, headers: { "Cache-Control": "no-store" } });
        // Readiness and status polling do not mutate teams and must not prevent
        // the user from stopping the service just after opening its panel.
        const mutating = request.method !== "GET";
        if (mutating) openrigRequests++;
        try { return await handleOpenRigRequest(request, openrig, readOnly); }
        finally { if (mutating) openrigRequests--; }
      }

      if (pathname === "/api/tmux/terminal") {
        if (request.method !== "GET" || !sameOrigin(request)) return new Response("invalid origin", { status: 403 });
        try {
          const target = { socket: url.searchParams.get("socket") ?? "", generation: url.searchParams.get("generation") ?? "", paneId: url.searchParams.get("paneId") ?? "" };
          const launch = await (await tmux.client(target.socket)).attachment(target, url.searchParams.get("sessionId") ?? "", readOnly);
          const terminal = new TmuxTerminal(launch, readOnly);
          const deviceId = access.level === "full" ? access.device?.id : undefined;
          if (bunServer.upgrade(request, { data: { attached: new Set<string>(), mode: readOnly ? "observe" : "interact", output: new Map(), closing: false, deviceId, readOnly, tmux: terminal } }))
            return undefined as unknown as Response;
          terminal.close();
          return new Response("websocket upgrade required", { status: 426 });
        } catch { return jsonResponse({ error: "tmux_attach_unavailable" }, 409); }
      }
      if (pathname === "/api/tmux" || pathname.startsWith("/api/tmux/")) return handleTmuxRequest(request, tmux, readOnly);

      if (pathname === "/api/bridge") {
        if (token === "" && !bridgeAuthorized) return unauthorizedJson();
        try { return jsonResponse(await bridgeIdentity(sidecar)); } catch (error) { return errorResponse(error); }
      }
      if (pathname === "/api/machines" || pathname.startsWith("/api/machines/")) {
        if (!machines) return jsonResponse({ error: { code: "bridge_only", message: "Manage PCs on the connection server" } }, 404);
        // /local aliases preserve every existing endpoint without a self-proxy.
        if (pathname.startsWith("/api/machines/local/")) {
          if (!sameOrigin(request) || (request.method !== "GET" && request.headers.get("x-herdr-machine") !== "1")) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
          pathname = pathname.replace("/api/machines/local/", "/api/");
          if (!/^\/api\/(session|agents|pane\/|workspace\/)/.test(pathname)) return badRequest("invalid_route", "Unknown PC endpoint");
          url.pathname = pathname;
        } else {
          bunServer.timeout(request, pathname === "/api/machines/events" ? 0 : 80);
          const deviceId = access.level === "full" ? access.device?.id : undefined;
          const response = await handleMachineRequest(request, machines, deviceId ? (close) => devices.onRevoke(deviceId, close) : undefined);
          response.headers.set("cache-control", "no-store");
          return response;
        }
      }
      if (pathname === "/ws") {
        if (!sameOrigin(request)) return new Response("invalid origin", { status: 403 });
        const deviceId = access.level === "full" ? access.device?.id : undefined;
        const machineId = url.searchParams.get("machine_id");
        if (machineId && machineId !== "local") {
          if (access.level === "none") return unauthorizedJson(access.reason);
          if (!machines?.endpoint(machineId)) return jsonResponse({ error: { code: "machine_offline", message: "This PC is disconnected" } }, 503);
          let relay: MachineRelay | undefined;
          try {
            relay = new MachineRelay(machines, machineId, readOnly);
            await relay.ready;
            const upgraded = bunServer.upgrade(request, { data: { attached: new Set<string>(), mode: readOnly ? "observe" : "interact", output: new Map(), closing: false, relay, deviceId, readOnly } });
            if (upgraded) return undefined as unknown as Response;
            relay.close();
          } catch { relay?.close(); return new Response("remote websocket unavailable", { status: 502 }); }
          return new Response("websocket upgrade required", { status: 426 });
        }
        const upgraded = bunServer.upgrade(request, { data: { attached: new Set<string>(), mode: readOnly ? "observe" : "interact", output: new Map(), closing: false, deviceId, readOnly } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("websocket upgrade required", { status: 426 });
      }

      if (pathname === "/api/auth") return handleAuthRequest(request, token);
      if (pathname === "/api/devices" || pathname.startsWith("/api/devices/")) {
        try {
          const response = await handleDeviceRequest(request, pathname, devices, access);
          if (request.method === "DELETE" && response.status === 204) {
            // The device registry is the delivery authority even if cleaning the push file fails.
            try { push.revokeDevice(pathname.slice("/api/devices/".length)); } catch (error) { logPushError(error); }
          }
          return response;
        } catch (error) { return errorResponse(error); }
      }

      if (pathname === "/api/updates" || pathname.startsWith("/api/updates/")) {
        return handleUpdateRequest(request, pathname, options.updates);
      }
      if (pathname === "/api/herdr/update") return handleHerdrUpdateRequest(request, options.herdrUpdate);

      if (pathname === "/api/usage") return handleUsageRequest(request, url, usage);
      // a long clip can keep the provider silent past Bun's 10 s idle limit before the first line
      if (pathname === "/api/voice" || pathname.startsWith("/api/voice/")) { bunServer.timeout(request, 120); return handleVoiceRequest(request, pathname, voice); }

      if (pathname === "/api/push" || pathname.startsWith("/api/push/")) {
        try {
          // a paired device owns its alerts; the open LAN (before any pairing) owns them only while
          // it stays open, like a subscription from before owners (undefined); a local/token/
          // Tailscale sign-in is the owner (null)
          const owner = access.level !== "full" ? null : access.device?.id ?? (access.via === "open" ? undefined : null);
          const answered = await handlePushRequest(request, pathname, push, owner);
          if (answered) return answered;
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/health") {
        const auth: HealthAuth = access.level === "full"
          ? { required: false, authenticated: true, via: access.via, role: access.role }
          : { required: true, authenticated, ...(authenticated ? {} : { reason: access.reason }) };
        if (url.searchParams.get("scope") === "bridge") return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL });
        try {
          const info = await ping();
          // a forced answer (tests) and a runtime without the PTY sidecar are told the way a Windows herdr's own would be
          const herdr = attachableIdentity(info, sidecar);
          return jsonResponse({ ok: true, herdr, auth,
            web_ui: { boot_id: process.env["HERDR_WEB_BOOT_ID"] ?? null, revision: process.env["HERDR_WEB_REVISION"] ?? null } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/access") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        return jsonResponse(await remoteAccess(bunServer.port ?? DEFAULT_PORT), 200, { "cache-control": "no-store" });
      }

      if (pathname.startsWith("/api/panes/by-number/")) {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const number = pathname.slice("/api/panes/by-number/".length);
        if (!/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(Number(number))) return badRequest("invalid_pane_number", "positive integer required");
        try {
          const snapshot = await clientSnapshot();
          const matches = snapshot.panes.filter(pane => (pane as typeof pane & {global_pane_number?: number}).global_pane_number === Number(number));
          if (matches.length !== 1) return jsonResponse({error: matches.length ? "ambiguous_pane_number" : "pane_number_not_found"}, matches.length ? 409 : 404);
          const pane = matches[0]!;
          return jsonResponse({number:Number(number),pane_id:pane.pane_id,terminal_id:pane.terminal_id,workspace_id:pane.workspace_id},200,{"cache-control":"no-store"});
        } catch (error) { return errorResponse(error); }
      }

      if (pathname === "/api/session") {
        try {
          return jsonResponse({ snapshot: await clientSnapshot() });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/agents") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        try {
          const kinds = new Set((await agentManifests()).manifests.map((manifest) => manifest.agent));
          kinds.add("omp");
          kinds.add("claude");
          // not herdr kinds: offered where this server can run them (see shell-agent.ts)
          for (const kind of Object.keys(SHELL_AGENTS)) if (shellAgentExecutable(kind)) kinds.add(kind);
          const agents: AgentKind[] = [...kinds]
            .map((kind) => ({ kind, label: AGENT_LABELS[kind] ?? kind }))
            .sort((left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind));
          return jsonResponse({ agents });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/fs/stat" || pathname === "/api/fs/file") {
        if (request.method !== "GET" && request.method !== "HEAD") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        let cwd: string | null = null;
        if (paneId) {
          try { cwd = (await paneContext(paneId)).cwd; } catch { /* an absolute path still opens */ }
        }
        const found = locateFile(url.searchParams.get("path") ?? "", cwd);
        if (found === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
        // several files end in that name: the viewer lists them to choose from
        if ("candidates" in found) return jsonResponse({ error: { code: "ambiguous_path", message: "several files have that name", candidates: found.candidates } }, 409);
        return pathname === "/api/fs/stat" ? jsonResponse(found.info) : fileResponse(found.info, url.searchParams.get("download") === "1");
      }

      if (pathname === "/api/workspace/directories") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        // a folder a pane's chat names is read from that pane's folder, as a file it names is
        const paneId = url.searchParams.get("pane_id");
        let base: string | undefined;
        if (paneId) {
          try { base = (await paneContext(paneId)).cwd; } catch { /* an absolute path still lists */ }
          // a relative path whose pane is gone has no folder to be read from: not the server's own
          const path = (url.searchParams.get("path") ?? "").trim();
          if (base === undefined && path !== "" && path !== "~" && !path.startsWith("~/") && !isAbsolute(path)) return badRequest("invalid_cwd", "the pane a relative path belongs to is gone");
        }
        const listing = listDirectories(url.searchParams.get("path") ?? "", url.searchParams.get("hidden") === "1", url.searchParams.get("files") === "1", base);
        return listing === null ? badRequest("invalid_cwd", "path must be a directory this user can read") : jsonResponse(listing);
      }

      if (pathname === "/api/pane/split") return handlePaneSplit(request);
      if (pathname === "/api/pane/move") return handlePaneMove(request);

      if (pathname === "/api/workspace/create") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { cwd?: unknown; label?: unknown; agent?: { kind?: unknown; name?: unknown; args?: unknown } | null };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        // the client sends null for "not given": treat it exactly like an absent field
        if (payload.cwd === null) delete payload.cwd;
        if (payload.label === null) delete payload.label;
        if (payload.agent === null) delete payload.agent;
        if (payload.cwd !== undefined && typeof payload.cwd !== "string") return badRequest("invalid_cwd", "cwd must be an existing directory");
        const cwd = payload.cwd === undefined ? undefined : expandedDirectory(payload.cwd);
        if (payload.cwd !== undefined && cwd === null) return badRequest("invalid_cwd", "cwd must be an existing directory");
        if (payload.label !== undefined && typeof payload.label !== "string") return badRequest("missing_label", "label must be a string");
        if (payload.agent !== undefined && (typeof payload.agent !== "object" || typeof payload.agent.kind !== "string" || payload.agent.kind.length === 0)) {
          return badRequest("invalid_agent", "agent.kind is required");
        }
        if (payload.agent && ((payload.agent.name !== undefined && typeof payload.agent.name !== "string")
          || (payload.agent.args !== undefined && (!Array.isArray(payload.agent.args) || !payload.agent.args.every((arg) => typeof arg === "string"))))) {
          return badRequest("invalid_agent", "agent.name must be a string and agent.args must be an array of strings");
        }
        // agent.start can legitimately take a minute; Bun's default idle timeout is shorter.
        if (payload.agent) bunServer.timeout(request, 75);
        try {
          const created = await workspaceCreate({
            ...(cwd === undefined || cwd === null ? {} : { cwd }),
            ...(typeof payload.label === "string" ? { label: payload.label } : {}),
          });
          if (!payload.agent) {
            return jsonResponse({ workspace_id: created.workspace.workspace_id, pane_id: created.root_pane.pane_id, agent_started: false });
          }
          try {
            const kind = payload.agent.kind as string;
            if (isShellAgentKind(kind)) await startShellAgent(kind, created.root_pane.pane_id, payload.agent.args as string[] | undefined);
            else {
              const given = typeof payload.agent.name === "string" && payload.agent.name.length > 0 ? payload.agent.name : null;
              // herdr refuses a name another agent holds. Two creations at once can pick the same
              // free one: the refused one picks again. It also refuses a pane whose shell is not up
              // yet (`agent_pane_busy`, herdr 0.9.3), which a workspace made a moment ago can be.
              const shellDeadline = Date.now() + 10_000;
              for (let attempt = 1; ; ) {
                try {
                  await agentStart({
                    name: given ?? freeAgentName(kind, (await sessionSnapshot()).agents.map((agent) => agent.name)),
                    kind,
                    paneId: created.root_pane.pane_id,
                    ...(payload.agent.args === undefined ? {} : { args: payload.agent.args as string[] }),
                    timeoutMs: 60_000,
                  });
                  break;
                } catch (error) {
                  if (!(error instanceof HerdrError)) throw error;
                  if (error.code === "agent_pane_busy" && Date.now() < shellDeadline) {
                    await Bun.sleep(100);
                    continue;
                  }
                  if (given !== null || attempt === 3 || error.code !== "agent_name_taken") throw error;
                  attempt += 1;
                }
              }
            }
            return jsonResponse({ workspace_id: created.workspace.workspace_id, pane_id: created.root_pane.pane_id, agent_started: true });
          } catch (error) {
            return jsonResponse({
              workspace_id: created.workspace.workspace_id,
              pane_id: created.root_pane.pane_id,
              agent_started: false,
              error: {
                code: error instanceof HerdrError ? error.code : "agent_start_failed",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/workspace/rename" || pathname === "/api/workspace/move" || pathname === "/api/workspace/close") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { workspace_id?: unknown; label?: unknown; insert_index?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.workspace_id !== "string" || payload.workspace_id.length === 0) {
          return badRequest("missing_workspace_id", "workspace_id is required");
        }
        if (pathname === "/api/workspace/rename" && typeof payload.label !== "string") {
          return badRequest("missing_label", "label is required");
        }
        if (pathname === "/api/workspace/move" && (typeof payload.insert_index !== "number" || !Number.isInteger(payload.insert_index) || payload.insert_index < 0)) {
          return badRequest("invalid_index", "insert_index must be a non-negative integer");
        }
        try {
          if (pathname === "/api/workspace/rename") await workspaceRename(payload.workspace_id, payload.label as string);
          else if (pathname === "/api/workspace/move") await workspaceMove(payload.workspace_id, payload.insert_index as number);
          else await workspaceClose(payload.workspace_id);
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/rename") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: unknown; label?: unknown; terminal_id?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
        if (typeof payload.label !== "string") return badRequest("missing_label", "label is required");
        try {
          if (payload.terminal_id !== undefined) {
            const current = (await sessionSnapshot()).panes.find(pane => pane.pane_id === payload.pane_id);
            if (!current || current.terminal_id !== payload.terminal_id) return jsonResponse({error: "terminal_changed"}, 409);
          }
          await paneRename(payload.pane_id, payload.label.length === 0 ? null : payload.label);
          broadcastAll({ type: "session-changed" });
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/commands" || pathname === "/api/pane/files") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        try {
          const context = await paneContext(paneId);
          if (pathname === "/api/pane/commands") {
            // herdr names an omo pane `pi` while omo waits: pi's commands and templates are not omo's
            const agent = context.agent === "pi" && await paneRunsOmo(paneId) ? "omo" : context.agent;
            return jsonResponse({ commands: paneCommands(agent, context.cwd) });
          }
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw === null ? 20 : Number(limitRaw);
          if (!Number.isInteger(limit) || limit < 1) return badRequest("invalid_limit", "limit must be a positive integer");
          return jsonResponse({ files: await paneFiles(context.cwd, url.searchParams.get("q") ?? "", Math.min(limit, 100)) });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/omo-tasks") {
        if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const session = omo.sessionOf(paneId);
        // server_time: the browser's clock can differ from this PC's, and the list says how long tasks ran
        const server_time = new Date().toISOString();
        if (session === null) return jsonResponse({ tasks: [], runs: [], server_time });
        return jsonResponse({ tasks: omoTasks(session.cwd, session.sessionId, processAlive), runs: omoRuns(session.cwd, session.sessionId), server_time });
      }

      if (pathname === "/api/pane/read") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const linesRaw = url.searchParams.get("lines");
        const lines = linesRaw === null ? undefined : Number(linesRaw);
        if (lines !== undefined && !Number.isFinite(lines)) {
          return badRequest("invalid_lines", "lines must be a number");
        }
        try {
          const read = await paneRead({
            paneId,
            source: (url.searchParams.get("source") ?? "visible") as never,
            format: (url.searchParams.get("format") ?? "text") as never,
            ...(lines === undefined ? {} : { lines }),
          });
          return jsonResponse({ read });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/scroll") {
        if (request.method === "GET") {
          const paneId = url.searchParams.get("pane_id");
          if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
          try {
            return jsonResponse({ scroll: await paneScrollInfo(paneId) });
          } catch (error) {
            return errorResponse(error);
          }
        }
        if (request.method !== "POST") return badRequest("method_not_allowed", "use GET or POST");
        let payload: { pane_id?: unknown; offset_from_bottom?: unknown };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || payload.pane_id.length === 0) return badRequest("missing_pane_id", "pane_id is required");
        if (!isCount(payload.offset_from_bottom)) return badRequest("invalid_offset", "offset_from_bottom must be a non-negative integer");
        try {
          return jsonResponse({ scroll: await paneScroll(payload.pane_id, payload.offset_from_bottom) });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/selection") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const [anchorRow, anchorCol, cursorRow, cursorCol] = ["anchor_row", "anchor_col", "cursor_row", "cursor_col"]
          .map((name) => { const raw = url.searchParams.get(name); return raw === null || raw === "" ? NaN : Number(raw); });
        if (![anchorRow, anchorCol, cursorRow, cursorCol].every(isCount)) {
          return badRequest("invalid_range", "anchor_row, anchor_col, cursor_row and cursor_col must be non-negative integers");
        }
        try {
          const text = await paneSelectionRead(paneId, { row: anchorRow!, col: anchorCol! }, { row: cursorRow!, col: cursorCol! });
          return jsonResponse({ text });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation/tool-output") {
        const paneId = url.searchParams.get("pane_id");
        const ref = url.searchParams.get("ref");
        if (!paneId || !ref) return badRequest("missing_parameter", "pane_id and ref query parameters are required");
        try {
          const output = await toolOutput(paneId, ref, options.codexHome);
          if (output === null) return jsonResponse({ error: { code: "output_not_found", message: "no such tool call in this pane's conversation" } }, 404);
          return new Response(output, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=86400, immutable", "x-content-type-options": "nosniff" } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation/image") {
        const paneId = url.searchParams.get("pane_id");
        const ref = url.searchParams.get("ref");
        if (!paneId || !ref) return badRequest("missing_parameter", "pane_id and ref query parameters are required");
        try {
          const image = await conversationImage(paneId, ref, options.codexHome);
          if (image === null) return jsonResponse({ error: { code: "image_not_found", message: "no such image in this pane's conversation" } }, 404);
          // Claude embeds immutable bytes; a Codex attachment may name a local file that changes.
          return new Response(image.bytes, { headers: { "content-type": image.mediaType, "cache-control": ref.startsWith("codex-") ? "private, no-store" : "private, max-age=86400, immutable", "x-content-type-options": "nosniff" } });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/conversation") {
        const paneId = url.searchParams.get("pane_id");
        if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
        const page = {
          before: url.searchParams.get("before") ?? undefined,
          since: url.searchParams.get("since") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
        };
        try {
          const { version, ...conversation } = await paneConversation(paneId, options.codexHome, page);
          // The chat polls every 2s: an unchanged conversation answers 304 with no body.
          // no-store keeps the browser's own cache out of it, so the chat sees the 304.
          const etag = `"${version}"`;
          const headers = { etag, "cache-control": "no-store" };
          if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
          return jsonResponse(conversation, 200, headers);
        } catch (error) {
          if (error instanceof HistoryChanged) return jsonResponse({ error: { code: "history_changed", message: error.message } }, 409);
          // an unrecognized pane is not an error: the client falls back to the
          // scrollback transcript, exactly like chatmux's terminal fallback
          if (error instanceof ConversationUnavailable) return jsonResponse({ source: "scrollback", turns: [] });
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/input" || pathname === "/api/pane/keys") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string; text?: string; keys?: string[] };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        try {
          if (pathname === "/api/pane/input") {
            if (typeof payload.text !== "string") return badRequest("missing_text", "text is required");
            await paneSendText(payload.pane_id, payload.text);
          } else {
            if (!Array.isArray(payload.keys) || !payload.keys.every((key) => typeof key === "string")) return badRequest("missing_keys", "keys must be an array");
            await paneSendKeys(payload.pane_id, payload.keys);
          }
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/close") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string; terminal_id?: string };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        try {
          // herdr emits pane.closed -> the collector broadcasts session-changed, so
          // every client refetches and the pane leaves sidebars on its own
          if (payload.terminal_id !== undefined) {
            const current = (await sessionSnapshot()).panes.find(pane => pane.pane_id === payload.pane_id);
            if (!current || current.terminal_id !== payload.terminal_id) return jsonResponse({ error: "terminal_changed" }, 409);
          }
          await paneClose(payload.pane_id);
          broadcastAll({ type: "session-changed" });
          return jsonResponse({ ok: true });
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname === "/api/pane/image") {
        if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
        let payload: { pane_id?: string; content_type?: string; data_base64?: string; name?: string };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return badRequest("invalid_json", "request body must be JSON");
        }
        if (!isJsonObject(payload)) return badRequest("invalid_body", "request body must be a JSON object");
        if (typeof payload.pane_id !== "string" || !payload.pane_id.trim()) return badRequest("missing_pane_id", "pane_id is required");
        if ((payload.content_type !== undefined && typeof payload.content_type !== "string")
          || (payload.data_base64 !== undefined && typeof payload.data_base64 !== "string")
          || (payload.name !== undefined && typeof payload.name !== "string")) {
          return badRequest("invalid_image", "content_type, data_base64 and name must be strings");
        }
        try {
          const path = await savePaneImage({
            paneId: payload.pane_id,
            contentType: payload.content_type ?? "",
            dataBase64: payload.data_base64 ?? "",
            name: payload.name,
          });
          return jsonResponse({ ok: true, path });
        } catch (error) {
          if (error instanceof PasteImageError) {
            return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
          }
          return errorResponse(error);
        }
      }

      if (pathname.startsWith("/api/pane/prompt")) {
        try {
          const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome });
          if (response) return response;
        } catch (error) {
          return errorResponse(error);
        }
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${pathname}` } }, 404);
      }

      // static client - public even when the API is gated, so the login UI can load
      return serveStatic(pathname);
    },

    websocket: {
      // This transport cap also covers clients that predate application ACKs.
      backpressureLimit: OUTPUT_HARD_BYTES,
      closeOnBackpressureLimit: true,
      drain(client) {
        for (const paneId of client.data.attached) reconcileOutput(paneId);
      },
      async open(client) {
        if (client.data.deviceId) {
          client.data.unwatchDevice = devices.onRevoke(client.data.deviceId, () => {
            client.data.revoked = true;
            client.data.closing = true;
            clients.delete(client);
            for (const paneId of client.data.attached) detach(paneId, client);
            client.data.attached.clear();
            client.data.output.clear();
            client.data.relay?.close(1008, "Device access revoked");
            client.data.tmux?.close(1008, "Device access revoked");
            if (client.data.mobileRelay) mobileRelay.detach(client);
            client.close(1008, "Device access revoked");
          });
          if (client.data.revoked) return;
        }
        if (client.data.mobileRelay) { mobileRelay.attach(client, client.data.readOnly === true); return; }
        if (client.data.tmux) {
          tmuxClients.add(client.data.tmux);
          try { client.data.tmux.bind(client as ServerWebSocket<unknown>); }
          catch { client.data.tmux.close(1011, "Terminal host unavailable"); }
          return;
        }
        if (client.data.relay) { client.data.relay.bind(client as ServerWebSocket<unknown>); return; }
        clients.add(client);
        try {
          send(client, { type: "snapshot", snapshot: await clientSnapshot(), features: SERVER_FEATURES });
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "snapshot_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      async message(client, raw) {
        if (client.data.closing) return;
        if (client.data.mobileRelay) { mobileRelay.message(client, typeof raw === "string" ? raw : new Uint8Array(raw)); return; }
        if (client.data.tmux) { client.data.tmux.message(raw); return; }
        if (client.data.relay) { client.data.relay.message(raw); return; }
        let message: ClientMessage;
        try {
          message = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          send(client, { type: "error", code: "invalid_json", message: "message must be JSON" });
          return;
        }
        try {
          switch (message.type) {
            case "attach": {
              if (message.flow_control !== undefined && message.flow_control !== "ack") {
                send(client, { type: "error", code: "invalid_flow_control", message: "flow_control must be ack" });
                break;
              }
              const geometry = validGeometry(message.cols, message.rows);
              if (!geometry) {
                send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
                break;
              }
              // record the pane before the await: a detach (switching panes) or a close
              // that lands while the terminal is looked up must cancel this attach, and
              // neither can see a client that only joins the attachment afterwards
              client.data.attached.add(message.pane_id);
              let attachment: PaneAttachment;
              try {
                // a covered grid (keep_size) creates the pty at the pane's own size, as an observer does
                attachment = await ensureAttachment(message.pane_id, geometry.cols, geometry.rows, client.data.mode === "observe" || message.keep_size === true);
              } catch (error) {
                client.data.attached.delete(message.pane_id);
                throw error;
              }
              if (!client.data.attached.has(message.pane_id)) {
                releaseUnclaimed(message.pane_id, attachment);
                break;
              }
              // a mirror whose pane went away during its first read has already ended: joining
              // it would leave this client on a terminal that never says anything again
              if (attachment.mirror && attachments.get(message.pane_id) !== attachment) {
                client.data.attached.delete(message.pane_id);
                send(client, { type: "pty-exit", pane_id: message.pane_id, code: null });
                break;
              }
              // An idempotent attach must not replay terminal bytes a second time.
              const alreadyAttached = attachment.clients.has(client);
              attachment.clients.add(client);
              if (!alreadyAttached && message.flow_control === "ack") client.data.output.set(message.pane_id, new OutputWindow());
              // a mirrored screen is drawn for the pane's own grid: the client takes that size
              // before the screen, or the rows would wrap in a grid of another width
              if (attachment.mirror) send(client, { type: "pane-geometry", pane_id: message.pane_id, cols: attachment.cols, rows: attachment.rows, fixed: true });
              // hand the newcomer the current screen it would otherwise have missed
              // (a mirror keeps its latest screen whole; a pty keeps a bounded tail of its stream)
              const replay = attachment.mirror ? attachment.mirror.current ?? "" : attachment.replay.text();
              if (!alreadyAttached && replay) sendOutput(client, message.pane_id, replay);
              // a pane waiting for another web bridge to let go says so to each newcomer, too
              if (!alreadyAttached && attachment.held) send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
              reconcileOutput(message.pane_id);
              if (client.data.closing) break;
              if (attachment.ready && !attachment.held) send(client, { type: "input-ready", pane_id: message.pane_id });
              if (attachment.mirror) break;
              if (client.data.mode === "interact" && message.keep_size !== true) {
                // an operator's viewport owns the shared grid
                resizePty(message.pane_id, geometry.cols, geometry.rows);
              } else {
                // an observer, or a grid the chat lens covers, adopts the grid the operators left behind
                send(client, {
                  type: "pane-geometry",
                  pane_id: message.pane_id,
                  cols: attachment.cols,
                  rows: attachment.rows,
                });
              }
              break;
            }
            case "detach": {
              client.data.attached.delete(message.pane_id);
              detach(message.pane_id, client);
              break;
            }
            case "pty-ack": {
              // Observers may acknowledge output, but never input or resize it.
              const window = client.data.output.get(message.pane_id);
              if (window && window.id === message.stream_id && !window.acknowledge(message.stream_id, message.offset)) {
                send(client, { type: "error", code: "invalid_ack", message: "offset must acknowledge bytes already sent" });
                break;
              }
              reconcileOutput(message.pane_id);
              break;
            }
            case "input": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              // typing goes straight through the pty, unless a composer message is still in
              // flight: then it waits its turn and goes the message's own way (send_text), since
              // the pty holds a lone ESC ~150ms and a Stop would overtake nothing
              // typing reaches an attached pane only, queued or not
              const attachment = attachments.get(message.pane_id);
              const inputFailed = () => {
                if (clients.has(client)) send(client, { type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: message.pane_id });
              };
              // without a pty (Windows: no terminal, or a mirrored one) typing, the key bar's Enter,
              // Stop and arrows go through herdr itself, each in its turn behind a message in flight.
              // The turn is taken before herdr is asked what it can do: a message sent while
              // that answer is on its way must not overtake the typing.
              if (terminalAttachKnown === false || (!attachment && terminalAttachKnown === null)) {
                const text = message.text;
                void serialize(message.pane_id, async () => {
                  // a herdr that attaches: typing reaches an attached pane only
                  if (await terminalAttach()) { inputFailed(); return; }
                  // a pasted block asks herdr what the pane runs, so it is shaped before the checks below
                  const shaped = await mirrorInput(text, async () => (await paneContext(message.pane_id)).agent);
                  // nothing typed outlives its connection
                  if (!clients.has(client)) return;
                  authorizeSocket(client);
                  await paneSendText(message.pane_id, shaped);
                  // the echo is read at once, not at the mirror's next idle read
                  attachments.get(message.pane_id)?.mirror?.poke();
                }).catch(inputFailed);
                break;
              }
              // another web bridge has this pane's terminal: nothing typed here reaches it
              if (!attachment?.clients.has(client) || !attachment.ready || attachment.held) {
                send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
                break;
              }
              if (paneQueues.has(message.pane_id)) {
                const text = message.text;
                // typed into this attach: one that ended meanwhile (and was attached again) takes none of it
                const pty = attachment.pty;
                void serialize(message.pane_id, () => {
                  // held while this waited its turn: it goes nowhere, as unqueued typing would
                  if (attachments.get(message.pane_id) !== attachment || attachment.pty !== pty || !attachment.clients.has(client) || !attachment.ready || attachment.held) { inputFailed(); return; }
                  // nothing typed outlives its connection
                  if (!clients.has(client)) return;
                  authorizeSocket(client);
                  return paneSendText(message.pane_id, text);
                }).catch(inputFailed);
              } else {
                if (!attachment.pty.write(message.text)) { inputFailed(); break; }
                lastTyped.set(message.pane_id, Date.now());
                if (lastTyped.size > 64) {
                  for (const [pane, at] of lastTyped) if (Date.now() - at > TYPED_SETTLE_MS) lastTyped.delete(pane);
                }
              }
              break;
            }
            case "resize": {
              if (client.data.closing) break;
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              const geometry = validGeometry(message.cols, message.rows);
              if (!geometry) {
                send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
                break;
              }
              // the pty is still being created (an attach from the chat lens, then the switch to the
              // terminal lens before the terminal was looked up): the resize waits for it. Dropped,
              // it would leave the pty at the pane's own grid under a terminal fitted to another.
              if (!client.data.attached.has(message.pane_id)) {
                send(client, { type: "error", code: "not_attached", message: "attach the pane before resizing", pane_id: message.pane_id });
                break;
              }
              const creating = attachments.has(message.pane_id) ? undefined : pendingAttachments.get(message.pane_id);
              if (creating) {
                try { await creating; } catch { break; }
                if (client.data.closing || client.data.mode !== "interact" || !client.data.attached.has(message.pane_id)) break;
              }
              // A detach or a retired attachment must not resize another client's grid.
              if (!attachments.get(message.pane_id)?.clients.has(client)) break;
              resizePty(message.pane_id, geometry.cols, geometry.rows);
              break;
            }
            case "keys": {
              if (client.data.mode === "observe") {
                send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
                break;
              }
              if (attachments.get(message.pane_id)?.held) {
                send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
                break;
              }
              await serialize(message.pane_id, async () => {
                // held while this waited its turn (the attach was refused after the check above)
                if (attachments.get(message.pane_id)?.held) {
                  send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
                  return;
                }
                // a key pressed by a connection that has gone since is not pressed
                if (!clients.has(client)) return;
                authorizeSocket(client);
                await paneSendKeys(message.pane_id, message.keys);
                attachments.get(message.pane_id)?.mirror?.poke();
              });
              break;
            }
            case "secret": {
              // Refuse busy panes instead of retaining the secret behind another send.
              const result = (ok: boolean, code?: string) => send(client, {
                type: "secret-result", id: message.id, pane_id: message.pane_id, ok, ...(code ? { code } : {}),
              });
              try {
                if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string"
                  || typeof message.prompt !== "string" || secretPrompt(message.prompt) !== message.prompt || !validSecret(message.secret)) {
                  result(false, "invalid_secret"); break;
                }
                if (client.data.mode === "observe") { result(false, "read_only"); break; }
                const attachment = attachments.get(message.pane_id);
                if (!attachment?.clients.has(client)) { result(false, "not_attached"); break; }
                if (!attachment.ready || attachment.held) { result(false, "input_not_ready"); break; }
                if (paneQueues.has(message.pane_id)) { result(false, "pane_busy"); break; }
                await serialize(message.pane_id, async () => {
                  const screen = await paneRead({ paneId: message.pane_id, source: "visible", format: "text" });
                  if (client.data.closing || client.data.mode === "observe") { result(false, "read_only"); return; }
                  authorizeSocket(client);
                  if (!attachment.clients.has(client) || attachments.get(message.pane_id) !== attachment) { result(false, "not_attached"); return; }
                  if (!attachment.ready || attachment.held) { result(false, "input_not_ready"); return; }
                  if (secretPrompt(screen.text, attachment.cols) !== message.prompt) { result(false, "prompt_changed"); return; }
                  if (attachment.mirror) {
                    // A mirrored pane has no pty to type into: the secret is herdr's text, then the
                    // Enter key (a `\r` inside the text is not Enter to every shell). Both are awaited,
                    // so a send herdr refused is answered as failed, not as entered.
                    await paneSendText(message.pane_id, message.secret);
                    await paneSendKeys(message.pane_id, ["Enter"]);
                  } else {
                    // Direct attach keystrokes: no agent transcript, RPC payload or delayed Enter.
                    if (!attachment.pty.write(`${message.secret}\r`)) { result(false, "input_not_ready"); return; }
                  }
                  result(true);
                });
              } catch {
                // Never forward an exception that might include submitted bytes.
                result(false, "secret_failed");
              } finally { message.secret = ""; }
              break;
            }
            case "submit": {
              // every submit is answered: the composer keeps its text until it hears back
              const result = (ok: boolean, code?: string, text?: string) => send(client, {
                type: "submit-result", id: message.id, pane_id: message.pane_id, ok, ...(code ? { code, message: text } : {}),
              });
              if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
                || typeof message.text !== "string" || typeof message.payload !== "string") {
                send(client, { type: "error", code: "invalid_submit", message: "id must be an integer, pane_id, text and payload strings" });
                break;
              }
              if (client.data.mode === "observe") {
                result(false, "read_only", "this connection is in observe mode");
                break;
              }
              // another web bridge has this pane's terminal: its user types there, not this one
              if (attachments.get(message.pane_id)?.held) {
                result(false, "attach_held", ATTACH_HELD_MESSAGE);
                break;
              }
              const arrivedAt = (options.submitNow ?? performance.now.bind(performance))();
              try {
                await serialize(message.pane_id, () => {
                  // held while this waited its turn (the attach was refused after the check above)
                  if (attachments.get(message.pane_id)?.held) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
                  return submitText(message.pane_id, message.text, message.payload, arrivedAt, message.typed === true, () => authorizeSocket(client));
                });
                result(true);
              } catch (error) {
                result(false, error instanceof HerdrError ? error.code : "submit_failed", error instanceof Error ? error.message : String(error));
              }
              break;
            }
            case "role": {
              if (message.mode !== "interact" && message.mode !== "observe") {
                send(client, { type: "error", code: "invalid_role", message: "mode must be interact or observe" });
                break;
              }
              if (client.data.readOnly) message.mode = "observe";
              client.data.mode = message.mode;
              send(client, { type: "role-ack", mode: message.mode });
              if (message.mode === "observe") {
                // the fresh observer needs the grid it must adopt
                for (const paneId of client.data.attached) {
                  const attachment = attachments.get(paneId);
                  if (attachment) {
                    send(client, { type: "pane-geometry", pane_id: paneId, cols: attachment.cols, rows: attachment.rows });
                  }
                }
              }
              break;
            }
          }
        } catch (error) {
          const code = error instanceof HerdrError ? error.code : "command_failed";
          send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
        }
      },

      close(client) {
        client.data.unwatchDevice?.();
        if (client.data.mobileRelay) { mobileRelay.detach(client); return; }
        if (client.data.tmux) { tmuxClients.delete(client.data.tmux); client.data.tmux.close(); return; }
        if (client.data.relay) { client.data.relay.close(); return; }
        clients.delete(client);
        for (const paneId of client.data.attached) detach(paneId, client);
        client.data.attached.clear();
        client.data.output.clear();
      },
    },
  });

  const registration = options.registerBridge ? registerBridge(server.port ?? 0, bridgeToken) : null;

  // ACKs can stop arriving entirely (a suspended tab). Bound the pause even then.
  const outputTimer = setInterval(() => {
    for (const paneId of attachments.keys()) reconcileOutput(paneId);
  }, 100);
  outputTimer.unref();

  return {
    port: server.port ?? 0,
    hostname,
    stop: () => {
      clearInterval(outputTimer);
      android.dispose();
      terminalNotifications.close();
      mobileRelay.dispose();
      openrig.dispose();
      collector.stop();
      omo.stop();
      machines?.stop();
      registration?.close();
      for (const terminal of tmuxClients) terminal.close(1001, "Web bridge stopped");
      paneNumbers.close();
      for (const paneId of [...attachments.keys()]) closeAttachment(paneId);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  if (existsSync(join(import.meta.dir, '..', '.termweave-owned.json')) && process.env.TERMWEAVE_OWNED_LAUNCH !== '1') throw new Error('Owned installation requires the recorded foreground lifecycle launcher');
  const configuredHost = process.env.HOST ?? '127.0.0.1';
  if (!LOOPBACK_HOSTNAMES.has(configuredHost) && (!process.env.HERDR_WEB_TOKEN || process.env.TERMWEAVE_EXTERNAL_ACCESS !== '1')) throw new Error('External binding requires TERMWEAVE_EXTERNAL_ACCESS=1 and a configured token');
  const instance = createServer({ updates: connectUpdater(), registerBridge: true });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    instance.stop();
    // Attach sidecars need ~1.2s to release herdr's exclusive client slot.
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (process.env["HERDR_WEB_MANAGED"] === "1") process.on("disconnect", shutdown);
  console.log(`herdr-web-ui listening on http://${instance.hostname}:${instance.port}`);
  if ((process.env["HERDR_WEB_TOKEN"] ?? "") === "" && !LOOPBACK_HOSTNAMES.has(instance.hostname)) {
    console.error(
      `WARNING: listening on ${instance.hostname} without HERDR_WEB_TOKEN - unauthenticated external access is denied. Configure explicit authenticated exposure or keep HOST=127.0.0.1.`,
    );
  }
}
