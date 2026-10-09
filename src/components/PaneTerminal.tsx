import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";

/** a Hangul jamo or syllable run, as the macOS Korean IME inserts it */
const HANGUL_TEXT = /^[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]+$/;
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TriangleAlert } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import "./PaneTerminal.css";

import { HerdrSocket } from "../lib/ws.ts";
import { controlCode, isPrintable, keySequence, type KeyBarKey } from "../lib/keys.ts";
import { EMPTY_DRAFT, applyToDraft, draftIsEmpty, type InputDraft } from "../lib/draft.ts";
import { messageQueues } from "../lib/messageQueue.ts";
import { MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, composerMessage, composerPayload, submitNote } from "../lib/compose.ts";
import { answerFromText, answerHint, answerRefusal, needsConfirmation, type TypedAnswer } from "../lib/promptAnswer.ts";
import { ApiError, fetchPaneScroll, fetchPaneSelection, scrollPane } from "../lib/api.ts";
import { parseOsc52 } from "../lib/osc52.ts";
import { matchHerdrWidths } from "../lib/terminalWidths.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import { KeyBar } from "./KeyBar.tsx";
import { TerminalInput } from "./TerminalInput.tsx";
import { SecretInput } from "./SecretInput.tsx";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { ChatView } from "./ChatView.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { Composer } from "./Composer.tsx";
import type { AgentStatus, ClientRole, ConversationMetadata, InteractivePrompt, ServerMessage } from "../../shared/protocol.ts";
import type { PaneView } from "../lib/actions.ts";
import { useSettings, terminalTheme, type Palette, type ResolvedTheme } from "../lib/settings.ts";
import { imeEdit, imeSpaces } from "../lib/imeDiff.ts";
import { loadFontStack, TERMINAL_FONT_STACK, terminalFontStack } from "../lib/fontFamily.ts";
import { useT } from "../lib/i18n.ts";
import { isAppShortcut } from "../lib/shortcuts.ts";
import { spatialChord } from "../lib/spatialFocus.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { fileUriPath, terminalFileLinkProvider } from "../lib/terminalFileLinks.ts";
import { adjustTerminalGlyphs } from "../lib/terminalGlyphs.ts";

/** How long a resize must rest before the grid refits and the pty follows it. */
const RESIZE_SETTLE_MS = 120;

export interface PaneTerminalProps {
  /** The pane this terminal attaches to; null renders the placeholder. */
  paneId: string | null;
  /**
   * herdr's reason it could not restore the selected pane (0.9.3+): the pane has no
   * terminal to attach, so App passes a null paneId and the placeholder says why.
   */
  restoreError?: string | null;
  /** the pane's agent name — the chat lens labels the assistant's voice with it */
  agent?: string | null;
  /** the pane's live agent status: `working` turns composer sends into the queue */
  agentStatus?: AgentStatus;
  /** an OmO pane's running background tasks: the composer's status line offers their list */
  backgroundTasks?: number;
  /** the lens over the pane: the chat transcript, or the live xterm grid (App remembers it per pane) */
  view: PaneView;
  /** App selected this pane itself (the selected one closed): switching to it must not take the keyboard */
  autoSelected?: boolean;
  /** xterm font size (settings) */
  terminalFontSize: number;
  /** mouse reports sent per wheel event (settings): 1 is xterm's own one report */
  terminalWheelSpeed: number;
  /** fonts tried before the built-in stack (settings); "" keeps the built-in one */
  terminalFontFamily: string;
  /** the resolved UI theme: the xterm theme object mirrors it */
  theme: ResolvedTheme;
  /** the chrome palette (settings.ts): the terminal cursor and selection follow it */
  palette: Palette;
  /** The connection's desired role; changes are sent to the server, acks come back via onRoleAck. */
  role?: ClientRole;
  /** Fires with the server-confirmed role (the header toggle shows it). */
  onRoleAck?: (mode: ClientRole) => void;
  /** Fires on every change of the socket's connected state (the header shows it). */
  onConnectionChange?: (connected: boolean) => void;
  /** Every server frame also reaches App: it merges pane-status and schedules refetches. */
  onServerMessage?: (message: ServerMessage) => void;
}


/** Whether this device types in the terminal's input line or straight into the grid: remembered per device. */
const DIRECT_TYPING_KEY = "termweave:direct-typing";

function storedDirectTyping(): boolean {
  try { return window.localStorage.getItem(DIRECT_TYPING_KEY) === "1"; } catch { return false; }
}

