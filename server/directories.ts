import { mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { DirectoryListing } from "../shared/protocol.ts";

export function createProjectDirectory(parent: unknown, name: unknown): { path: string } | { error: string } {
  if (typeof parent !== "string" || !parent.trim()) return { error: "invalid_cwd" };
  if (typeof name !== "string" || !name.trim() || name !== name.trim() ||
      name === "." || name === ".." || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) ||
      /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
      new TextEncoder().encode(name).length > 255) return { error: "invalid_folder_name" };
  const home = homedir();
  const base = parent === "~" ? home : parent.startsWith("~/") ? resolve(home, parent.slice(2)) : resolve(parent);
  try {
    if (!statSync(base).isDirectory()) return { error: "invalid_cwd" };
    const path = join(base, name);
    // No recursive mkdir: never reuse an existing project or create missing parents.
    mkdirSync(path);
    return { path };
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException).code;
    return { error: code === "EEXIST" ? "folder_exists" : code === "ENOENT" || code === "ENOTDIR" ? "invalid_cwd" : "folder_create_failed" };
  }
}

/** A folder with more subfolders than this lists the first ones and says it stopped. */
export const MAX_DIRECTORY_ENTRIES = 500;

/**
 * The folders inside one directory, for the new-session dialog's folder browser. One
 * directory at a time, names only, nothing kept between calls: the cost is one readdir.
 * `path` takes an absolute path, `~` or `~/…` (the dialog's own syntax); empty means home.
 * Hidden folders (a leading dot) are left out unless asked for. Null when `path` is not
 * a directory this user can read.
 */
/** `base`: the folder a relative path is read from (a pane's, for a link in its chat); else the server's own. */
export function listDirectories(path: string, hidden = false, withFiles = false, base?: string): DirectoryListing | null {
  const home = homedir();
  const trimmed = path.trim();
  const target = trimmed === "" || trimmed === "~" ? home : trimmed.startsWith("~/") ? resolve(home, trimmed.slice(2)) : base !== undefined ? resolve(base, trimmed) : resolve(trimmed);
  let entries;
  try {
    if (!statSync(target).isDirectory()) return null;
    entries = readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const directories: string[] = [];
  const files: { name: string; size: number }[] = [];
  for (const entry of entries) {
    if (!hidden && entry.name.startsWith(".")) continue;
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    // a link is what it points at (a dangling or looping one is neither)
    if (entry.isSymbolicLink()) {
      try { const target_ = statSync(join(target, entry.name)); isDirectory = target_.isDirectory(); isFile = target_.isFile(); } catch { isDirectory = false; isFile = false; }
    }
    if (isDirectory) directories.push(entry.name);
    else if (withFiles && isFile && files.length <= MAX_DIRECTORY_ENTRIES) {
      let size = 0;
      try { size = statSync(join(target, entry.name)).size; } catch { continue; }
      files.push({ name: entry.name, size });
    }
  }
  const byName = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
  directories.sort(byName);
  files.sort((left, right) => byName(left.name, right.name));
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home,
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
    truncated: directories.length > MAX_DIRECTORY_ENTRIES || files.length > MAX_DIRECTORY_ENTRIES,
    ...(withFiles ? { files: files.slice(0, MAX_DIRECTORY_ENTRIES) } : {}),
  };
}
