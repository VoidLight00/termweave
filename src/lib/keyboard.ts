/*
 * Putting a phone's soft keyboard away to read the chat. iOS gives a textarea's keyboard
 * no dismiss key, so the chat offers two ways, as messaging apps do: a tap on the
 * transcript and a drag down on it. Each only blurs the field: the draft stays in the
 * composer.
 */

/** How far a finger must travel down the transcript before the keyboard goes away. */
export const DISMISS_DRAG_PX = 32;

/** lib/viewport.ts sets data-keyboard while a touch device has a text field focused. */
export function keyboardUp(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-keyboard");
}

function dismissKeyboard(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

/** A drag that reads older messages (finger moving down, mostly vertical) puts the keyboard away. */
export function dragDismisses(dx: number, dy: number): boolean {
  return dy >= DISMISS_DRAG_PX && dy > Math.abs(dx);
}

/** Taps on controls, links or text being selected do what they do; any other tap reads. */
export function tapDismisses(target: EventTarget | null, selection: string): boolean {
  if (selection.length > 0) return false;
  const element = target as Element | null;
  if (element === null || typeof element.closest !== "function") return true;
  return element.closest("a, button, input, textarea, select, summary, label, [role='button'], [contenteditable='true']") === null;
}

/** Wires the tap and the drag onto a scrolling transcript; returns the cleanup. */
export function dismissKeyboardOn(node: HTMLElement): () => void {
  let start: { x: number; y: number } | null = null;
  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    // a drag that starts on a text selection moves its handles; it is not a request to read
    const selecting = (window.getSelection()?.toString() ?? "").length > 0;
    // a field in the transcript (a prompt card's own answer) keeps its keyboard while a finger drags on it
    const onField = (event.target as Element | null)?.closest?.("input, textarea, select, [contenteditable='true']") != null;
    start = event.touches.length === 1 && touch && keyboardUp() && !selecting && !onField ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (start === null || !touch) return;
    // a long press that began a selection mid-stroke drags its handles, not the transcript
    if ((window.getSelection()?.toString() ?? "").length > 0) { start = null; return; }
    if (dragDismisses(touch.clientX - start.x, touch.clientY - start.y)) {
      start = null;
      dismissKeyboard();
    }
  };
  const onClick = (event: MouseEvent): void => {
    if (keyboardUp() && tapDismisses(event.target, window.getSelection()?.toString() ?? "")) dismissKeyboard();
  };
  node.addEventListener("touchstart", onTouchStart, { passive: true });
  node.addEventListener("touchmove", onTouchMove, { passive: true });
  node.addEventListener("click", onClick);
  return () => {
    node.removeEventListener("touchstart", onTouchStart);
    node.removeEventListener("touchmove", onTouchMove);
    node.removeEventListener("click", onClick);
  };
}
