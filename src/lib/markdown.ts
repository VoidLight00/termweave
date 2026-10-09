import { fileUriPath } from "./terminalFileLinks.ts";

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "math"; value: string }
  | { type: "strong" | "em" | "del"; children: InlineNode[] }
  | { type: "link"; href: string; children: InlineNode[] }
  /** a link to a local file (`[report](/repo/out/REPORT.md)`): its label opens the path */
  | { type: "file"; path: string; children: InlineNode[] };

export interface ListItem {
  content: InlineNode[];
  /** what is indented under the item's text, in order: a nested list, a table */
  blocks?: MarkdownBlock[];
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  /** an ordered list's first number: a list split by a code block goes on from where it was */
  start?: number;
  items: ListItem[];
}

export type MarkdownBlock =
  | { type: "math"; value: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; content: InlineNode[] }
  | { type: "paragraph"; lines: InlineNode[][] }
  | ListBlock
  | { type: "blockquote"; blocks: MarkdownBlock[] }
  | { type: "code"; language: string; value: string }
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "hr" };

export function safeMarkdownHref(href: string): string | null {
  const value = href.trim();
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : null;
}

/**
 * An address written without its scheme, as people and agents do: `www.example.com/x`,
 * `docs.example.com/guide`, `localhost:7317/`. A host needs a letters-only top level and,
 * past `www.`, a path to count: `README.md:3` is a file and its line, `notes.v2/x` a folder.
 * localhost and an IPv4 address are local servers, plain http, where a port is enough.
 */
export function webLikeHref(target: string): string | null {
  const value = target.trim();
  if (/^(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}:\d+|\d{1,3}(?:\.\d{1,3}){3}(?=\/))(?:\/\S*)?$/i.test(value)) return `http://${value}`;
  const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(\/\S*)?$/i.exec(value);
  if (match === null) return null;
  const [, host, path] = match;
  return /^www\./i.test(host!) || path !== undefined ? `https://${value}` : null;
}

/**
 * The file a link names, when its target is a path rather than an address: agents link
 * files they wrote (`[report](/repo/out/REPORT.md)`, `[x](src/x.ts#L12)`, `[x](x.ts:12)`).
 * A line anchor (`#L12`, `:12`) is dropped; the viewer opens the file. A line after a bare
 * word is a scheme's (`tel:123`), not a file's.
 */
