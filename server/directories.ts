import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { DirectoryListing } from "../shared/protocol.ts";

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
