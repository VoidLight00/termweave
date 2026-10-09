/**
 * The disconnected-input draft: while the socket is down, typed text is held for the
 * user to review and send after reconnect instead of being queued and fired blindly.
 * Pure logic, DOM-free, so the policy is unit-testable (see draft.test.ts).
 */

export interface InputDraft {
  readonly text: string;
  /** special keys (Enter, arrows, ^C, ...) received while disconnected - undraftable, counted */
  readonly droppedSpecial: number;
}

export const EMPTY_DRAFT: InputDraft = { text: "", droppedSpecial: 0 };

const MAX_DRAFT_CHARS = 1024;

/** An IME commit can contain several code points. Never preserve terminal control sequences. */
function isPrintableChar(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(data);
}

/** Folds one onData chunk into the draft: printable text accumulates, special keys count. */
export function applyToDraft(draft: InputDraft, data: string): InputDraft {
  if (!isPrintableChar(data)) {
    // Enter, arrows and bracketed paste frames contain controls; keep only plain text.
    return { ...draft, droppedSpecial: draft.droppedSpecial + 1 };
  }
  if (draft.text.length + data.length > MAX_DRAFT_CHARS) {
    return { ...draft, droppedSpecial: draft.droppedSpecial + 1 };
  }
  return { ...draft, text: draft.text + data };
}

export function draftIsEmpty(draft: InputDraft): boolean {
  return draft.text.length === 0 && draft.droppedSpecial === 0;
}
