import type { IBuffer, ILink, ILinkProvider } from "@xterm/xterm";

/** what a name is made of: letters, digits and the marks that complete them (a decomposed `é` is two) */
const NAME = "\\p{L}\\p{N}\\p{M}_";
/**
 * A path, optionally followed by an agent's line/column reference. Only a path with a folder in
 * it becomes a link (see below): a terminal is full of bare names (`ls`, `git status`, a
 * compiler's output), a tap or a click to focus the pane lands on one, and the file viewer
 * would open over the terminal for it. A chat's plain text is read the same way (BARE_PATH in
 * filePaths.ts).
 */
const FILE_PATH = new RegExp(`(?<![${NAME}/.@~:-])((?:~\\/|\\.{1,2}\\/|\\/)?(?:[${NAME}@.+-]+\\/)*[${NAME}@+-][${NAME}@.+-]*\\.[A-Za-z0-9]{1,8})(?::\\d+(?::\\d+)?)?(?![${NAME}/])`, "gu");
/** `name.ext(` is a call, not a file, unless the parenthesis holds a compiler's line and column: `App.tsx(120,8)` */
const CALL = /\s*\((?!\d+(?:,\d+)?\))/y;
const FILE_URI = /file:\/\/\/[^\s<>"`]+/gi;
/** A logical line longer than this is not prose with paths in it (a minified bundle, a blob): it is left alone. */
const MAX_LINE_CHARS = 8192;

/** Local file URIs are read by the existing server-side file viewer. */
export function fileUriPath(uri: string): string | null {
  // a control character belongs to no path, and URL drops a trailing one before it can be seen
  if (!/^file:\/\/\//i.test(uri) || /[\u0000-\u001f\u007f]/.test(uri)) return null;
  try {
    const url = new URL(uri);
    if (url.host || url.search || url.hash) return null;
    const path = decodeURIComponent(url.pathname);
    // two separators in front name a network share on a Windows PC, however the second was written
    if (/[\u0000-\u001f\u007f]/.test(path) || /^[\\/]{2}/.test(path)) return null;
    // `/C:/Users/me/a.md` is how a URI writes a Windows drive path // leakscan:allow: test fixture
    return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
  } catch {
    return null; // malformed URI input is not a file link
  }
}

interface LogicalLine {
  text: string;
  /** the cell each UTF-16 unit of `text` sits in (1-based, as xterm's link ranges are) and its width */
  positions: { x: number; y: number; width: number }[];
  /** the line's beginning scrolled off the top: its first word is the end of something longer */
  clipped: boolean;
}

/** The whole wrapped line that buffer row `lineNumber` (1-based) is part of. */
function logicalLine(buffer: IBuffer, lineNumber: number): LogicalLine | null {
  let first = lineNumber - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let text = "";
  const positions: LogicalLine["positions"] = [];
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line || (y > first && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      if (x === line.length - 1 && !cell.getChars() && buffer.getLine(y + 1)?.isWrapped
        && buffer.getLine(y + 1)?.getCell(0)?.getWidth() === 2) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) positions.push({ x: x + 1, y: y + 1, width: cell.getWidth() });
    }
    if (text.length > MAX_LINE_CHARS) return null;
  }
  return { text, positions, clipped: buffer.getLine(first)?.isWrapped === true };
}

/** The runs of `text` that hold `://`, each from the whitespace before to the whitespace after: one pass. */
function addresses(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let end = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", end)) {
    let start = at;
    while (start > end && !/\s/.test(text[start - 1]!)) start--;
    end = at + 3;
    while (end < text.length && !/\s/.test(text[end]!)) end++;
    spans.push([start, end]);
  }
  return spans;
}

type FileLink = Omit<ILink, "activate"> & { activate: (event: MouseEvent) => void };

export function terminalFileLinks(buffer: IBuffer, lineNumber: number, open: (path: string, event: MouseEvent) => void): FileLink[] {
  const line = logicalLine(buffer, lineNumber);
  if (line === null) return [];
  const { text, positions } = line;
  // the first word of a line whose beginning is gone would open as a path of its own: `hijk/App.tsx`
  const firstGap = text.search(/\s/);
  const lead = !line.clipped ? 0 : firstGap === -1 ? text.length : firstGap;
  const links: FileLink[] = [];
  const link = (index: number, shown: string, path: string): void => {
    const start = positions[index];
    const last = positions[index + shown.length - 1];
    if (!start || !last || index < lead || lineNumber < start.y || lineNumber > last.y) return;
    links.push({
      // a wide character's last cell is the link's end, not its first
      range: { start: { x: start.x, y: start.y }, end: { x: last.x + last.width - 1, y: last.y } },
      text: shown,
      // xterm keeps a row's links until the pointer leaves the row: the row is read again at the
      // click, and it opens only if the same whole link is still there (`foo.ts` grown to `foo.tsx` is not)
      activate: (event) => {
        const same = terminalFileLinks(buffer, lineNumber, () => {}).some((now) => now.text === shown
          && now.range.start.x === start.x && now.range.start.y === start.y
          && now.range.end.x === last.x + last.width - 1 && now.range.end.y === last.y);
        if (same) open(path, event);
      },
    });
  };
  for (const match of text.matchAll(FILE_URI)) {
    const uri = match[0].replace(/[),.;:!?']+$/, "");
    const path = fileUriPath(uri);
    // Plain screen snapshots can lose soft-wrap metadata. Do not navigate a
    // truncated parent URI at a full-width hard boundary followed by a path tail.
    const end=positions[match.index+uri.length-1];
    const next=end ? buffer.getLine(end.y) : undefined;
    const ambiguous=end && end.x===buffer.getLine(end.y-1)?.length && next && !next.isWrapped && /^\//.test(next.translateToString(true));
    if (path && !ambiguous) link(match.index, uri, path);
  }
  // Web addresses belong to WebLinksAddon, and a file URI was read above.
  const spans = addresses(text);
  let span = 0;
  for (const match of text.matchAll(FILE_PATH)) {
    const path = match[1];
    if (!path || !path.includes("/") || !/\p{L}/u.test(path.replace(/\.[A-Za-z0-9]{1,8}$/, ""))) continue;
    if (/^v?\d+(?:\.\d+)+$/.test(path)) continue;
    CALL.lastIndex = match.index + match[0].length;
    if (CALL.test(text)) continue;
    while (span < spans.length && spans[span]![1] <= match.index) span++;
    if (span < spans.length && spans[span]![0] <= match.index) continue;
    link(match.index, match[0], path);
  }
  return links;
}

export function terminalFileLinkProvider(buffer: () => IBuffer, open: (path: string, event: MouseEvent) => void): ILinkProvider {
  return { provideLinks: (line, callback) => callback(terminalFileLinks(buffer(), line, open)) };
}
