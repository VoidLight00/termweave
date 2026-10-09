/**
 * The terminal and chat font families the user types in Settings: a comma-separated list in
 * fallback order, like VS Code's `editor.fontFamily`. The list goes in front of the built-in
 * fonts, never in place of them, so a typo or a font missing on this device falls back as if
 * nothing had been typed.
 */

// Optional system-installed Nerd Font fallback for private-use icons. No font binary
// is bundled by TermWeave; availability and glyph support depend on this device.
const TERMINAL_SYMBOLS_FONT = '"Symbols Nerd Font Mono"';
// xterm sizes every cell from the first matching font, so a proportional one (Malgun Gothic)
// must never win it: it stays behind the generic monospace as a per-glyph Hangul fallback
const TERMINAL_TEXT_FONTS =
  '"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Cascadia Mono", Consolas, "Noto Sans Mono CJK KR", monospace, "Malgun Gothic"';
export const TERMINAL_FONT_STACK = `${TERMINAL_SYMBOLS_FONT}, ${TERMINAL_TEXT_FONTS}`;

/** the chat's own stack: --font-ui in src/styles.css */
const CHAT_FONT_STACK = "var(--font-ui)";

export const FONT_FAMILY_MAX_CHARS = 200;

/** How long a font change waits for its faces before the grid is measured with whatever loaded. */
export const FONT_LOAD_TIMEOUT_MS = 3000;

// what could close the declaration or the style element, escape, or hide in the value
const UNSAFE_CHARS = /[;{}<>\\\u0000-\u001f\u007f]/g;
const QUOTES = /["']/g;
// a name CSS reads unquoted: one identifier (non-ASCII letters included), no spaces
const IDENTIFIER = /^-?[A-Za-z_\u0080-￿][\w\u0080-￿-]*$/;
// unquoted, these are keywords rather than names and make the whole list invalid
const RESERVED = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);

function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0];
  // a stray quote inside a name would end the CSS string early: it cannot be part of a name
  const name = (quoted ? trimmed.slice(1, -1) : trimmed).replace(QUOTES, "").replace(/\s+/g, " ").trim();
  if (name === "") return "";
  // a name the user quoted stays quoted: "monospace" is a font called monospace, not the generic
  return quoted || !IDENTIFIER.test(name) || RESERVED.has(name.toLowerCase()) ? `"${name}"` : name;
}

/**
 * A typed family list as a CSS `font-family` value: composed (NFC), unsafe characters dropped,
 * each name trimmed, empty ones removed, names CSS cannot read bare quoted. Names past the length
 * limit are dropped whole, so a cut never leaves an open quote. Anything that is not a string is
 * no list at all.
 */
export function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // composed: a name copied from a macOS file name can arrive decomposed (NFD), and the browser
  // matches family names as written, so it would miss the installed font and fall back silently
  const names = value.normalize("NFC").replace(UNSAFE_CHARS, "").split(",").map(normalizeName).filter((name) => name !== "");
  let family = "";
  for (const name of names) {
    const next = family === "" ? name : `${family}, ${name}`;
    if (next.length > FONT_FAMILY_MAX_CHARS) break;
    family = next;
  }
  return family;
}

/** The xterm font stack: optional installed icon font, user list, system text fallbacks. */
export function terminalFontStack(family: string): string {
  const chosen = sanitizeFontFamily(family);
  return chosen === "" ? TERMINAL_FONT_STACK : `${TERMINAL_SYMBOLS_FONT}, ${chosen}, ${TERMINAL_TEXT_FONTS}`;
}

/** The chat body's `font-family`, or null to keep the UI font. */
export function chatFontStack(family: string): string | null {
  const chosen = sanitizeFontFamily(family);
  return chosen === "" ? null : `${chosen}, ${CHAT_FONT_STACK}`;
}

// Latin and Hangul, so a font split by unicode-range loads the faces the grid measures and shows
const FONT_LOAD_SAMPLE = "Mg가";

/**
 * Resolves once the faces of `stack` are loaded, or failed, or the timeout passed: never rejects,
 * since a font that cannot load falls back like a missing one. An installed font has no face to
 * load and resolves at once.
 */
export async function loadFontStack(stack: string, sizePx: number, timeoutMs = FONT_LOAD_TIMEOUT_MS): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts || typeof fonts.load !== "function") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fonts.load(`${sizePx}px ${stack}`, FONT_LOAD_SAMPLE),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    /* the grid is measured with the fallback, as for a font that is not installed */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
