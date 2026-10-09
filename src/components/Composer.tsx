import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Clock, FileText, Paperclip, SendHorizontal, Square, X } from "lucide-react";

import "./Composer.css";

import type { AgentStatus, ConversationMetadata, SlashCommand } from "../../shared/protocol.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneStorageId } from "../../shared/machines.ts";
import {
  agentDisplayLabel,
  composerStatusWord,
  contextLeftPercent,
  formatTokens,
  imageMention,
  insertMention,
  MAX_COMPOSER_CHARS,
  rankSlashCommands,
  terminalOnlyCommand,
} from "../lib/compose.ts";
import { activeTrigger, applyCompletion, type ActiveTrigger } from "../lib/mentions.ts";
import { quickReplyButtons, useSettings } from "../lib/settings.ts";
import { AgentMark } from "./AgentMark.tsx";
import { BackgroundTasks } from "./BackgroundTasks.tsx";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";
import { useT } from "../lib/i18n.ts";

export interface ComposerProps {
  connected: boolean;
  paneId: string;
  /** false: appearing must not take the keyboard (App switched to this pane on its own) */
  autoFocus?: boolean;
  agent: string | null;
  agentStatus?: AgentStatus;
  /** an OmO pane's running background tasks: the status line opens their list */
  backgroundTasks?: number;
  metadata?: ConversationMetadata | null;
  queueMode?: boolean;
  /** replaces the placeholder: how a message answers the agent's waiting prompt */
  answerHint?: string | null;
  /** what the agent suggests typing next (Claude's grey input text): the placeholder, taken with Tab */
  suggestion?: string | null;
  /** true: sent, clear the box; a string: keep the text and say why; a promise settles to either */
  onSend: (text: string) => boolean | string | Promise<boolean | string>;
  onAbort: () => void;
  onUploadImage: (file: File) => Promise<string>;
}

const MAX_IMAGES_PER_ACTION = 4;
/**
 * Any file can be attached (an icon, a PDF, a log): the server stores it beside the pane
 * and the message mentions its path. These image types also get a thumbnail.
 */
const PREVIEW_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"] as const;
const COMMAND_CACHE_MS = 60_000;
const SLASH_USAGE_KEY = "termweave:slash-usage";
/** One height for every pane on this device: it is the screen, not the conversation, that decides it. */
const COMPOSER_HEIGHT_KEY = "termweave:composer-height";
const COMPOSER_HEIGHT_MAX = 480;
const COMPOSER_HEIGHT_STEP = 24;
/** How far a press on the grip must travel to become a resize: a tap or a resting finger sets nothing. */
const RESIZE_SLACK = { mouse: 3, touch: 10 } as const;
/** Two taps on the grip this close return the box to its automatic height (iOS may send no dblclick). */
const DOUBLE_TAP_MS = 350;
const COMMAND_SOURCES = ["builtin", "user", "project", "skill", "plugin"] as const;
export const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
  builtin: "Built in",
  user: "User",
  project: "Project",
  skill: "Skills",
  plugin: "Plugins",
};

type CommandCacheEntry = { loadedAt: number; commands: SlashCommand[] };
const commandCache = new Map<string, CommandCacheEntry>();
let attachmentSequence = 0;

type Attachment = {
  id: number;
  file: File;
  previewUrl: string;
  path: string | null;
  state: "uploading" | "ready" | "error";
};

function readSlashUsage(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SLASH_USAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  } catch {
    return {};
  }
}

/** A saved manual height, or null for the automatic one (also for anything malformed). */
function readComposerHeight(): number | null {
  try {
    const value = Number(window.localStorage.getItem(COMPOSER_HEIGHT_KEY));
    return Number.isFinite(value) && value > 0 && value <= COMPOSER_HEIGHT_MAX ? Math.round(value) : null;
  } catch {
    return null;
  }
}

function saveComposerHeight(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(COMPOSER_HEIGHT_KEY);
    else window.localStorage.setItem(COMPOSER_HEIGHT_KEY, String(value));
  } catch {
    // Without storage the height still holds until reload.
  }
}

/** Half the visible viewport at most, so a raised keyboard never leaves the transcript without room. */
function composerHeightLimit(): number {
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  return Math.min(COMPOSER_HEIGHT_MAX, Math.floor(viewport / 2));
}