/** A touch screen as the main pointer: its soft keyboard is what the input line is for. */
function useCoarsePointer(): boolean {
  const query = "(pointer: coarse)";
  const [coarse, setCoarse] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = (): void => setCoarse(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return coarse;
}
export function PaneTerminal({
  paneId,
  restoreError = null,
  agent = null,
  agentStatus,
  backgroundTasks = 0,
  view,
  autoSelected = false,
  terminalFontSize,
  terminalWheelSpeed,
  terminalFontFamily,
  theme,
  palette,
  role = "interact",
  onRoleAck,
  onConnectionChange,
  onServerMessage,
}: PaneTerminalProps) {
  const t = useT();
  const openFile = useContext(OpenFileContext);
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const machineId = useMachineId();
  const { answerPanePrompt, uploadPaneImage } = useMachineApi();
  const uploadFileRef = useRef(uploadPaneImage);
  uploadFileRef.current = uploadPaneImage;
  const chatView = view === "chat";
  const chatViewRef = useRef(chatView);
  chatViewRef.current = chatView;
  /** read by the wheel handler, which is attached once for the terminal's life */
  const wheelSpeedRef = useRef(terminalWheelSpeed);
  wheelSpeedRef.current = terminalWheelSpeed;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<HerdrSocket | null>(null);
  const paneRef = useRef<string | null>(paneId);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onServerMessageRef = useRef(onServerMessage);
  const onRoleAckRef = useRef(onRoleAck);
  const [connected, setConnected] = useState(false);
  const [outputReady, setOutputReady] = useState(false);
  const [ended, setEnded] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  // the server answered terminal_unsupported (a bridge too old to mirror): the lens is a notice, the chat still works
  const [unsupported, setUnsupported] = useState(false);
  // another web bridge has this pane's terminal: the server waits for it and says attach-resumed
  const [held, setHeldState] = useState(false);
  // what the socket handlers read mid-stream: stdin, onData and the composer's submit
  const heldRef = useRef(false);
  const setHeld = useCallback((next: boolean) => { heldRef.current = next; setHeldState(next); }, []);
  // one-shot Control from the key bar: the ref is what onData reads, the state is what the bar shows
  const composingRef = useRef(false);
  const [composing, setComposingState] = useState(false);
  const setComposing = useCallback((active: boolean) => { composingRef.current = active; setComposingState(active); }, []);
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // observe mode: the ref is what onData and the resize listeners read mid-stream
  const observeRef = useRef(role === "observe");
  // a mirrored pane (no terminal attach on its PC): the grid is the pane's own in herdr, adopted like an observer's
  const fixedGridRef = useRef(false);
  // the pty's grid as the server last said it for this pane (pane-geometry), whoever set it
  const sharedGridRef = useRef<{ cols: number; rows: number } | null>(null);
  const [observing, setObserving] = useState(role === "observe");
  const [secret, setSecret] = useState<{ pane: string; prompt: string } | null>(null);
  const secretRef = useRef<string | null>(null);
  const secretActive = secret !== null && secret.pane === paneId;
  // a touch screen writes in the terminal's input line; typing straight into the grid is chosen
  const coarse = useCoarsePointer();
  // A touch screen reads a pane before it answers: picking a pane or a lens there never raises the
  // keyboard by itself, only a tap on the message box or the grid does. A desktop has no keyboard
  // to raise, and the pane it picks takes the typing at once.
  const coarseRef = useRef(coarse); coarseRef.current = coarse;
  const { settings, update: updateSettings } = useSettings();
  const shortcutSettings = useRef(settings.shortcutOverrides);
  shortcutSettings.current = settings.shortcutOverrides;
  const directTyping = settings.terminalInputMode === "direct" || (settings.terminalInputMode === "auto" && (!coarse || storedDirectTyping()));
  const inputLine = !directTyping && !chatView;
  const inputLineRef = useRef(inputLine);
  inputLineRef.current = inputLine;
  // input typed while disconnected, held for the user to review and send
  const [draftState, setDraftState] = useState<{ owner: string | null; value: InputDraft }>({ owner: null, value: EMPTY_DRAFT });
  const draft = draftState.value;
  const setDraft = useCallback((value: InputDraft | ((previous: InputDraft) => InputDraft)) => {
    const owner = paneRef.current ? paneStorageId(machineId, paneRef.current) : null;
    setDraftState((previous) => ({ owner, value: typeof value === "function" ? value(previous.owner === owner ? previous.value : EMPTY_DRAFT) : value }));
  }, [machineId]);
  const draftPaneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!paneId || draftState.owner !== paneStorageId(machineId, paneId)) return;
    const key = `termweave:terminal-draft:${draftState.owner}`;
    try { if (draftIsEmpty(draft)) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(draft)); } catch {}
  }, [draftState, paneId, machineId, draft]);
  // transient OSC 52 feedback ("copied") — a pill in the banner column
  const [clipboardNote, setClipboardNote] = useState<string | null>(null);
  const clipboardTimerRef = useRef<number | null>(null);
  // the composer's send bumps this so the chat lens refetches without waiting a poll beat
  const [chatRefresh, setChatRefresh] = useState(0);
  // bumped as a composer message goes out: the chat must not title the turn before it as running
  const [chatSent, setChatSent] = useState(0);
  const [chatMetadata, setChatMetadata] = useState<{ pane: string; value: ConversationMetadata | null } | null>(null);
  // The prompt the chat shows: while it waits, a message from the composer answers it.
  const [chatPrompt, setChatPrompt] = useState<{ pane: string; value: InteractivePrompt } | null>(null);
  const [promptRefresh, setPromptRefresh] = useState(0);
  // what the agent suggests typing next (Claude's grey input text), for the composer's placeholder
  const [chatSuggestion, setChatSuggestion] = useState<{ pane: string; value: string } | null>(null);
  const onChatSuggestion = useCallback((pane: string, value: string | null) => {
    setChatSuggestion((current) => value !== null
      ? (current?.pane === pane && current.value === value ? current : { pane, value })
      : current?.pane === pane ? null : current);
  }, []);
  // a typed pick of an approval's option, shown in the card until Confirm or Cancel
  const [pendingAnswer, setPendingAnswer] = useState<{ pane: string; promptId: string; answer: TypedAnswer } | null>(null);
  const clearPendingAnswer = useCallback(() => setPendingAnswer(null), []);
  const onChatPrompt = useCallback((pane: string, value: InteractivePrompt | null) => {
    setChatPrompt((current) => value !== null ? { pane, value } : current?.pane === pane ? null : current);
    // a typed pick belongs to the prompt it was typed for: once that prompt changes or goes
    // away (a tap in the card, an answer in the terminal), the same question asked again
    // later opens clean, not with the old pick waiting one tap from Confirm
    setPendingAnswer((current) => current?.pane === pane && current.promptId !== value?.id ? null : current);
  }, []);
  // back at work, the agent has had its answer, maybe from the terminal: the same prompt asked
  // again before the chat's next read must not bring the pick back either
  useEffect(() => {
    if (agentStatus === "working") setPendingAnswer(null);
  }, [agentStatus]);
  const onChatMetadata = useCallback((pane: string, value: ConversationMetadata | null) => {
    // the same settings keep the same object: every 2 s poll would otherwise re-render the composer
    setChatMetadata((previous) => previous?.pane === pane && previous.value?.model === value?.model
      && previous.value?.reasoning_effort === value?.reasoning_effort
      && previous.value?.context?.used === value?.context?.used
      && previous.value?.context?.window === value?.context?.window ? previous : { pane, value });
  }, []);
  const queueStore = messageQueues;
  const queueOwner = paneId === null ? null : paneStorageId(machineId, paneId);
  const queued = useSyncExternalStore(queueStore.subscribe, () => queueStore.read(queueOwner ?? ""));
  const sendingRef = useRef(false);
  const [queueSending, setQueueSending] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<{ owner: string; id: string; text: string } | null>(null);

  paneRef.current = paneId;
  onConnectionChangeRef.current = onConnectionChange;
  onServerMessageRef.current = onServerMessage;
  onRoleAckRef.current = onRoleAck;

  useEffect(() => {
    onConnectionChangeRef.current?.(connected);
  }, [connected]);

  const noteClipboard = useCallback((note: string) => {
    if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
    setClipboardNote(note);
    clipboardTimerRef.current = window.setTimeout(() => {
      clipboardTimerRef.current = null;
      setClipboardNote(null);
    }, 2500);
  }, []);

  // Install before the pane layout effect so resets cancel pending input before the next task.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // xterm activates a link whenever a press and its release land on it: a drag that selects
    // part of a path and a right click do too, and neither means "open this"
    const linkPressed = (event: MouseEvent): boolean => event.button === 0 && !term.hasSelection();
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      // xterm keeps no scrollback: the attach stream lives in the alternate screen and herdr
      // owns scrollback (wheel and touch go to it). With scrollback on, the fit addon reserves
      // a scrollbar column - 15px by fallback wherever scrollbars are overlays - and the last
      // columns of the hero surface go dead.
      scrollback: 0,
      allowProposedApi: true,
      fontSize: terminalFontSize,
      // a chosen family follows in the font effect below, once its faces have loaded
      fontFamily: TERMINAL_FONT_STACK,
      theme: terminalTheme(theme, palette, settings),
      linkHandler: {
        activate: (event, uri) => {
          if (!linkPressed(event)) return;
          const path = fileUriPath(uri);
          if (path !== null) openFileRef.current?.(path);
          else if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener,noreferrer");
        },
        allowNonHttpProtocols: true,
      },
      // Option+drag selects on macOS, as Shift+drag does elsewhere; a plain drag is forced below
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    matchHerdrWidths(term);
    // an address in the terminal opens in a new tab; the page never navigates away from the pane
    term.loadAddon(new WebLinksAddon((_event, uri) => { window.open(uri, "_blank", "noopener,noreferrer"); }));
    term.registerLinkProvider(terminalFileLinkProvider(() => term.buffer.active, (path, event) => { if (linkPressed(event)) openFileRef.current?.(path); }));
    term.open(host);
    const compositionStart = () => setComposing(true);
    const compositionEnd = () => setComposing(false);
    host.addEventListener("compositionstart", compositionStart);
    host.addEventListener("compositionend", compositionEnd);
    // WebKit's Korean IME (Safari, the native Mac app) fires no composition events. It inserts a
    // syllable's first jamo as insertText, then rewrites it in place with insertReplacementText
    // (ㅎ → 하 → 한), and both arrive before the key's keydown. xterm forwards insertText only
    // while no keydown is pending (_keyDownSeen), so fast typing dropped jamo, and replaying
    // rewrites on a guess of what xterm had sent dropped or doubled syllables.
    // So that input is ours alone: each edit is measured on the textarea itself (its value just
    // before and just after) and sent as DEL per removed character plus the inserted text. xterm
    // never sees it. Text inside a composition (Chrome, Firefox, and WebKit itself at times) keeps
    // xterm's own composition path; the choice is made per edit, never latched for the session.
    let composing = false;
    let imeBefore: string | null = null;
    const isImeEdit = (event: InputEvent): boolean => !composing && !event.isComposing
      && (event.inputType === "insertReplacementText" || (event.inputType === "insertText" && !!event.data && HANGUL_TEXT.test(event.data)));
    const imeBeforeInput = (event: Event): void => {
      imeBefore = isImeEdit(event as InputEvent) && term.textarea ? term.textarea.value : null;
    };
    const imeInput = (event: Event): void => {
      const before = imeBefore;
      imeBefore = null;
      if (before === null || !term.textarea || !isImeEdit(event as InputEvent)) return;
      event.stopPropagation(); // capture phase on the host: xterm's own textarea listener never runs
      const edit = imeEdit(before, term.textarea.value);
      if (edit) term.input(edit, true);
    };
    const imeCompositionStart = (): void => { composing = true; };
    const imeCompositionEnd = (): void => { composing = false; };
    host.addEventListener("beforeinput", imeBeforeInput, true);
    host.addEventListener("input", imeInput, true);
    host.addEventListener("compositionstart", imeCompositionStart, true);
    host.addEventListener("compositionend", imeCompositionEnd, true);
    const stopGlyphs = adjustTerminalGlyphs(term);
    // Let the browser emit a paste event, which xterm already handles (including
    // bracketed paste). Otherwise Ctrl+V becomes 0x16, triggering the agent's
    // image-paste shortcut against the server's clipboard and canceling text paste.
    // Returning false skips xterm's key handling without preventing browser defaults.
    // With text selected, Ctrl+C (and Ctrl+Shift+C) copies it instead of interrupting the pane.
    // A non-Latin layout (Korean, Russian...) reports its own character as the key, so the
    // physical key names the letter then; a Latin layout keeps its own (Dvorak's C is not KeyC).
    // An app shortcut is the app's alone: xterm would still type it, and Ctrl+Shift+↓ reached the
    // pane it had just switched to as ESC[1;6B.
    term.attachCustomKeyEventHandler((event) => {
      if (isAppShortcut(event, shortcutSettings.current)) return false;
      if (spatialChord(event) && event.target instanceof HTMLElement && event.target.matches('.xterm-helper-textarea') && event.target.closest('.dock-group')) {
        event.preventDefault(); return false;
      }
      if (!event.ctrlKey || event.altKey || event.metaKey) return true;
      const typed = event.key.toLowerCase();
      const key = /^[a-z]$/.test(typed) ? typed : /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() ?? typed;
      if (key === "v") return false;
      if (key === "c" && term.hasSelection()) {
        if (event.type === "keydown") {
          event.preventDefault();
          copySelection();
          term.clearSelection();
        }
        return false;
      }
      return true;
    });
    // herdr reads the wheel as mouse reports. Were reporting ever off, xterm would turn
    // a wheel into arrow keys, which walk an agent's prompt history instead of scrolling.
    // A selecting drag takes the wheel itself (see below); after one, a wheel scrolls the
    // highlight's text away, so the highlight goes with it.
    // xterm sends one mouse report per wheel event whatever its delta, so herdr scrolls
    // the same few lines per notch: at a wheel speed above 1 a real wheel is replayed to send
    // that many reports. The replays and the touch translation below are untrusted, so neither
    // repeats. A replay is the same event, keys held included: xterm ignores a wheel with
    // Shift down, and a replay without it scrolled where the wheel itself did not.
    term.attachCustomWheelEventHandler((event) => {
      if (drag) {
        dragWheel(event);
        return false;
      }
      // an adopted grid sends herdr nothing: the wheel is the browser's, and pans the mount
      if (adopted()) return false;
      if (term.hasSelection()) term.clearSelection();
      const reporting = term.modes.mouseTrackingMode !== "none";
      // a trackpad pinch arrives as a wheel with Ctrl down: it is not scrolling, and goes once as before
      if (reporting && event.isTrusted && event.target && !event.ctrlKey) {
        for (let sent = 1; sent < wheelSpeedRef.current; sent += 1) {
          event.target.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode,
            clientX: event.clientX, clientY: event.clientY,
            ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
          }));
        }
      }
      return reporting;
    });
    termRef.current = term;
    fitRef.current = fit;

    // A grid that is not this browser's own (observing, or mirrored from a PC that cannot
    // attach) may be larger than the mount. The mount then scrolls (PaneTerminal.css) and a
    // drag pans it. Until the user pans, the view keeps the cursor's row in sight: the top of
    // the grid while the row fits there, else the bottom rows, where a prompt sits. A mirror
    // has no cursor; xterm's own rests on the last row with text, which serves the same.
    const adopted = (): boolean => observeRef.current || fixedGridRef.current;
    let panned = false;
    const followCursor = (): void => {
      host.toggleAttribute("data-adopted-grid", adopted());
      const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
      if (!adopted() || panned || !screen) return;
      const row = screen.offsetHeight / term.rows;
      const cursorBottom = screen.offsetTop + (term.buffer.active.cursorY + 1) * row;
      const max = host.scrollHeight - host.clientHeight;
      host.scrollTop = cursorBottom <= host.clientHeight ? 0 : cursorBottom - row >= max ? max : cursorBottom - host.clientHeight;
    };

    /** herdr's text for the last drag, while its highlight is still the selection */
    let copiedText: string | null = null;
    let selectionGeneration = 0;
    let disposed = false;
    // Run after xterm's own copy listener, including for Cmd+C and context-menu
    // Copy. Its buffer contains only the visible part of a scrolled selection.
    const onCopy = (event: ClipboardEvent): void => {
      if (!term.hasSelection() || copiedText === null || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", copiedText);
      event.preventDefault();
    };
    host.addEventListener("copy", onCopy);
    const copySelection = (): void => {
      const text = copiedText ?? term.getSelection();
      if (!text) return;
      // Native copy still works in a user gesture when a Chromium/PWA site has
      // denied the async clipboard permission, or plain HTTP has no clipboard API.
      if (document.execCommand("copy")) {
        noteClipboard("copied to clipboard");
        return;
      }
      if (!navigator.clipboard) {
        noteClipboard("clipboard write blocked by the browser");
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => { if (!disposed) noteClipboard("copied to clipboard"); },
        () => { if (!disposed) noteClipboard("clipboard write blocked by the browser"); },
      );
    };
    const selectionChange = term.onSelectionChange(() => {
      if (!term.hasSelection()) {
        copiedText = null;
        selectionGeneration++;
      }
    });

    // herdr's attach stream turns mouse reporting on, so xterm hands every click to the
    // pty and selects only with Shift (Option on macOS) held. `herdr terminal attach`
    // ignores left clicks and drags - selection lives in herdr's own TUI client - so a
    // left drag here selects as if the modifier were held, and letting go copies, as the
    // herdr TUI does. Touch keeps its drag-to-scroll.
    //
    // xterm keeps no scrollback (herdr owns it), so a drag that outlives one screen is
    // tracked in herdr's history rows: a wheel, or dragging past the top or bottom edge,
    // scrolls the pane through the API, the highlight is repainted over the visible part,
    // and letting go copies herdr's own text for the range, soft-wrapped lines joined.
    // Without the API (plain HTTP, observe mode, an older remote bridge, a failed read)
    // only the visible selection is copied, as xterm has it.
    interface Cell { row: number; col: number }
    interface Drag {
      pane: string;
      /** the pressed cell on screen */
      anchor: Cell;
      /** the cell under the pointer on screen, its row clamped to the screen */
      cursor: Cell;
      /** the history row at the top of the screen, once herdr has told us */
      top: number | null;
      /** the pressed cell's history row */
      anchorRow: number;
      offset: number;
      maxOffset: number;
      /** the drag left the first screen: it is painted here, not by xterm */
      scrolled: boolean;
      /** pointer beyond the top (-1) or bottom (1) edge, which keeps scrolling */
      edge: -1 | 0 | 1;
      wheelPixels: number;
      sentOffset: number;
      sending: boolean;
    }
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    let drag: Drag | null = null;
    let edgeTimer: number | null = null;
    const cellAt = (event: MouseEvent): { cell: Cell; edge: -1 | 0 | 1 } => {
      const rect = (term.element?.querySelector(".xterm-screen") ?? host).getBoundingClientRect();
      const col = Math.floor((event.clientX - rect.left) / (rect.width / term.cols));
      const row = Math.floor((event.clientY - rect.top) / (rect.height / term.rows));
      return {
        cell: { row: Math.max(0, Math.min(term.rows - 1, row)), col: Math.max(0, Math.min(term.cols - 1, col)) },
        edge: row < 0 ? -1 : row >= term.rows ? 1 : 0,
      };
    };
    const ordered = (a: Cell, b: Cell): [Cell, Cell] =>
      a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
    /** the drag's range in history rows, both ends inclusive */
    const historyRange = (d: Drag): [Cell, Cell] =>
      ordered({ row: d.anchorRow, col: d.anchor.col }, { row: d.top! + d.cursor.row, col: d.cursor.col });
    const repaint = (d: Drag): void => {
      const [start, end] = historyRange(d);
      const first = d.top!;
      const last = first + term.rows - 1;
      if (end.row < first || start.row > last) {
        term.clearSelection();
        return;
      }
      const from = start.row < first ? { row: 0, col: 0 } : { row: start.row - first, col: start.col };
      const to = end.row > last ? { row: term.rows - 1, col: term.cols - 1 } : { row: end.row - first, col: end.col };
      term.select(from.col, from.row, to.row * term.cols + to.col + 1 - (from.row * term.cols + from.col));
    };
    /** one request at a time; the latest wanted offset wins */
    const sendScroll = (d: Drag): void => {
      if (d.sending || d.sentOffset === d.offset) return;
      d.sending = true;
      const target = d.offset;
      void scrollPane(d.pane, target, machineId).catch(() => {}).finally(() => {
        d.sending = false;
        d.sentOffset = target;
        sendScroll(d);
      });
    };
    /** positive lines show older text */
    const scrollDrag = (d: Drag, lines: number): void => {
      if (d.top === null) return;
      const offset = Math.max(0, Math.min(d.maxOffset, d.offset + lines));
      if (offset === d.offset) return;
      d.offset = offset;
      d.top = d.maxOffset - offset;
      d.scrolled = true;
      repaint(d);
      sendScroll(d);
    };
    const dragWheel = (event: WheelEvent): void => {
      const d = drag;
      if (!d || d.top === null) return;
      const lineHeight = (term.element?.querySelector(".xterm-screen")?.getBoundingClientRect().height ?? term.rows) / term.rows;
      d.wheelPixels += event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * lineHeight : event.deltaY;
      const lines = Math.trunc(d.wheelPixels / lineHeight);
      if (lines === 0) return;
      d.wheelPixels -= lines * lineHeight;
      scrollDrag(d, -lines);
    };
    const stopEdge = (): void => {
      if (edgeTimer !== null) window.clearInterval(edgeTimer);
      edgeTimer = null;
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      if ((event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
      if (!term.element?.contains(event.target as Node)) return;
      // with reporting off xterm already selects on a plain drag; only the history tracking is ours
      if (term.modes.mouseTrackingMode !== "none") Object.defineProperty(event, isMac ? "altKey" : "shiftKey", { value: true });
      copiedText = null;
      selectionGeneration++;
      const pane = paneRef.current;
      const { cell } = cellAt(event);
      const d: Drag = {
        pane: pane ?? "", anchor: cell, cursor: cell, top: null, anchorRow: 0, offset: 0, maxOffset: 0,
        scrolled: false, edge: 0, wheelPixels: 0, sentOffset: 0, sending: false,
      };
      drag = d;
      if (!pane || !navigator.clipboard || observeRef.current) return;
      void fetchPaneScroll(pane, machineId).then((scroll) => {
        if (!scroll || drag !== d || d.scrolled) return;
        d.offset = d.sentOffset = scroll.offset_from_bottom;
        d.maxOffset = scroll.max_offset_from_bottom;
        d.top = d.maxOffset - d.offset;
        d.anchorRow = d.top + d.anchor.row;
      }, () => {});
    };
    // capture on window: ahead of xterm's own document listener, which would repaint a
    // scrolled drag from its stale screen anchor
    const onMouseMove = (event: MouseEvent): void => {
      const d = drag;
      if (!d) return;
      const { cell, edge } = cellAt(event);
      // past an edge the edge row is taken whole, as xterm does
      d.cursor = edge < 0 ? { row: 0, col: 0 } : edge > 0 ? { row: term.rows - 1, col: term.cols - 1 } : cell;
      if (d.top === null) return;
      if (edge !== d.edge) {
        d.edge = edge;
        stopEdge();
        if (edge !== 0) edgeTimer = window.setInterval(() => scrollDrag(d, -d.edge), 60);
      }
      if (d.scrolled || edge !== 0) {
        event.stopPropagation();
        // painted here from now on, even where herdr has no further to scroll
        d.scrolled = true;
        repaint(d);
      }
    };
    // a release outside the window never arrives: stop scrolling the shared pane
    const onBlur = (): void => {
      stopEdge();
      drag = null;
    };
    const onMouseUp = (event: MouseEvent): void => {
      const d = drag;
      if (!d || event.button !== 0) return;
      drag = null;
      stopEdge();
      // Window bubble runs after xterm's document listener, still inside the
      // release gesture. A timer here loses clipboard permission in some browsers.
      if (d.scrolled) repaint(d);
      if (!term.hasSelection()) return;
      const visibleText = term.getSelection();
      copiedText = visibleText;
      copySelection();
      const generation = selectionGeneration;
      const current = (): boolean => !disposed && paneRef.current === d.pane && generation === selectionGeneration;
      let range: [Cell, Cell] | null = null;
      if (d.scrolled) range = historyRange(d);
      else if (d.top !== null) {
        const position = term.getSelectionPosition();
        if (position) {
          // xterm's end column is exclusive, herdr's inclusive
          const end = position.end.x > 0
            ? { row: d.top + position.end.y, col: position.end.x - 1 }
            : { row: d.top + position.end.y - 1, col: term.cols - 1 };
          range = [{ row: d.top + position.start.y, col: position.start.x }, end];
        }
      }
      if (!range) return;
      const text = fetchPaneSelection(d.pane, range[0], range[1], machineId).catch(() => {
        if (current() && d.scrolled) noteClipboard("could not read the selection from herdr");
        return visibleText;
      }).then((value) => {
        if (!current()) throw new Error("selection changed");
        // A redraw can remove the range before herdr reads it. Keep what the user
        // actually selected instead of replacing a successful copy with nothing.
        copiedText = value || visibleText;
        return copiedText;
      });
      // Reserve the write NOW, supplying the server text when it arrives. Never
      // start a fresh clipboard write from a delayed response or an older drag.
      if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
        const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
        void blob.catch(() => {});
        // Denied (the case native copy covers), the clipboard keeps only the visible rows of a
        // scrolled drag: say so, since the whole text waits for an explicit Copy or Ctrl+C
        void navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).catch(() => {
          if (current() && d.scrolled) noteClipboard("copied the visible part; Copy or Ctrl+C copies the whole selection");
        });
      } else {
        // Native copy already captured the visible text; the full text stays
        // available for the next explicit Copy where delayed items are unsupported.
        void text.then(() => {
          if (current() && d.scrolled) noteClipboard("copied the visible part; Copy or Ctrl+C copies the whole selection");
        }, () => {});
      }
    };
    host.addEventListener("mousedown", onMouseDown, { capture: true });
    window.addEventListener("mousemove", onMouseMove, { capture: true });
    window.addEventListener("blur", onBlur);
    window.addEventListener("mouseup", onMouseUp);

    // OSC 52: the pane program asked the terminal to set the clipboard - the pty
    // cannot reach the browser clipboard, so xterm hands us the sequence and
    // navigator.clipboard completes the hop (text only; queries are ignored)
    const osc52 = term.parser.registerOscHandler(52, (payload) => {
      const text = parseOsc52(payload);
      if (text !== null) {
        void navigator.clipboard?.writeText(text).then(
          () => noteClipboard("copied to clipboard"),
          () => noteClipboard("clipboard write blocked by the browser"),
        );
      }
      return true;
    });

    const socket = new HerdrSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?machine_id=${encodeURIComponent(machineId)}`);
    socketRef.current = socket;
    socket.setMode(role);
    term.options.disableStdin = role === "observe";
    let outputGeneration = 0;
    const off = socket.on((message) => {
      onServerMessageRef.current?.(message);
      if (paneRef.current) setInputReady(socket.canInput(paneRef.current));
      if (message.type === "pty-data") {
        if (message.pane_id !== paneRef.current) return;
        // raw pty bytes: append, never repaint, so xterm keeps the screen and selection
        const acknowledge = socket.outputAcknowledgement(message);
        const owner = message.pane_id;
        const generation = outputGeneration;
        term.write(message.data, () => {
          acknowledge?.();
          if (paneRef.current !== owner || generation !== outputGeneration) return;
          setOutputReady(true);
          followCursor();
          const lines: string[] = [];
          const buffer = term.buffer.active;
          for (let row = 0; row < buffer.length; row++) {
            const line = buffer.getLine(row);
            const text = line?.translateToString(!buffer.getLine(row + 1)?.isWrapped) ?? "";
            if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
            else lines.push(text);
          }
          const prompt = secretPrompt(lines.join("\n"), term.cols);
          secretRef.current = prompt;
          term.options.disableStdin = observeRef.current || prompt !== null || heldRef.current;
          setSecret((previous) => previous?.pane === owner && previous.prompt === prompt ? previous : prompt ? { pane: owner, prompt } : null);
        });
      } else if (message.type === "attach-resumed") {
        if (message.pane_id === paneRef.current) {
          setHeld(false);
          term.options.disableStdin = observeRef.current || secretRef.current !== null;
        }
      } else if (message.type === "pty-exit") {
        // an ended pane takes no input: a file dropped on it must not upload and paste either
        if (message.pane_id === paneRef.current) { setEnded(true); term.options.disableStdin = true; }
      } else if (message.type === "role-ack") {
        // the server is the authority on the role; only after this ack may an
        // interact client reclaim the shared grid it stopped owning
        const nowObserving = message.mode === "observe";
        observeRef.current = nowObserving;
        setObserving(nowObserving);
        term.options.disableStdin = nowObserving || secretRef.current !== null || heldRef.current;
        onRoleAckRef.current?.(message.mode);
        if (!nowObserving && !fixedGridRef.current && !chatViewRef.current) {
          try {
            fit.fit();
          } catch {
            /* not laid out yet */
          }
          const pane = paneRef.current;
          if (pane) socket.resize(pane, term.cols, term.rows, true);
        }
        panned = false;
        followCursor();
      } else if (message.type === "pane-geometry") {
        // observe clients adopt the pty's grid; interact clients drive it and ignore this,
        // unless the grid is fixed: then nobody here drives it
        if (message.pane_id !== paneRef.current) return;
        if (message.fixed) fixedGridRef.current = true;
        // kept while the terminal lens ignores it: another device may drive the grid, and the
        // chat lens entered later must draw its hidden screen for that grid, not this device's
        sharedGridRef.current = { cols: message.cols, rows: message.rows };
        // the chat lens adopts the shared grid too: the screen it reads (a masked prompt) is drawn for it
        if (!observeRef.current && !fixedGridRef.current && !chatViewRef.current) return;
        if (term.cols !== message.cols || term.rows !== message.rows) term.resize(message.cols, message.rows);
        panned = false;
        followCursor();
      } else if (message.type === "error") {
        if (message.code === "input_not_ready" || message.code === "input_failed") {
          if (message.pane_id === paneRef.current) setInputError(message.message);
          return;
        }
        if (message.code === "attach_held") {
          // a pane this terminal already left: its wait is not this pane's
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          // not an end: the server attaches as soon as the other bridge lets go
          setHeld(true);
          term.options.disableStdin = true;
          setConnected(socket.connected);
          return;
        }
        if (message.code === "terminal_unsupported") {
          if (message.pane_id !== undefined && message.pane_id !== paneRef.current) return;
          setUnsupported(true);
          term.options.disableStdin = true;
          setConnected(socket.connected);
          return;
        }
        if (message.code === "output_stalled" || message.code === "attach_conflict") {
          setOutputError(message.message);
          setEnded(true);
          setConnected(false);
          term.options.disableStdin = true;
          return;
        }
        term.writeln(`\r\n\u001b[31m[herdr-web-ui] ${message.code}: ${message.message}\u001b[0m`);
      }
      setConnected(socket.connected);
    });
    const offDisconnect = socket.onDisconnect(() => {
      outputGeneration++;
      setOutputReady(false);
      setInputReady(false);
      setConnected(false);
      // the reconnect attaches afresh: it says attach_held again if the other bridge still has
      // the pane, and a pane it gets straight away sends no attach-resumed to clear this
      setHeld(false);
    });
    socket.connect();

    const poll = window.setInterval(() => setConnected(socket.connected), 1000);

    // onKey runs after xterm drains a pending IME commit, immediately before the
    // key's onData. Remap only that CR, preserving composition text and its order.
    let shiftEnter = false;
    const onShiftEnter = term.onKey(({ key, domEvent: event }) => {
      shiftEnter = !term.options.disableStdin && key === "\r" && event.key === "Enter" && event.shiftKey
        && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && event.keyCode !== 229;
    });
    // Let xterm finish pending IME text before remapping the key's following data.
    // Cmd+Backspace uses the terminal's Ctrl+U line-deletion shortcut on macOS.
    let commandBackspace = false;
    const onCommandBackspace = term.onKey(({ key, domEvent: event }) => {
      commandBackspace = !term.options.disableStdin && isMac && key === "\x7f" && event.type === "keydown"
        && event.key === "Backspace" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
        && !event.isComposing && event.keyCode !== 229;
    });
    const onData = term.onData((data) => {
      data = imeSpaces(data);
      if (shiftEnter && data === "\r") data = "\x1b\r";
      shiftEnter = false;
      if (commandBackspace && data === "\x7f") data = "\x15";
      commandBackspace = false;
      const current = paneRef.current;
      if (!current || observeRef.current || secretRef.current !== null || heldRef.current) return;
      let input = data;
      if (ctrlRef.current && isPrintable(data)) {
        ctrlRef.current = false;
        setCtrlArmed(false);
        input = controlCode(data) ?? data;
      }
      if (socket.sendInput(current, input)) return;
      // A closed socket, an attachment still opening, or a failed synchronous send:
      // keep printable input for explicit review, never replay it automatically.
      if (draftPaneRef.current !== current) {
        draftPaneRef.current = current;
        setDraft(EMPTY_DRAFT);
      }
      setDraft((prev) => applyToDraft(prev, input));
    });

    // Browsers expose dropped files as bytes, not local paths. Save them beside
    // the pane and paste the returned paths; never send Enter with a drop.
    // Batches upload one after another, so overlapping drops paste their paths in the order dropped.
    let fileQueue: Promise<void> = Promise.resolve();
    const uploadFiles = (files: File[]): void => {
      const pane = paneRef.current;
      if (!pane || !socket.connected || term.options.disableStdin) return;
      fileQueue = fileQueue.then(() => uploadBatch(pane, files));
    };
    const uploadBatch = async (pane: string, files: File[]): Promise<void> => {
      if (paneRef.current !== pane || !socket.connected || term.options.disableStdin) return;
      try {
        const paths: string[] = [];
        for (const file of files) paths.push(await uploadFileRef.current(pane, file));
        // An upload can finish after the user has switched panes or lost input access.
        if (paneRef.current !== pane || chatViewRef.current || !socket.connected || term.options.disableStdin) return;
        term.paste(paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ") + " ");
        term.focus();
      } catch (error) {
        if (paneRef.current === pane) noteClipboard(error instanceof Error ? error.message : String(error));
      }
    };
    const onFilePaste = (event: ClipboardEvent): void => {
      // xterm handles text (and bracketed paste) itself. A file-only clipboard
      // needs the upload route instead; copied paths must remain native text.
      if (event.clipboardData?.getData("text/plain")) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      uploadFiles(files);
    };
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer) return;
      if (!event.dataTransfer.types.some((type) => type === "Files" || type === "text/plain")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = term.options.disableStdin ? "none" : "copy";
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      if (!event.dataTransfer || !socket.connected || term.options.disableStdin) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length > 0) {
        uploadFiles(files);
        return;
      }
      const text = event.dataTransfer.getData("text/plain");
      if (text) {
        term.paste(text);
        term.focus();
      }
    };
    host.addEventListener("paste", onFilePaste, { capture: true });
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    // Dragging a window edge fires this every frame. Each resize of the pty makes herdr
    // reflow the pane and the program in it redraw (Claude Code repaints its whole
    // conversation), so a drag of a long session sent over a hundred resizes and the app
    // lagged: fit once the size has settled.
    let resizeTimer: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null;
        // the grid belongs to the pty while observing, and to herdr when fixed: only the view moves
        // (a soft keyboard opening must not leave the prompt under it)
        if (adopted()) {
          panned = false;
          followCursor();
          return;
        }
        // the chat lens covers the grid: a phone's viewport or keyboard must not resize the
        // shared pty under another device (#361); the switch back to the terminal refits
        if (chatViewRef.current) return;
        try {
          fit.fit();
        } catch {
          return;
        }
        const current = paneRef.current;
        if (current) socket.resize(current, term.cols, term.rows);
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(host);

    // Touch screens never emit wheel events and xterm.js has no touch scrolling:
    // translate a single-finger drag on the terminal into wheel events, so the
    // normal buffer scrolls its own viewport and the alternate buffer (with mouse
    // reporting on) forwards the gesture to herdr, exactly like a mouse wheel.
    // The text follows the finger, as everywhere on a phone: dragging down brings
    // older lines in. Each event carries the finger's position, since xterm reports
    // a wheel at the cell under it (without one, every report said row 1, column 1).
    // An adopted grid has no history to send a wheel to (an observer's reports are dropped, a
    // mirror reports nothing): there the drag pans the mount, both ways, to the cells past its edge.
    let touchX = 0;
    let touchY = 0;
    let tracking = false;
    const onTouchStart = (event: TouchEvent): void => {
      tracking = event.touches.length === 1;
      const first = event.touches[0];
      if (tracking && first) {
        touchX = first.clientX;
        touchY = first.clientY;
      }
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!tracking || event.touches.length !== 1) return;
      event.preventDefault();
      const first = event.touches[0];
      if (!first) return;
      // finger moving down (y > touchY) shows older lines: a wheel scrolling up, negative deltaY
      const delta = touchY - first.clientY;
      const across = touchX - first.clientX;
      touchX = first.clientX;
      touchY = first.clientY;
      if (adopted()) {
        panned = true;
        host.scrollBy(across, delta);
        return;
      }
      if (delta !== 0) {
        const target = term.element ?? host;
        target.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: delta, clientX: first.clientX, clientY: first.clientY }));
      }
    };
    const onTouchEnd = (): void => {
      tracking = false;
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd, { passive: true });

    // The pty is shared per pane: a client on another device (typically a phone)
    // resizes it to its own geometry, and this tab's viewport never changed, so
    // the ResizeObserver above stays silent and the pane is left at the other
    // device's size. Re-assert our geometry whenever this tab comes back. Observe
    // connections never do this: they own no geometry to re-assert.
    const refit = (): void => {
      const current = paneRef.current;
      if (!current || observeRef.current || fixedGridRef.current || chatViewRef.current) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      socket.resize(current, term.cols, term.rows, true);
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") refit();
    };
    window.addEventListener("focus", refit);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      window.clearInterval(poll);
      observer.disconnect();
      if (resizeTimer !== null) window.clearTimeout(resizeTimer);
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("mousedown", onMouseDown, { capture: true });
      window.removeEventListener("mousemove", onMouseMove, { capture: true });
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mouseup", onMouseUp);
      host.removeEventListener("copy", onCopy);
      stopEdge();
      selectionChange.dispose();
      window.removeEventListener("focus", refit);
      document.removeEventListener("visibilitychange", onVisible);
      onShiftEnter.dispose();
      onCommandBackspace.dispose();
      onData.dispose();
      host.removeEventListener("paste", onFilePaste, { capture: true });
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      offDisconnect();
      osc52.dispose();
      if (clipboardTimerRef.current !== null) window.clearTimeout(clipboardTimerRef.current);
      off();
      socket.closeAfterSubmits();
      stopGlyphs();
      host.removeEventListener("compositionstart", compositionStart);
      host.removeEventListener("compositionend", compositionEnd);
      host.removeEventListener("beforeinput", imeBeforeInput, true);
      host.removeEventListener("input", imeInput, true);
      host.removeEventListener("compositionstart", imeCompositionStart, true);
      host.removeEventListener("compositionend", imeCompositionEnd, true);
      // xterm 5.5 Viewport queues an untracked syncScrollArea timer on open/resize.
      // Docking can unmount in the same frame; let that work settle before disposal.
      window.setTimeout(() => term.dispose(), 100);
      termRef.current = null;
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one terminal for the mount; theme/font follow in their own effect
  }, []);

  // the theme follows the settings without a remount
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = terminalTheme(theme, palette, settings);
  }, [theme, palette, settings.appearancePreset, settings.customColors]);

  // the font follows too, and a font change moves the grid. xterm measures the cell (and the DOM
  // renderer its glyph widths) when fontFamily or fontSize changes, and setting the same value
  // again changes nothing: so a chosen family is set only once its faces loaded, or the cell would
  // stay measured from a fallback
  const fontFamily = terminalFontStack(terminalFontFamily);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let superseded = false;
    const apply = (): void => {
      // a newer font, or an unmounted terminal, took over while the faces loaded
      if (superseded || termRef.current !== term) return;
      if (term.options.fontSize === terminalFontSize && term.options.fontFamily === fontFamily) return;
      term.options.fontSize = terminalFontSize;
      term.options.fontFamily = fontFamily;
      if (observeRef.current || fixedGridRef.current || chatViewRef.current) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      const pane = paneRef.current;
      if (pane) socketRef.current?.resize(pane, term.cols, term.rows, true);
    };
    if (fontFamily === TERMINAL_FONT_STACK) apply();
    else void loadFontStack(fontFamily, terminalFontSize).then(apply);
    return () => { superseded = true; };
  }, [terminalFontSize, fontFamily]);

  // the grid must re-fit when the lens switches back: the chat lens covered it, and a
  // resize while covered may have been skipped by a zero-size layout
  useEffect(() => {
    if (chatView) {
      const pane = paneRef.current;
      if (pane) socketRef.current?.keepSize(pane);
      // the grid another device left the pty at while this one showed the terminal
      const shared = sharedGridRef.current;
      const hidden = termRef.current;
      if (shared && hidden && !observeRef.current && (hidden.cols !== shared.cols || hidden.rows !== shared.rows)) hidden.resize(shared.cols, shared.rows);
      return;
    }
    if (observeRef.current || fixedGridRef.current) return;
    const term = termRef.current;
    try {
      fitRef.current?.fit();
    } catch {
      return;
    }
    const pane = paneRef.current;
    if (pane && term) socketRef.current?.resize(pane, term.cols, term.rows, true);
    if (!autoSelected && !coarseRef.current) term?.focus();
  }, [chatView]);

  // Reset synchronously on pane changes: old composition timers must never see the new pane.
  useLayoutEffect(() => {
    const socket = socketRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!socket || !term) return;
    setEnded(false);
    setInputReady(false);
    setInputError(null);
    setComposing(false);
    setOutputReady(false);
    setOutputError(null);
    setHeld(false);
    setUnsupported(false);
    fixedGridRef.current = false;
    sharedGridRef.current = null;
    // the next pane's grid is this browser's again unless it says otherwise (pane-geometry)
    hostRef.current?.toggleAttribute("data-adopted-grid", observeRef.current);
    secretRef.current = null;
    setSecret(null);
    term.options.disableStdin = observeRef.current;
    let saved = EMPTY_DRAFT;
    try {
      const value = paneId ? JSON.parse(localStorage.getItem(`termweave:terminal-draft:${paneStorageId(machineId, paneId)}`) ?? "null") : null;
      if (value && typeof value.text === "string" && Number.isInteger(value.droppedSpecial)) saved = value;
    } catch {}
    setDraft(saved);
    draftPaneRef.current = paneId;
    term.reset();
    if (!paneId) return;
    try {
      fit?.fit();
    } catch {
      /* not laid out yet; the ResizeObserver will follow up */
    }
    socket.attach(paneId, term.cols, term.rows, chatViewRef.current);
    // the chat lens covers the grid and its composer takes the keyboard: focusing the hidden
    // grid sent the keys straight to the pane, and showed a phone's IME text mid-screen
    if (!chatViewRef.current && !autoSelected && !coarseRef.current) term.focus();
    return () => {
      socket.detach(paneId);
    };
  }, [paneId]);


  // the user picked the pane App had switched to on its own (the same row or lens again,
  // which changes neither the pane nor the lens): the grid takes the keyboard now
  const autoSelectedRef = useRef(autoSelected);
  useEffect(() => {
    const wasAuto = autoSelectedRef.current;
    autoSelectedRef.current = autoSelected;
    if (wasAuto && !autoSelected && !chatViewRef.current && !coarseRef.current) termRef.current?.focus();
  }, [autoSelected]);

  // key-bar taps go through xterm so the onData -> socket path above is reused
  const pressKey = useCallback((key: KeyBarKey) => {
    const term = termRef.current;
    if (!term) return;
    if (composingRef.current) return;
    term.input(keySequence(key, term.modes.applicationCursorKeysMode));
    // with the input line, the keyboard belongs to it: a key tap must not move it to the grid
    if (!inputLineRef.current) term.focus();
  }, []);

  const toggleCtrl = useCallback(() => {
    if (composingRef.current) return;
    const armed = !ctrlRef.current;
    ctrlRef.current = armed;
    setCtrlArmed(armed);
    if (!inputLineRef.current) termRef.current?.focus();
  }, []);

  // ask the server for the role change; the role-ack handler applies the local
  // consequences (stdin gate, grid adoption or reclamation) once it is confirmed.
  // The initial default is skipped: the server already treats fresh connections as interact.
  const lastSentRole = useRef<ClientRole>(role);
  useEffect(() => {
    if (role === lastSentRole.current) return;
    lastSentRole.current = role;
    socketRef.current?.setMode(role);
  }, [role]);

  const sendDraft = useCallback(() => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || !pane || draft.text.length === 0 || !socket.connected || secretRef.current !== null || heldRef.current) return;
    if (socket.sendInput(pane, draft.text)) setDraft(EMPTY_DRAFT);
  }, [draft]);

  const discardDraft = useCallback(() => {
    setDraft(EMPTY_DRAFT);
  }, []);

  // the composer goes straight to the socket, not through onData: an armed key-bar Ctrl
  // must not turn a one-letter message into a control key. Offline it sends nothing and
  // keeps its text (never-queue); a message the server could not deliver keeps it too,
  // with the reason. Bracketed-paste wrapping follows the pane program's mode.
  const sendComposerText = useCallback((text: string): false | Promise<true | string> => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null || heldRef.current) return false;
    const sent = socket.submit(pane, composerMessage(text), composerPayload(text, term.modes.bracketedPasteMode));
    if (sent === null) return false;
    term.scrollToBottom();
    setChatSent((current) => current + 1);
    // a message went out, from the box or a queued one: the agent's suggestion was for the turn before it
    onChatSuggestion(pane, null);
    return sent.then((result) => {
      if (!result.ok) return submitNote(result.code, result.message);
      // the chat lens refetches at once so the sent prompt appears without a poll beat
      setChatRefresh((current) => current + 1);
      return true;
    });
  }, [onChatSuggestion]);

  // the terminal's input line: the text typed like the keyboard would, into an agent's open
  // menu too, then Enter after the server's gap; several lines go as one paste
  const sendTerminalLine = useCallback((text: string): false | Promise<true | string> => {
    const term = termRef.current;
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!term || !socket || pane === null || secretRef.current !== null) return false;
    const message = composerMessage(text);
    const payload = message.includes("\n") ? composerPayload(text, term.modes.bracketedPasteMode) : message;
    const sent = socket.submit(pane, message, payload, true);
    if (sent === null) return false;
    term.scrollToBottom();
    return sent.then((result) => (result.ok ? true : submitNote(result.code, result.message)));
  }, []);

  const pressEnter = useCallback((): boolean => {
    const socket = socketRef.current;
    const pane = paneRef.current;
    if (!socket || pane === null || !socket.connected) return false;
    const sent = socket.sendInput(pane, "\r");
    termRef.current?.scrollToBottom();
    return sent;
  }, []);

  const toggleDirect = useCallback(() => {
    if (composingRef.current) return;
    updateSettings({ terminalInputMode: directTyping ? "line" : "direct" });
  }, [directTyping, updateSettings]);

  // the input line keeps a tapped grid from raising the keyboard; typing straight into it gives it
  // back. Only turning direct typing on raises it: a pane or lens picked with it on does not.
  const directTypingRef = useRef(directTyping);
  useEffect(() => {
    const turnedOn = directTyping && !directTypingRef.current;
    directTypingRef.current = directTyping;
    const textarea = hostRef.current?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (!textarea) return;
    if (inputLine) {
      textarea.setAttribute("inputmode", "none");
      if (document.activeElement === textarea) textarea.blur();
    } else {
      textarea.removeAttribute("inputmode");
      if (coarse && !chatView && turnedOn) termRef.current?.focus();
    }
  }, [inputLine, coarse, chatView, directTyping, paneId]);

  // the composer's stop button: Escape interrupts the agent's current turn in every
  // supported TUI (Claude Code, omp, codex) without killing the process the way ^C would
  const abortTurn = useCallback(() => {
    const term = termRef.current;
    const socket = socketRef.current;
    if (!term || !socket || !socket.connected) return;
    term.input("\u001b");
  }, []);

  // While the agent runs, append to its held messages. Each requires an explicit send.
  // a question in Codex's queue leaves the composer alone: Codex keeps working, and a
  // message ("stop, don't touch prod") must reach it, not become the answer; its card answers it
  // a fallback card is answered with its own buttons: what the user types still goes to the agent
  const answering = chatView && chatPrompt !== null && chatPrompt.pane === paneId && !chatPrompt.value.queued && !chatPrompt.value.fallback ? chatPrompt.value : null;
  // ...and while it is open in the terminal it holds the input: nothing is sent into it
  const heldByOpenQueue = chatView && chatPrompt !== null && chatPrompt.pane === paneId && chatPrompt.value.queued === "open";
  const busy = agent !== null && agentStatus === "working" && answering === null;
  const readyForQueue = agentStatus !== undefined && QUEUE_READY_STATUS[agentStatus] === true;

  const composerSend = useCallback(
    (text: string): boolean | string | Promise<boolean | string> => {
      const pane = paneRef.current;
      // Codex's queue open in the terminal holds the input: a message would become the answer
      if (pane !== null && heldByOpenQueue) {
        return t("Codex has a question open in the terminal: answer it above, or close it there (alt+↓) to message Codex.");
      }
      if (pane !== null && answering !== null) {
        // never typed into the agent's menu: only as one of its options, or its own reply row
        const choice = answerFromText(answering, text);
        if (choice === null) return answerRefusal(answering);
        if (needsConfirmation(answering, choice)) {
          setPendingAnswer({ pane, promptId: answering.id, answer: choice });
          return true;
        }
        setPendingAnswer(null);
        return answerPanePrompt({ pane_id: pane, prompt_id: answering.id, ...choice, expected_terminal_id: answering.target_terminal_id }).then(
          () => { setPromptRefresh((key) => key + 1); return true; },
          (cause: unknown) => {
            setPromptRefresh((key) => key + 1);
            return cause instanceof ApiError && cause.status === 409 ? t("The question on screen changed; check it and answer again.") : String(cause instanceof Error ? cause.message : cause);
          },
        );
      }
      if (pane !== null && agent !== null && agentStatus === "working") {
        queueStore.add(paneStorageId(machineId, pane), text);
        return true; // the composer may clear its box: the text lives in the queue card
      }
      return sendComposerText(text);
    },
    [agent, agentStatus, answerPanePrompt, answering, heldByOpenQueue, sendComposerText, queueStore, machineId],
  );


  // Capture the owner's pane for the entire upload batch, even across a pane switch.
  const uploadImage = useCallback((file: File) => uploadPaneImage(paneId ?? "", file), [paneId]);

  return (
    // data-direct-typing: xterm's own field raises the soft keyboard here (lib/viewport.ts)
    <div className={`terminal-stack${chatView ? " is-chat" : ""}`} data-direct-typing={coarse && directTyping && !chatView ? "" : undefined}>
      {paneId === null && restoreError !== null && (
        <div className="terminal-placeholder is-restore-error" role="status">
          <div className="terminal-placeholder-inner">
            <TriangleAlert aria-hidden="true" />
            <span>{t("herdr could not restore this pane")}</span>
            <span className="terminal-placeholder-detail">{restoreError}</span>
          </div>
        </div>
      )}
      {paneId === null && restoreError === null && (
        <div className="terminal-placeholder">
          <div className="terminal-placeholder-inner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
              <path d="M7 9l3 3-3 3" />
              <path d="M12.5 15h4.5" />
            </svg>
            <span>{t("Select a pane to open its terminal")}</span>
          </div>
        </div>
      )}
      <div className="terminal-banners">
        {paneId !== null && held && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            <span>{t("Another app has this pane open. It connects here as soon as that app lets go.")}</span>
          </div>
        )}
        {paneId !== null && !chatView && unsupported && (
          <div className="terminal-banner terminal-banner-soon" role="status">
            <span>{t("Live terminal is coming to Windows PCs: herdr cannot attach a terminal there yet. The chat lens works now.")}</span>
          </div>
        )}
        {paneId !== null && outputError && (
          <div className="terminal-banner terminal-banner-warning terminal-banner-output-error" role="status">
            <span>{outputError}</span>
            <a className="btn" href={`?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}`}>{t("Reconnect")}</a>
          </div>
        )}
        {!chatView && inputError && <div className="terminal-banner" role="status">{inputError}<button className="btn" onClick={() => setInputError(null)}>{t("Dismiss")}</button></div>}
        {!chatView && !observing && connected && !inputReady && !held && !ended && <div className="terminal-banner" role="status">{t("Waiting for terminal input…")}</div>}
        {/* the chat lens says these itself (ChatView), inline; the pills are the grid's */}
        {paneId !== null && !chatView && ended && !outputError && (
          <div className="terminal-banner" role="status">
            {t("Terminal ended")}{!draftIsEmpty(draft) ? t(" — held input discarded") : ""}
          </div>
        )}
        {paneId !== null && !chatView && !ended && !connected && (
          <div className="terminal-banner terminal-banner-warning" role="status">
            {t("Reconnecting to TermWeave…")}
            {!draftIsEmpty(draft) && <span className="draft-held">{t("Input held:")} “{draft.text}”</span>}
          </div>
        )}
        {paneId !== null && !ended && connected && !draftIsEmpty(draft) && (
          <div className="terminal-banner terminal-banner-draft" role="status">
            <span className="draft-label">{t("Input held until the terminal is ready:")}</span>
            <code className="draft-text">{draft.text.length > 0 ? draft.text : "—"}</code>
            {draft.droppedSpecial > 0 && (
              <span className="draft-dropped">{t(draft.droppedSpecial === 1 ? "{count} special key dropped" : "{count} special keys dropped", { count: draft.droppedSpecial })}</span>
            )}
            <span className="draft-actions">
              <button type="button" className="draft-send" disabled={draft.text.length === 0 || observing || secretActive || held} onClick={sendDraft}>
                {t("Send")}
              </button>
              <button type="button" className="draft-discard" onClick={discardDraft}>
                {t("Discard")}
              </button>
            </span>
          </div>
        )}
        {paneId !== null && !ended && observing && (
          <div className="terminal-banner terminal-banner-observe" role="status">
            {t("View only — operator screen size is unchanged")}
          </div>
        )}
        {clipboardNote && (
          <div className="terminal-banner" role="status">
            {clipboardNote}
          </div>
        )}
      </div>
      <div className="terminal-surface">
        <div className={`pane-terminal${paneId === null ? " is-idle" : ""}`} ref={hostRef} />
        {paneId !== null && chatView && (
          <RenderBoundary resetKey={paneId} fallback={(retry) => (
            <div className="chat-view"><div className="chat-empty" role="alert">
              <p>{t("The chat can't be shown. The terminal still works.")}</p>
              <button type="button" className="btn" onClick={retry}>{t("Try again")}</button>
            </div></div>
          )}>
          <ChatView
            paneId={paneId}
            refreshKey={chatRefresh}
            sentKey={chatSent}
            connected={connected}
            ended={ended}
            agent={agent}
            agentStatus={agentStatus}
            onMetadata={onChatMetadata}
            onPrompt={onChatPrompt}
            onSuggestion={onChatSuggestion}
            promptRefreshKey={promptRefresh}
            pendingAnswer={pendingAnswer !== null && pendingAnswer.pane === paneId ? pendingAnswer : null}
            onPendingAnswerDone={clearPendingAnswer}
          />
          </RenderBoundary>
        )}
      </div>
      {/* the queue is the composer's, so it shows under the chat lens only: there alone is an open
          Codex question known (heldByOpenQueue), and Send now must not type into one */}
      {paneId !== null && chatView && !observing && !ended && queueOwner !== null && queued.length > 0 && (
        <section className="composer-queue" aria-label={t("Queued messages")}>
          <div className="composer-queue-heading">
            <strong>{t("Queued messages ({n})", { n: queued.length })}</strong>
            <span className="composer-queue-label">{t(readyForQueue ? "Held message — review and send" : "Held until the agent is ready")}</span>
          </div>
          {queueStore.isUnsaved(queueOwner) && <p className="composer-queue-error" role="status">{t("Queue could not be saved. Keep this tab open or copy the messages before reloading.")}</p>}
          <ol className="composer-queue-list">
          {queued.map((message, index) => <li className="composer-queue-item" key={message.id}>
            <label className="composer-queue-label" htmlFor={`queued-${message.id}`}>{t("Message {n}", { n: index + 1 })}</label>
            <textarea
              id={`queued-${message.id}`}
              className="composer-queue-text"
              value={message.text}
              rows={Math.min(4, message.text.split("\n").length)}
              aria-label={t("Queued message {n}", { n: index + 1 })}
              maxLength={MAX_COMPOSER_CHARS}
              disabled={queueStore.isSending(message.id)}
              spellCheck={false} autoCapitalize="off" autoCorrect="off"
              onChange={(event) => { queueStore.edit(queueOwner, message.id, event.target.value); }}
            />
            <div className="composer-queue-actions">
              <button type="button" className="composer-queue-send"
                disabled={!connected || held || secretActive || queueSending !== null || queued.some((item) => queueStore.isSending(item.id)) || heldByOpenQueue || message.text.trim().length === 0}
                title={heldByOpenQueue ? t("Codex has a question open in the terminal: answer it above first") : undefined}
                onClick={() => {
                  if (sendingRef.current || !queueStore.beginSend(queueOwner, message.id)) return;
                  sendingRef.current = true;
                  setQueueSending(message.id); setQueueError(null);
                  const owner = queueOwner;
                  void Promise.resolve(sendComposerText(message.text))
                    .then((result) => {
                      if (result === true) { queueStore.remove(owner, message.id); }
                      else setQueueError({ owner, id: message.id, text: typeof result === "string" ? result : t("Not sent. Reconnect and try again.") });
                    })
                    .catch(() => setQueueError({ owner, id: message.id, text: t("Not confirmed. Check the terminal before sending again.") }))
                    .finally(() => { queueStore.endSend(owner, message.id); sendingRef.current = false; setQueueSending(null); });
                }}>{t("Send now")}</button>
              <button type="button" className="composer-queue-discard" disabled={queueStore.isSending(message.id)}
                onClick={() => { queueStore.remove(queueOwner, message.id); }}>{t("Discard")}</button>
            </div>
            {queueError?.owner === queueOwner && queueError.id === message.id && <p className="composer-queue-error" role="status">{queueError.text}</p>}
          </li>)}
          </ol>
        </section>
      )}
      {/* the composer belongs to the chat lens: in terminal mode the grid itself is
          the input surface (key bar included), so a second box would only duplicate it */}
      {paneId !== null && secretActive && !observing && !ended && connected && outputReady && <SecretInput
        key={`${paneId}:${secret.prompt}`} prompt={secret.prompt}
        onSend={(value) => socketRef.current?.sendSecret(paneId, secret.prompt, value) ?? null}
        onCancel={() => { if (socketRef.current?.connected) socketRef.current.sendInput(paneId, "\u0003"); }}
      />}
      {paneId !== null && chatView && !secretActive && !observing && !ended && (
        <Composer
          key={paneId}
          paneId={paneId}
          autoFocus={!autoSelected && !coarse}
          agent={agent}
          agentStatus={agentStatus}
          backgroundTasks={backgroundTasks}
          metadata={chatMetadata?.pane === paneId ? chatMetadata.value : null}
          connected={connected && !held}
          queueMode={busy}
          answerHint={answering === null ? null
            : pendingAnswer?.promptId === answering.id ? t("Confirm your answer in the card above, or type another…") : answerHint(answering)}
          // no suggestion under any card, a fallback or queued one included
          suggestion={chatPrompt?.pane !== paneId && chatSuggestion?.pane === paneId ? chatSuggestion.value : null}
          onSend={composerSend}
          onAbort={abortTurn}
          onUploadImage={uploadImage}
        />
      )}
      {paneId !== null && !secretActive && !observing && !ended && inputLine && <TerminalInput key={paneId} owner={paneStorageId(machineId, paneId)} onComposing={setComposing} connected={connected && !held} onSend={sendTerminalLine} onEnter={pressEnter} />}
      {paneId !== null && !secretActive && !observing && !chatView && <KeyBar disabled={composing} onKey={pressKey} ctrlArmed={ctrlArmed} onToggleCtrl={toggleCtrl}
        {...(coarse ? { directTyping, onToggleDirect: toggleDirect } : {})} />}
    </div>
  );
}