export function markdownFileTarget(href: string): string | null {
  const value = href.trim();
  if (/^file:\/\/\//i.test(value)) return fileUriPath(value);
  if (value === "" || value.startsWith("#")) return null;
  const withoutAnchor = value.replace(/#.*$/, "");
  const path = withoutAnchor.replace(/(?::\d+){1,2}$/, "");
  if (path === "" || /^[a-z][a-z0-9+.-]*:/i.test(path) || (path !== withoutAnchor && !/[./]/.test(path))) return null;
  return path;
}

/** A bare URL without the punctuation that closes the sentence around it (GFM's autolink rule). */
export function trimUrl(url: string): string {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    if (last !== undefined && ".,:;!?'\"*_~".includes(last)) { end -= 1; continue; }
    // a closing parenthesis stays only while it closes one opened inside the URL
    if (last === ")") {
      const text = url.slice(0, end);
      if (text.split(")").length > text.split("(").length) { end -= 1; continue; }
    }
    break;
  }
  return url.slice(0, end);
}

/** Dependency-free inline markdown scanner. Unknown or malformed markup remains text. */
export function parseInline(source: string, links = true): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Underscores inside identifiers are literal: MAC_QA_CHAT_OK must survive
  // rendering exactly as it appears in the terminal and native transcript.
  // a bare or <angle> http(s) URL is a link too; it stops at the first non-ASCII character,
  // so `…/pull/36에서` links the address and leaves the Korean after it as text
  const marker = /(`[^`\n]+`|\\\(.+?\\\)|\[[^\]\n]+\]\([^\s)]+\)|<https?:\/\/[^\s<>]+>|file:\/\/\/[!#-;=?-_a-~]+|https?:\/\/[!-;=?-~]+|(?<![\w.@/-])www\.[!-;=?-~]+|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}\p{M}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}\p{M}_])|~~[^~\n]+~~|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_]))/gu;
  let offset = 0;
  for (const match of source.matchAll(marker)) {
    const index = match.index ?? 0;
    if (index > offset) nodes.push({ type: "text", value: source.slice(offset, index) });
    let token = match[0];
    // like an http address it stops at the first non-ASCII character (`file:///tmp/a.md에서`); a
    // name with other letters in it is percent-encoded in a URI
    if (token.startsWith("file:///")) {
      token = trimUrl(token);
      const path = fileUriPath(token);
      nodes.push(links && path !== null ? { type: "file", path, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("<")) {
      const url = token.slice(1, -1);
      nodes.push(links ? { type: "link", href: url, children: [{ type: "text", value: url }] } : { type: "text", value: token });
    } else if (/^(?:https?:|www\.)/i.test(token)) {
      // what ends a sentence is not part of the address: "see https://x.dev/a)." links x.dev/a
      token = trimUrl(token);
      const href = /^www\./i.test(token) ? `https://${token}` : token;
      nodes.push(links ? { type: "link", href, children: [{ type: "text", value: token }] } : { type: "text", value: token });
    } else if (token.startsWith("`")) {
      nodes.push({ type: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("\\(")) {
      nodes.push({ type: "math", value: token.slice(2, -2) });
    } else if (token.startsWith("[")) {
      const split = token.lastIndexOf("](");
      const label = token.slice(1, split);
      const target = token.slice(split + 2, -1);
      const href = safeMarkdownHref(target) ?? webLikeHref(target);
      const file = href === null ? markdownFileTarget(target) : null;
      nodes.push(href !== null ? { type: "link", href, children: parseInline(label, false) }
        : file !== null ? { type: "file", path: file, children: parseInline(label, false) }
        : { type: "text", value: label });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push({ type: "strong", children: parseInline(token.slice(2, -2), links) });
    } else if (token.startsWith("~~")) {
      nodes.push({ type: "del", children: parseInline(token.slice(2, -2), links) });
    } else {
      nodes.push({ type: "em", children: parseInline(token.slice(1, -1), links) });
    }
    offset = index + token.length;
  }
  if (offset < source.length) nodes.push({ type: "text", value: source.slice(offset) });
  return nodes;
}

const listLine = /^(\s*)([-*]|\d+\.)\s+(.+)$/;
const tableSeparator = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}
function lineAt(lines: string[], index: number): string {
  return lines[index] ?? "";
}
function startsTable(lines: string[], index: number): boolean {
  return lineAt(lines, index).includes("|") && tableSeparator.test(lineAt(lines, index + 1));
}
/** A table in a list item (`within` > 0) ends at a line outside the item or at the next item. */
function parseTable(lines: string[], start: number, within = 0): { block: MarkdownBlock; next: number } {
  const header = cells(lineAt(lines, start)).map((cell) => parseInline(cell));
  let index = start + 2;
  const rows: InlineNode[][][] = [];
  const inItem = (line: string): boolean => within === 0 || ((/^\s*/.exec(line)?.[0].length ?? 0) >= within && !listLine.test(line));
  while (index < lines.length && lineAt(lines, index).includes("|") && lineAt(lines, index).trim() !== "" && inItem(lineAt(lines, index))) {
    rows.push(cells(lineAt(lines, index)).map((cell) => parseInline(cell)));
    index += 1;
  }
  return { block: { type: "table", header, rows }, next: index };
}


function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return /^\s*\\\[/.test(line) || /^\s{0,3}```/.test(line) || /^#{1,6}\s+/.test(line) || /^\s*>/.test(line) || /^(?:\s*[-*_]){3,}\s*$/.test(line) || listLine.test(line)
    || startsTable(lines, index);
}

function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = listLine.exec(lineAt(lines, start));
  if (first === null) return { block: { type: "list", ordered: false, items: [] }, next: start + 1 };
  const baseIndent = (first[1] ?? "").length;
  const ordered = /\d/.test(first[2] ?? "");
  const number = ordered ? Number.parseInt(first[2] ?? "1", 10) : 1;
  const block: ListBlock = { type: "list", ordered, ...(ordered && number !== 1 ? { start: number } : {}), items: [] };
  let index = start;
  while (index < lines.length) {
    // between items: blank lines (a loose list, as agents often write one) and an item's own
    // indented lines, which read on as its text, or make a table in it; anything else ends
    // the list, and so does an indented fence, which shows as its own block
    if (block.items.length > 0 && !listLine.test(lineAt(lines, index))) {
      let ahead = index;
      while (ahead < lines.length && lineAt(lines, ahead).trim() === "") ahead += 1;
      const line = lineAt(lines, ahead);
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      const sibling = listLine.exec(line);
      if (sibling !== null && (sibling[1] ?? "").length === baseIndent && /\d/.test(sibling[2] ?? "") === ordered) { index = ahead; continue; }
      // a list indented under the last item after a blank line (or after its table) nests in it
      if (sibling !== null && (sibling[1] ?? "").length >= baseIndent + 2) { index = ahead; continue; }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && startsTable(lines, ahead)) {
        const item = block.items.at(-1)!;
        const table = parseTable(lines, ahead, baseIndent + 2);
        (item.blocks ??= []).push(table.block);
        index = table.next;
        continue;
      }
      if (ahead < lines.length && sibling === null && indent >= baseIndent + 2 && !/^\s*```/.test(line)) {
        const item = block.items.at(-1)!;
        const last = item.blocks?.at(-1);
        if (last === undefined) {
          item.content = [...item.content, { type: "text", value: " " }, ...parseInline(line.trim())];
        } else {
          // after a table or nested list the item's text goes on below it; a quote or rule
          // there ends the list and shows as its own block, as it did before tables nested
          if (startsBlock(lines, ahead)) break;
          if (last.type === "paragraph" && ahead === index) last.lines.push(parseInline(line.trim()));
          else item.blocks!.push({ type: "paragraph", lines: [parseInline(line.trim())] });
        }
        index = ahead + 1;
        continue;
      }
      break;
    }
    const match = listLine.exec(lineAt(lines, index));
    if (match === null || (match[1] ?? "").length < baseIndent) break;
    if ((match[1] ?? "").length >= baseIndent + 2) {
      const parent = block.items.at(-1);
      if (parent === undefined) break;
      const nested = parseList(lines, index);
      (parent.blocks ??= []).push(nested.block);
      index = nested.next;
      continue;
    }
    if ((match[1] ?? "").length !== baseIndent || /\d/.test(match[2] ?? "") !== ordered) break;
    block.items.push({ content: parseInline(match[3] ?? "") });
    index += 1;
  }
  return { block, next: index };
}

