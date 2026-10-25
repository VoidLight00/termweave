import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { CornerDownLeft, SendHorizontal } from "lucide-react";

import "./TerminalInput.css";
import { readTerminalDraft, writeTerminalDraft, TERMINAL_LINE_LIMIT, subscribeTerminalDraft, terminalDraftSending, setTerminalDraftSending, acknowledgeTerminalDraft } from "../lib/terminalDraft.ts";

import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import { MicButton, VoiceRecordingPill, useDictation } from "./VoiceInput.tsx";

export interface TerminalInputProps {
  owner: string;
  onComposing?: (active: boolean) => void;
  connected: boolean;
  /** true: sent, clear the line; a string: keep the text and say why; false: not sent (offline) */
  onSend: (text: string) => false | Promise<true | string>;
  /** an empty line's send: Enter alone, for a menu's default or a prompt that asks to continue */
  onEnter: () => boolean;
}

/** Lines the box grows to before it scrolls. */
const MAX_ROWS = 4;

/**
 * The terminal's input line on a touch screen. A phone's keyboard rewrites what it typed
 * (dictation revising a phrase, an IME finishing a syllable, autocorrect), and a terminal
 * cannot take back keys it already sent: every revision arrived as more text. Here the line
 * is written with the keyboard's own editing and goes to the pane whole, then Enter.
 */
export function TerminalInput({ owner, connected, onSend, onEnter, onComposing }: TerminalInputProps) {
  const t = useT();
  const text = useSyncExternalStore(subscribeTerminalDraft, () => readTerminalDraft(owner));
  const setText = useCallback((value: string | ((previous: string) => string)) => {
    // Read the owner record even after unmount: a late acknowledgement must not erase
    // edits made in a newly mounted input for the same pane.
    const next = typeof value === "function" ? value(readTerminalDraft(owner)) : value;
    writeTerminalDraft(owner, next);

  }, [owner]);
  const composing = useRef(false);
  const composingCallback = useRef(onComposing);
  composingCallback.current = onComposing;
  useEffect(() => () => { composingCallback.current?.(false); }, []);

  const [note, setNote] = useState<string | null>(null);
  const sending = useSyncExternalStore(subscribeTerminalDraft, () => terminalDraftSending(owner));
  const box = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const { settings } = useSettings();
  const dictation = useDictation({
    mode: "terminal",
    connected,
    polish: settings.voicePolishTerminal,
    box,
    read: () => textRef.current,
    write: (value, caret) => {
      textRef.current = value;
      setText(value);
      requestAnimationFrame(() => {
        const element = box.current;
        if (!element) return;
        element.selectionStart = element.selectionEnd = caret;
        // without focus the browser does not follow the caret: a wrapped dictation's end would stay hidden
        if (caret === element.value.length) element.scrollTop = element.scrollHeight;
      });
    },
    onNote: setNote,
  });

  const send = useCallback(() => {
    if (!connected || terminalDraftSending(owner) || composing.current) return;
    setNote(null);
    // the stored line, not this render's: a send that waited for an IME commit runs before the re-render
    const text = readTerminalDraft(owner);
    if (text.length === 0) {
      if (!onEnter()) setNote(t("Not sent: the terminal is disconnected."));
      return;
    }
    const sent = onSend(text);
    if (sent === false) { setNote(t("Not sent: the terminal is disconnected.")); return; }
    // a polish that lands before the acknowledgement would read as text typed meanwhile, and
    // leave the sent command in the line
    dictation.forget();
    setTerminalDraftSending(owner, true);
    void sent.then((result) => {
      if (result === true) {
        // text typed while it was on its way stays
        acknowledgeTerminalDraft(owner);
      } else setNote(result);
    }).catch(() => setNote(t("Not confirmed. Check the terminal before sending again."))).finally(() => { setTerminalDraftSending(owner, false); });
  }, [connected, dictation.forget, onEnter, onSend, owner, t]);

  // A phone keyboard keeps the last syllable open, and the button keeps focus in the box, so a
  // tap on Send arrived mid-composition and was dropped. Commit the syllable first, then send.
  const sendLatest = useRef(send);
  sendLatest.current = send;
  const sendAfterCommit = useRef(false);
  const finishCommitSend = useCallback(() => {
    if (!sendAfterCommit.current) return;
    sendAfterCommit.current = false;
    composing.current = false;
    composingCallback.current?.(false);
    setTimeout(() => sendLatest.current(), 0); // after the commit's input event
  }, []);
  const onSendClick = (): void => {
    if (!composing.current) { send(); return; }
    sendAfterCommit.current = true;
    const element = box.current;
    element?.blur(); // ends the composition: compositionend, then the committed text
    element?.focus({ preventScroll: true });
    // ponytail: a keyboard that never reports compositionend on blur sends what the box shows
    setTimeout(finishCommitSend, 250);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter breaks the line; an IME keeps its Enter, including the committing
    // one WebKit can send after compositionend as key code 229
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  // wrapped lines count too: a dictated sentence is one long line, and its end must stay readable
  const [wrappedRows, setWrappedRows] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight);
    if (!(line > 0)) return;
    const shown = element.rows;
    element.rows = 1;
    const content = element.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    element.rows = shown;
    setWrappedRows(Math.max(1, Math.round(content / line)));
  }, [text]);
  const rows = Math.min(MAX_ROWS, Math.max(wrappedRows, text.split("\n").length));
  return (
    <div className={`terminal-input${dictation.shown ? " has-voice" : ""}`}>
      <textarea
        ref={box}
        className="terminal-input-text"
        rows={rows}
        value={text}
        maxLength={TERMINAL_LINE_LIMIT}
        onCompositionStart={() => { composing.current = true; onComposing?.(true); }}
        onCompositionEnd={() => { composing.current = false; onComposing?.(false); finishCommitSend(); }}
        placeholder={t("Type for the terminal…")}
        aria-label={t("Terminal input line")}
        enterKeyHint="send"
        autoCapitalize="off"
        onChange={(event) => { setText(event.target.value); setNote(null); }}
        onKeyDown={onKeyDown}
      />
      {dictation.shown && <MicButton dictation={dictation} className="terminal-input-mic" />}
      <button
        type="button"
        className="terminal-input-send"
        aria-label={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        title={t(text.length === 0 ? "Press Enter in the terminal" : "Send to the terminal")}
        disabled={!connected || sending}
        // the soft keyboard stays up for the next line
        onPointerDown={(event) => event.preventDefault()}
        onClick={onSendClick}
      >
        {text.length === 0 ? <CornerDownLeft aria-hidden="true" /> : <SendHorizontal aria-hidden="true" />}
      </button>
      {note !== null && <p className="terminal-input-note" role="alert">{note}</p>}
      {dictation.shown && <VoiceRecordingPill dictation={dictation} align="end" />}
    </div>
  );
}
