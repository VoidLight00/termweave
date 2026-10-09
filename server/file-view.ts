import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

import type { FileInfo, FileKind } from "../shared/protocol.ts";
import { filesNamed } from "./files.ts";

/**
 * Opening a file from the browser: the files agents write (a screenshot, a demo video, a
 * PDF, a log) seen on a phone that has no terminal to open them with.
 *
 * Nothing is read into memory to serve a file: the response is `Bun.file`, which Bun
 * streams from disk (sendfile where it can) and answers Range requests for, so a video
 * plays and seeks without the server holding more than its socket buffers. Only the
 * first bytes of a file are read, to tell text from binary.
 *
 * It opens what this server's user can read, which is no more than the terminal the same
 * browser can already type into.
 */

/** A path as agents and people write it: absolute, `~/…`, or relative to the pane's folder. */
export function resolveFilePath(input: string, cwd: string | null): string | null {
  const path = input.trim();
  if (path === "") return null;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return cwd === null ? null : resolve(cwd, path);
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|typescript|xml|x-sh|toml|yaml|x-yaml|sql)|image\/svg\+xml)/;
const SNIFF_BYTES = 8192;

function kindOf(mime: string, path: string): FileKind {
  if (mime === "image/svg+xml") return "image";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (TEXT_TYPES.test(mime)) return "text";
  // no known type (a .log, a dotfile, source without a registered extension): text when
  // its first bytes hold no NUL
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0) ? "binary" : "text";
  } catch {
    return "binary";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * The file a path means: as written, or — for a relative path that is not there — the one
 * file under the pane's folder whose path ends in it (agents often name `demo.mp4` without
 * `docs/screenshots/`). Several such files come back as candidates to choose from.
 */
export function locateFile(input: string, cwd: string | null): { info: FileInfo } | { candidates: string[] } | null {
  const path = resolveFilePath(input, cwd);
  const info = path === null ? null : fileInfo(path);
  if (info !== null) return { info };
  const relative = input.trim();
  if (cwd === null || relative === "" || isAbsolute(relative) || relative.startsWith("~") || relative.startsWith("../")) return null;
  const found = filesNamed(cwd, relative).map((match) => resolve(cwd, match));
  if (found.length === 1) {
    const only = fileInfo(found[0]!);
    return only === null ? null : { info: only };
  }
  return found.length > 1 ? { candidates: found } : null;
}

/** What the viewer needs to know about a file, or null when it is not a readable file. */
export function fileInfo(path: string): FileInfo | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mime = Bun.file(path).type.split(";")[0] || "application/octet-stream";
  return { path, name: basename(path), size: stat.size, modified: stat.mtime.toISOString(), mime, kind: kindOf(mime, path) };
}

/**
 * The file itself. `download` asks the browser to save it. Answers are sandboxed (an HTML
 * or SVG file opened from this origin must not run script with the app's access), and
 * text is served as plain text whatever its extension says it runs as.
 */
export function fileResponse(info: FileInfo, download: boolean): Response {
  const name = encodeURIComponent(info.name);
  const headers = new Headers({
    "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  // a PDF is drawn by the browser's own viewer, which refuses a sandboxed document; its
  // scripts stay inside that viewer, never on this origin
  if (info.kind !== "pdf") headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  // text shows as text, whatever its extension says it runs as
  const type = info.kind === "text" && info.mime !== "image/svg+xml" ? "text/plain; charset=utf-8" : info.mime;
  const file = Bun.file(info.path, { type });
  return new Response(file, { headers });
}