/** Code blocks longer than this open folded to their first FOLDED_CODE_LINES lines. */
export const FOLD_CODE_AFTER_LINES = 30;
export const FOLDED_CODE_LINES = 20;

/** The folded head of a long code block and its full line count; null when it shows whole. */
export function foldCode(value: string): { head: string; lines: number } | null {
  const lines = value.split("\n");
  if (lines.length <= FOLD_CODE_AFTER_LINES) return null;
  return { head: lines.slice(0, FOLDED_CODE_LINES).join("\n"), lines: lines.length };
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lineAt(lines, index);
    if (line.trim() === "") { index += 1; continue; }

    // a fence may be indented (inside a list item, as agents write them): its lines lose that indent
    const fence = /^( {0,3})```\s*([^\s`]*)/.exec(line);
    if (fence !== null) {
      const indent = fence[1] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lineAt(lines, index))) {
        const bodyLine = lineAt(lines, index++);
        body.push(bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine.trimStart());
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[2] ?? "", value: body.join("\n") });
      continue;
    }

    const display = /^\s*\\\[(.*)$/.exec(line);
    if (display !== null) {
      const body: string[] = [];
      let next = index;
      let part = display[1] ?? "";
      let complete = false;
      while (true) {
        const close = part.indexOf("\\]");
        if (close !== -1 && part.slice(close + 2).trim() === "") {
          body.push(part.slice(0, close));
          blocks.push({ type: "math", value: body.join("\n").trim() });
          index = next + 1;
          complete = true;
          break;
        }
        body.push(part);
        next += 1;
        if (next >= lines.length || /^\s{0,3}```/.test(lineAt(lines, next))) break;
        part = lineAt(lines, next);
      }
      // An incomplete formula stays prose; later headings and fences still parse normally.
      if (complete) continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6, content: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    if (/^(?:\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lineAt(lines, index))) quoted.push(lineAt(lines, index++).replace(/^\s*>\s?/, ""));
      blocks.push({ type: "blockquote", blocks: parseMarkdown(quoted.join("\n")) });
      continue;
    }

    if (listLine.test(line)) {
      const parsed = parseList(lines, index);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    if (startsTable(lines, index)) {
      const table = parseTable(lines, index);
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    const paragraph: InlineNode[][] = [];
    while (index < lines.length && lineAt(lines, index).trim() !== "" && (paragraph.length === 0 || !startsBlock(lines, index))) {
      paragraph.push(parseInline(lineAt(lines, index)));
      index += 1;
    }
    blocks.push({ type: "paragraph", lines: paragraph });
  }
  return blocks;
}