async function cachedPaneCommands(paneId: string, machineId: string, fetchCommands: (pane: string) => Promise<SlashCommand[]>): Promise<SlashCommand[]> {
  const cached = commandCache.get(paneStorageId(machineId, paneId));
  if (cached && Date.now() - cached.loadedAt < COMMAND_CACHE_MS) return cached.commands;
  const commands = await fetchCommands(paneId);
  commandCache.set(paneStorageId(machineId, paneId), { loadedAt: Date.now(), commands });
  return commands;
}

/**
 * What is left of the context, as a ring filled by what is used (as Codex's app shows it):
 * red when little is left. The number is on hover, and on a tap beside the ring (a touch
 * screen has no hover). A window the transcript does not name draws no ring.
 */
function ContextRing({ context }: { context: NonNullable<ConversationMetadata["context"]> }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const left = contextLeftPercent(context);
  if (left === null || context.window === null) return null;
  const label = t("Context {percent}% left", { percent: left });
  const detail = t("{used} of {window} tokens", { used: formatTokens(context.used), window: formatTokens(context.window) });
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <button
      type="button"
      className={`composer-context${left <= 20 ? " is-low" : ""}`}
      aria-label={`${label} · ${detail}`}
      title={`${label} · ${detail}`}
      aria-expanded={shown}
      onClick={() => setShown((open) => !open)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle className="composer-context-track" cx="8" cy="8" r={radius} />
        <circle className="composer-context-used" cx="8" cy="8" r={radius}
          strokeDasharray={`${circumference * (100 - left) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
      </svg>
      {shown && <span className="composer-context-text">{label}</span>}
    </button>
  );
}

/** Chat-style input surface with pane-local drafts, command/file completion, and image mentions. */
export function Composer({
  connected,
  paneId,
  autoFocus = true,
  agent,
  agentStatus,
  backgroundTasks = 0,
  metadata,
  queueMode = false,
  answerHint = null,
  suggestion = null,
  onSend,
  onAbort,
  onUploadImage,
}: ComposerProps) {
  const t = useT();
  const machineId = useMachineId();
  const { fetchPaneCommands, fetchPaneFiles } = useMachineApi();
  const { settings } = useSettings();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  // the chat lens's input surface takes the keyboard when it appears (a pane switch remounts
  // it), as the grid does in the terminal lens: a pane picked from the drawer is typed into
  // and once the user picks the pane App had switched to on its own
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentsRef = useRef<Attachment[]>([]);
  const removedAttachments = useRef(new Set<number>());
  const fileRequest = useRef(0);
  const draftKey = `termweave:composer-draft:${paneStorageId(machineId, paneId)}`;
  const { text, sending } = useSyncExternalStore(composerDrafts.subscribe, () => composerDrafts.read(draftKey));
  const setText = useCallback((value: string | ((previous: string) => string)) => composerDrafts.set(draftKey, value), [draftKey]);
  const mounted = useRef(true);
  const [caret, setCaret] = useState(text.length);
  const textRef = useRef(text);
  const caretRef = useRef(caret);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [slashUsage, setSlashUsage] = useState<Record<string, number>>(readSlashUsage);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // shown only when chosen in Settings → Quick replies: a button beside the box was one more thing to read
  const quickOpen = settings.showQuickReplies;
  const quickReplies = quickReplyButtons(settings);
  const [manualHeight, setManualHeight] = useState<number | null>(readComposerHeight);
  /** the box's rendered height, for the grip to announce while the height is automatic */
  const [autoHeight, setAutoHeight] = useState(0);
  /** the automatic height of an empty box (the textarea's CSS min-height): the grip's floor */
  const [minHeight, setMinHeight] = useState(0);
  const [heightLimit, setHeightLimit] = useState(composerHeightLimit);
  const lastGripTap = useRef(0);

  attachmentsRef.current = attachments;
  textRef.current = text;
  caretRef.current = caret;
  // Codex names its skills with `$`: only there does a `$` open a menu
  const trigger = useMemo(() => activeTrigger(text, caret, { skills: agent === "codex" }), [agent, caret, text]);
  /** a command the agent runs but the chat cannot finish, while it is what the box holds */
  const terminalOnly = useMemo(() => terminalOnlyCommand(agent, text), [agent, text]);
  const uploading = attachments.some((attachment) => attachment.state === "uploading");
  const agentLabel = agentDisplayLabel(agent);
  // the agent's suggestion stands in the empty box as it does in its own input, until anything is typed
  const offered = connected && answerHint === null && suggestion !== null ? suggestion : null;
  const placeholder = !connected
    ? t("Reconnecting… message held here, never queued")
    : answerHint ?? offered ?? t("Message {agent}…", { agent: agentLabel });

  useEffect(() => {
    let live = true;
    void cachedPaneCommands(paneId, machineId, fetchPaneCommands)
      .then((next) => {
        if (live) setCommands(next);
      })
      .catch(() => {
        if (live) setCommands([]);
      });
    return () => {
      live = false;
    };
  }, [paneId]);

  useEffect(() => {
    const request = ++fileRequest.current;
    if (trigger?.kind !== "file") {
      setFiles([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetchPaneFiles(paneId, trigger.query, 20)
        .then((next) => {
          if (request === fileRequest.current) setFiles(next);
        })
        .catch(() => {
          if (request === fileRequest.current) setFiles([]);
        });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [paneId, trigger?.kind, trigger?.query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [trigger?.kind, trigger?.query]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.previewUrl);
    };
  }, []);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const floor = Math.round(parseFloat(getComputedStyle(element).minHeight)) || 0;
    setMinHeight((current) => current === floor ? current : floor);
    if (manualHeight !== null) {
      element.style.height = `${manualHeight}px`;
      return;
    }
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
    const height = Math.round(element.getBoundingClientRect().height);
    setAutoHeight((current) => current === height ? current : height);
  }, [text, manualHeight, placeholder]);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = (): void => setHeightLimit(composerHeightLimit());
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const maxHeight = Math.max(minHeight, heightLimit);
  /** A grip height within the limits; at or below the automatic floor it is the automatic height again. */
  const gripHeight = (value: number): number | null => value <= minHeight ? null : Math.round(Math.min(maxHeight, value));

  /**
   * Dragging the grip up grows the box; the pointer stays captured, so a finger may leave the grip.
   * The height changes only once the press has moved past the slack, and is saved when it lets go.
   */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = textareaRef.current;
    if (!element || event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget;
    grip.setPointerCapture(event.pointerId);
    const slack = event.pointerType === "mouse" ? RESIZE_SLACK.mouse : RESIZE_SLACK.touch;
    const startHeight = element.getBoundingClientRect().height;
    const startY = event.clientY;
    let resizing = false;
    let height = manualHeight;
    const move = (next: PointerEvent): void => {
      if (!resizing && Math.abs(next.clientY - startY) < slack) return;
      resizing = true;
      height = gripHeight(startHeight + startY - next.clientY);
      setManualHeight(height);
    };
    const end = (finished: PointerEvent): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      if (resizing) {
        lastGripTap.current = 0;
        saveComposerHeight(height);
      } else if (finished.type === "pointerup") {
        // a tap: the second of two quick ones returns the automatic height
        if (finished.timeStamp - lastGripTap.current < DOUBLE_TAP_MS) {
          lastGripTap.current = 0;
          setManualHeight(null);
          saveComposerHeight(null);
        } else {
          lastGripTap.current = finished.timeStamp;
        }
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  };

  const onResizeKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = manualHeight ?? textareaRef.current?.getBoundingClientRect().height ?? minHeight;
    const step = event.shiftKey ? COMPOSER_HEIGHT_STEP * 2 : COMPOSER_HEIGHT_STEP;
    let next: number | null;
    if (event.key === "ArrowUp") next = gripHeight(current + step);
    else if (event.key === "ArrowDown") next = gripHeight(current - step);
    else if (event.key === "Home") next = null;
    else return;
    event.preventDefault();
    setManualHeight(next);
    saveComposerHeight(next);
  };
  const gripValue = Math.round(Math.min(maxHeight, Math.max(minHeight, manualHeight ?? autoHeight)));

  const filteredCommands = useMemo(
    () => (trigger?.kind === "slash"
      ? rankSlashCommands(commands.filter((command) => (command.trigger ?? "/") === (trigger.prefix ?? "/")), trigger.query, slashUsage)
      : []),
    [commands, slashUsage, trigger],
  );
  const orderedCommands = useMemo(
    () => COMMAND_SOURCES.flatMap((source) => filteredCommands.filter((command) => command.source === source)),
    [filteredCommands],
  );
  const choices: readonly (SlashCommand | string)[] = trigger?.kind === "slash" ? orderedCommands : files;
  const menuOpen = !menuDismissed && trigger !== null && choices.length > 0;

  useEffect(() => {
    if (selectedIndex >= choices.length) setSelectedIndex(Math.max(0, choices.length - 1));
  }, [choices.length, selectedIndex]);

  // dictation lands at the caret without taking focus (a phone's keyboard stays as it was)
  const dictation = useDictation({
    mode: "chat",
    connected,
    polish: settings.voicePolishChat,
    keywords: () => [...(agent ? [agentLabel] : []), ...commands.map((command) => command.name)],
    box: textareaRef,
    read: () => textRef.current,
    // a dictation that does not fit is refused whole: cutting would drop the draft after the caret
    maxLength: MAX_COMPOSER_CHARS,
    write: (value, at) => {
      textRef.current = value;
      caretRef.current = at;
      setText(value);
      setCaret(at);
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (element) element.selectionStart = element.selectionEnd = at;
      });
    },
    onNote: setNote,
  });

  const setTextAndCaret = useCallback((nextText: string, nextCaret: number) => {
    const limitedText = nextText.slice(0, MAX_COMPOSER_CHARS);
    const clampedCaret = Math.min(nextCaret, MAX_COMPOSER_CHARS);
    textRef.current = limitedText;
    caretRef.current = clampedCaret;
    setText(limitedText);
    setCaret(clampedCaret);
    setMenuDismissed(false);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (!element) return;
      element.selectionStart = element.selectionEnd = clampedCaret;
      element.focus();
    });
  }, []);

  const insertMentionAtCursor = useCallback(
    (mention: string) => {
      const element = textareaRef.current;
      const currentText = textRef.current;
      const selectionIsCurrent = element?.value === currentText;
      const start = selectionIsCurrent ? (element.selectionStart ?? caretRef.current) : caretRef.current;
      const end = selectionIsCurrent ? (element.selectionEnd ?? start) : start;
      const next = insertMention(currentText, start, end, mention);
      setTextAndCaret(next.text, next.caret);
    },
    [setTextAndCaret],
  );

  const selectCompletion = useCallback(
    (choice: SlashCommand | string, currentTrigger: ActiveTrigger) => {
      const replacement = currentTrigger.kind === "slash" ? `${currentTrigger.prefix ?? "/"}${(choice as SlashCommand).name} ` : `@${choice as string} `;
      const completed = applyCompletion(text, currentTrigger, replacement);
      setTextAndCaret(completed.text, completed.caret);
      setMenuDismissed(true);
      if (currentTrigger.kind === "slash") {
        const name = (choice as SlashCommand).name;
        setSlashUsage((current) => {
          const next = { ...current, [name]: (current[name] ?? 0) + 1 };
          try {
            window.localStorage.setItem(SLASH_USAGE_KEY, JSON.stringify(next));
          } catch {
            // Completion still works when storage is unavailable.
          }
          return next;
        });
      }
    },
    [setTextAndCaret, text],
  );

  const uploadImages = useCallback(
    async (incoming: readonly File[]) => {
      const images = incoming.slice(0, MAX_IMAGES_PER_ACTION);
      if (images.length === 0) return;

      const added = images.map<Attachment>((file) => ({
        id: ++attachmentSequence,
        file,
        previewUrl: (PREVIEW_TYPES as readonly string[]).includes(file.type) ? URL.createObjectURL(file) : "",
        path: null,
        state: "uploading",
      }));
      setAttachments((current) => [...current, ...added]);
      setNote(null);

      for (const attachment of added) {
        if (!mounted.current) break;
        try {
          const path = await onUploadImage(attachment.file);
          if (!mounted.current) break;
          if (removedAttachments.current.has(attachment.id)) continue;
          setAttachments((current) =>
            current.map((item) => (item.id === attachment.id ? { ...item, path, state: "ready" } : item)),
          );
          insertMentionAtCursor(imageMention(path));
        } catch (error) {
          if (!mounted.current) break;
          if (removedAttachments.current.has(attachment.id)) continue;
          setAttachments((current) =>
            current.map((item) => (item.id === attachment.id ? { ...item, state: "error" } : item)),
          );
          setNote(error instanceof Error ? error.message : String(error));
        }
      }
    },
    [insertMentionAtCursor, onUploadImage],
  );

  const removeAttachment = useCallback((attachment: Attachment) => {
    removedAttachments.current.add(attachment.id);
    URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
    if (attachment.path) {
      const mention = imageMention(attachment.path);
      setText((current) => {
        const next = current.replace(mention, "");
        textRef.current = next;
        caretRef.current = Math.min(caretRef.current, next.length);
        return next;
      });
    }
  }, []);

  const send = useCallback(() => {
    if (composingRef.current) return;
    if (!connected || uploading || sending || text.trim().length === 0) return;
    const sent = text;
    const sentAttachments = attachments;
    const settle = (result: boolean | string): void => {
      const acknowledged = result === true ? composerDrafts.settle(draftKey, sent) : null;
      if (!mounted.current) return;
      if (typeof result === "string") setNote(result);
      if (acknowledged === null) return;
      // only what was sent leaves the box: text added after it stays exactly as typed. Changed
      // inside while on its way, the whole edit stays, and the note says it was not sent
      const { text: rest, edited } = acknowledged;
      setCaret(rest.length);
      textRef.current = rest;
      caretRef.current = rest.length;
      setNote(edited ? t("Sent as it was. Your changes made while it was sending stayed here and were not sent.") : null);
      for (const attachment of sentAttachments) URL.revokeObjectURL(attachment.previewUrl);
      setAttachments((current) => current.filter((attachment) => !sentAttachments.includes(attachment)));
    };
    if (!composerDrafts.begin(draftKey, sent)) return;
    // a polish landing before the acknowledgement would count as an edit and keep the sent message here
    dictation.forget();
    try {
      const result = onSend(text);
      if (!(result instanceof Promise)) { settle(result); composerDrafts.end(draftKey); return; }
      void result.then(settle).catch(() => { if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again.")); }).finally(() => composerDrafts.end(draftKey));
    } catch {
      composerDrafts.end(draftKey);
      if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again."));
    }
  }, [attachments, connected, dictation.forget, draftKey, onSend, sending, text, uploading]);

  /** A quick reply goes the way a typed message does (queued mid-turn, an answer to an open menu), and leaves the box alone. */
  const sendQuick = useCallback((reply: string) => {
    if (!connected || sending) return;
    setNote(null);
    const settle = (result: boolean | string): void => {
      if (mounted.current && typeof result === "string") setNote(result);
    };
    if (!composerDrafts.begin(draftKey)) return;
    try {
      const result = onSend(reply);
      if (!(result instanceof Promise)) { settle(result); composerDrafts.end(draftKey); return; }
      void result.then(settle).catch(() => { if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again.")); }).finally(() => composerDrafts.end(draftKey));
    } catch {
      composerDrafts.end(draftKey);
      if (mounted.current) setNote(t("Not confirmed. Check the terminal before sending again."));
    }
  }, [connected, draftKey, onSend, sending]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // an IME keeps its keys; WebKit can send the committing Enter after compositionend, as key code 229
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (menuOpen && trigger) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          setSelectedIndex((current) => (current + direction + choices.length) % choices.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const choice = choices[selectedIndex];
          if (choice !== undefined) selectCompletion(choice, trigger);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMenuDismissed(true);
          return;
        }
      }
      if (event.key === "Escape" && trigger) {
        setMenuDismissed(true);
        return;
      }
      // Tab takes the suggestion into the empty box, as in Claude's own input
      if (event.key === "Tab" && !event.shiftKey && offered !== null && textRef.current === "") {
        event.preventDefault();
        setTextAndCaret(offered, offered.length);
        return;
      }
      if (event.key !== "Enter") return;
      const shouldSend = settings.enterSends
        ? !event.shiftKey && !event.metaKey && !event.ctrlKey
        : (event.metaKey || event.ctrlKey) && !event.shiftKey;
      if (!shouldSend) return;
      event.preventDefault();
      send();
    },
    [choices, menuOpen, offered, selectCompletion, selectedIndex, send, setTextAndCaret, settings.enterSends, trigger],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const images = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (images.length === 0) return;
      event.preventDefault();
      void uploadImages(images);
    },
    [uploadImages],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      void uploadImages(Array.from(event.dataTransfer.files));
    },
    [uploadImages],
  );

  const isWorking = agentStatus === "working";
  const menuId = `composer-menu-${paneId}`;

  return (
    <div className="composer" role="group" aria-label={t("Message composer")}>
      <div className="composer-status" role="status" data-status={agentStatus ?? "unknown"}>
        {agent && <AgentMark agent={agent} size={14} />}
        <span className="composer-agent-label">{agentLabel}</span>
        <span className="composer-status-separator" aria-hidden="true">·</span>
        <strong>{t(composerStatusWord(agentStatus))}</strong>
        <BackgroundTasks paneId={paneId} count={backgroundTasks} omo={agent === "omo"} />
        {(metadata?.model || metadata?.reasoning_effort) && <span className="composer-model-info" aria-label={t("Model and reasoning")}>
          <span className="composer-model" title={metadata.model ?? t("Model not available")}>{metadata.model ?? t("Model —")}</span>
          <span className="composer-reasoning" title={metadata.reasoning_effort ? t("Reasoning effort: {effort}", { effort: metadata.reasoning_effort }) : t("Reasoning effort not available")}>
            <span className="composer-reasoning-full">{t("Reasoning {effort}", { effort: metadata.reasoning_effort ?? "—" })}</span>
            <span className="composer-reasoning-short" aria-hidden="true">{metadata.reasoning_effort ?? "—"}</span>
          </span>
        </span>}
        {metadata?.context && <ContextRing context={metadata.context} />}
        {(uploading || !connected) && (
          <span className="composer-status-hint">
            <span aria-hidden="true">·</span> {t(uploading ? "Uploading file…" : "Reconnecting… message held here, never queued")}
          </span>
        )}
      </div>

      {/* no Tab key on a phone: the suggestion can be a chip there that fills the box, once chosen in Settings */}
      {settings.showSuggestionChip && offered !== null && text === "" && (
        <div className="composer-quick composer-suggestion-row">
          <button type="button" className="composer-quick-reply composer-suggestion" title={t("Use the suggestion")} onClick={() => setTextAndCaret(offered, offered.length)}>
            <span aria-hidden="true">↹ </span>{offered}
          </button>
        </div>
      )}

      {quickOpen && quickReplies.length > 0 && (
        <div className="composer-quick" role="group" aria-label={t("Quick replies")}>
          {quickReplies.map((reply, index) => (
            <button
              key={`${index}:${reply}`}
              type="button"
              className="composer-quick-reply"
              title={t("Send “{reply}”", { reply })}
              disabled={!connected || sending}
              onClick={() => sendQuick(reply)}
            >
              {reply}
            </button>
          ))}
        </div>
      )}

      <div
        className={`composer-surface${dragging ? " is-dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <div
          className="composer-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("Resize message box")}
          aria-valuemin={minHeight}
          aria-valuemax={maxHeight}
          aria-valuenow={gripValue}
          aria-valuetext={manualHeight === null ? "automatic height" : `${gripValue} pixels`}
          tabIndex={0}
          title={t("Drag to resize · double-click to reset")}
          onPointerDown={startResize}
          onKeyDown={onResizeKey}
        />
        {menuOpen && trigger && (
          <div id={menuId} className="menu composer-menu" role="listbox" aria-label={t(trigger.kind === "slash" ? "Slash commands" : "Files")}>
            {trigger.kind === "slash" ? (
              COMMAND_SOURCES.map((source) => {
                const group = filteredCommands.filter((command) => command.source === source);
                if (group.length === 0) return null;
                return (
                  <div className="composer-menu-group" key={source}>
                    <div className="menu-heading">{t(SOURCE_LABEL[source])}</div>
                    {group.map((command) => {
                      const index = orderedCommands.indexOf(command);
                      return (
                        <button
                          id={`${menuId}-${index}`}
                          key={`${command.source}:${command.name}`}
                          type="button"
                          className="menu-item"
                          role="option"
                          aria-selected={index === selectedIndex}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => selectCompletion(command, trigger)}
                        >
                          <span className="menu-item-main">{command.trigger ?? "/"}{command.name}</span>
                          <span className="menu-item-hint">{command.description}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })
            ) : (
              <div className="composer-menu-group">
                <div className="menu-heading">{t("Files")}</div>
                {files.map((file, index) => (
                  <button
                    id={`${menuId}-${index}`}
                    key={file}
                    type="button"
                    className="menu-item"
                    role="option"
                    aria-selected={index === selectedIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectCompletion(file, trigger)}
                  >
                    <span className="menu-item-main">{file}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label={t("Attached files")}>
            {attachments.map((attachment) => (
              <div className={`composer-attachment is-${attachment.state}`} key={attachment.id}>
                {attachment.previewUrl ? <img src={attachment.previewUrl} alt={attachment.file.name} />
                  : <span className="composer-attachment-file" title={attachment.file.name}><FileText aria-hidden="true" /><span>{attachment.file.name}</span></span>}
                <span className="composer-attachment-state">
                  {t(attachment.state === "uploading" ? "Uploading" : attachment.state === "error" ? "Failed" : "Attached")}
                </span>
                <button type="button" aria-label={t("Remove {file}", { file: attachment.file.name })} onClick={() => removeAttachment(attachment)}>
                  <X aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
          className={`composer-text${manualHeight !== null ? " is-sized" : ""}`}
          rows={1}
          maxLength={MAX_COMPOSER_CHARS}
          value={text}
          placeholder={placeholder}
          aria-label={t("Message")}
          aria-controls={menuOpen ? menuId : undefined}
          aria-expanded={menuOpen}
          aria-activedescendant={menuOpen ? `${menuId}-${selectedIndex}` : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          // stays editable while the socket reconnects (sending waits for it): a phone's
          // dictation keyboard opens its own app and comes back, the socket may drop meanwhile,
          // and a disabled box would lose its focus and the dictated text with it
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            setCaret(event.currentTarget.selectionStart);
            setMenuDismissed(false);
          }}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setMenuDismissed(false);
            setNote(null);
          }}
        />

        <div className="composer-controls composer-controls-left">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void uploadImages(picked);
            }}
          />
          <button
            type="button"
            className="icon-button composer-attach"
            aria-label={t("Attach files")}
            title={t("Attach files")}
            disabled={!connected || uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip aria-hidden="true" />
          </button>
          {dictation.shown && <MicButton dictation={dictation} />}
        </div>
        <div className="composer-controls composer-controls-right">
          {queueMode && (
            <button
              type="button"
              className="composer-queue-button"
              aria-label={t("Queue message")}
              title={t("Queue as the next message")}
              disabled={!connected || uploading || sending || text.trim().length === 0}
              onClick={send}
            >
              <Clock aria-hidden="true" />
              {t("Queue")}
            </button>
          )}
          {isWorking ? (
            <button
              type="button"
              className="composer-action composer-stop"
              aria-label={t("Stop agent")}
              title={t("Stop agent")}
              disabled={!connected}
              onClick={onAbort}
            >
              <Square aria-hidden="true" />
            </button>
          ) : !queueMode ? (
            <button
              type="button"
              className="composer-action composer-send"
              aria-label={t("Send message")}
              title={t("Send message")}
              disabled={!connected || uploading || sending || text.trim().length === 0}
              onClick={send}
            >
              <SendHorizontal aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {note && <div className="composer-note" role="alert">{note}</div>}
      {/* said while typing, before the send: after it the browser is already open and the reader is
          already in the state the words describe. Not a block — the text still goes, and pi runs the
          command in the terminal the way its own palette would */}
      {!note && terminalOnly !== null && (
        <div className="composer-hint">{t("{command} opens a tree the chat cannot show. It runs in the terminal — tap the terminal button at the top of the screen to choose a branch.", { command: `/${terminalOnly}` })}</div>
      )}
      {/* above the whole composer: inside the surface it would cover the agent status line */}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="start" />}
    </div>
  );
}
