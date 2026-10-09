/**
 * Image paste support: the browser POSTs a pasted or file-picked image, the server
 * writes it next to the pane and hands back the absolute path. The agent TUI (Claude
 * Code and friends) reads the path from the prompt text - the one image channel a pty
 * byte stream can carry; there is no clipboard or sixel hop in between.
 *
 * Files land in `<pane cwd>/.termweave/`, not /tmp, on purpose: agents ask before
 * reading outside their project directory, and a path inside the project keeps the
 * attachment visible (and git-ignorable) next to the conversation. A pane without a
 * known cwd falls back to the OS temp dir - the path still works, it just may cost
 * the agent a read-permission prompt.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, sessionSnapshot } from "./herdr/client.ts";

/** Decode ceiling: screenshots land in the 0.1-2MB range; 8MB leaves headroom. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * A file that is not one of the image types keeps its own name (sanitised), so the agent
 * reading the path sees what it is: an icon.svg, a notes.pdf, a data.csv.
 */
function storedName(name: string | undefined): { base: string; extension: string } {
  const clean = (name ?? "").normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "").slice(-80);
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 ? clean.slice(dot + 1).toLowerCase() : "";
  return {
    base: (dot > 0 ? clean.slice(0, dot) : clean) || "file",
    extension: /^[a-z0-9]{1,10}$/.test(extension) ? extension : "bin",
  };
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A validation failure the /api/pane/image route answers with this status + code. */
export class PasteImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Validates and stores one pasted image for a pane; resolves to the absolute file
 * path the prompt should reference. Validation failures are PasteImageError (the
 * route maps them to the error envelope); an unknown pane is the herdr-shaped
 * `pane_not_found` HerdrError like every other pane route.
 */
export async function savePaneImage(options: {
  paneId: string;
  contentType: string;
  dataBase64: string;
  /** the file's own name: any type is accepted, and one that is not a pasted image keeps it */
  name?: string;
}): Promise<string> {
  const imageExtension = EXTENSIONS[options.contentType];
  const named = imageExtension === undefined ? storedName(options.name) : null;
  // cheap pre-check: reject the ENCODED length before allocating the decode buffer,
  // so an oversized body never costs a second copy of itself in memory
  if (options.dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    throw new PasteImageError("image_too_large", `file exceeds ${MAX_IMAGE_BYTES} bytes`, 413);
  }
  const data = Buffer.from(options.dataBase64, "base64");
  if (data.byteLength === 0) {
    throw new PasteImageError("empty_image", "file is empty", 400);
  }
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new PasteImageError("image_too_large", `file exceeds ${MAX_IMAGE_BYTES} bytes`, 413);
  }

  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === options.paneId);
  if (!pane) throw new HerdrError("pane_not_found", `pane ${options.paneId} not found`);

  const directory = join(pane.cwd ?? join(tmpdir(), "termweave"), ".termweave");
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const unique = `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
  const name = named === null ? `paste-${unique}.${imageExtension}` : `${named.base}-${unique}.${named.extension}`;
  const path = join(directory, name);
  writeFileSync(path, data, { mode: 0o600 });
  return path;
}
