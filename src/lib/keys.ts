/**
 * Key-bar key mappings, kept free of DOM and xterm so they can be unit-tested.
 * PaneTerminal feeds the result to term.input(), which takes the same
 * onData -> socket path as typed keys.
 */

/** Keys a soft keyboard has no room for; ctrl-c is a chord, the rest are DOM key names. */
export type KeyBarKey = "Escape" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ctrl-c";

/** A single printable character: what the one-shot Control modifier consumes. */
export function isPrintable(data: string): boolean {
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/** The control code for A-Z and @ [ \ ] ^ _ (Ctrl+C = 0x03, Ctrl+[ = ESC, ...), null otherwise. */
export function controlCode(ch: string): string | null {
  if (!/^[A-Za-z@[\\\]^_]$/.test(ch)) return null;
  return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
}

/**
 * What a key-bar tap feeds xterm. Arrows follow DECCKM like a real keyboard: SS3
 * while a full-screen program has application cursor keys on, CSI otherwise.
 */
export function keySequence(key: KeyBarKey, applicationCursorKeys: boolean): string {
  const cursor = (final: "A" | "B" | "C" | "D"): string => (applicationCursorKeys ? "\u001bO" : "\u001b[") + final;
  switch (key) {
    case "Escape":
      return "\u001b";
    case "Tab":
      return "\t";
    case "ctrl-c":
      return "\u0003";
    case "ArrowUp":
      return cursor("A");
    case "ArrowDown":
      return cursor("B");
    case "ArrowRight":
      return cursor("C");
    case "ArrowLeft":
      return cursor("D");
  }
}
