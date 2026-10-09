import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ConversationPart } from "../shared/protocol.ts";

type ImagePart = Extract<ConversationPart, { kind: "image" }>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" ? value as RecordValue : {};
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const CODEX_IMAGE_REF = /^codex-[a-f0-9]{64}$/;

/** Only native user records name attachments; tool output and remote URLs never do. */
function imageValues(entry: RecordValue): string[] {
  const payload = record(entry.payload);
  if (entry.type === "event_msg" && payload.type === "user_message" && (!payload.kind || payload.kind === "plain")) {
    return [payload.local_images, payload.images].flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  }
  if (entry.type !== "response_item" || payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return [];
  return payload.content.flatMap((value) => {
    const part = record(value);
    const path = part.type === "input_image" ? part.image_url : part.type === "local_image" ? part.path : null;
    return typeof path === "string" ? [path] : [];
  });
}

function imagePart(value: string): ImagePart | null {
  if (!value || value.includes("\0") || value.length > MAX_IMAGE_BYTES * 4 / 3 + 128) return null;
  const inline = DATA_IMAGE.exec(value);
  if (!inline && /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const mediaType = inline?.[1] ?? TYPES[extname(value).toLowerCase()];
  if (!mediaType) return null;
  return { kind: "image", media_type: mediaType, ref: `codex-${createHash("sha256").update(value).digest("hex")}` };
}

/** Hash references keep base64 blobs and filesystem paths out of conversation responses. */
export function codexImageParts(entry: RecordValue): ImagePart[] {
  return [...new Set(imageValues(entry))].flatMap((value) => {
    const part = imagePart(value);
    return part === null ? [] : [part];
  });
}

function imageType(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function imageBytes(value: string, cwd: string): Promise<Buffer | null> {
  const inline = DATA_IMAGE.exec(value);
  if (inline) {
    const bytes = Buffer.from(inline[2]!, "base64");
    return bytes.length <= MAX_IMAGE_BYTES ? bytes : null;
  }
  const file = await open(resolve(cwd, value), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

/** Scan the bound history only, including inherited rollouts but excluding backtracked bytes. */
export async function codexTranscriptImage(segments: { path: string; end: number }[], ref: string, cwd: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!CODEX_IMAGE_REF.test(ref)) return null;
  for (const segment of segments) {
    if (segment.end === 0) continue;
    const stream = createReadStream(segment.path, { end: segment.end - 1, encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let entry: RecordValue;
        try { entry = record(JSON.parse(line)); } catch { continue; }
        for (const value of imageValues(entry)) {
          if (imagePart(value)?.ref !== ref) continue;
          const bytes = await imageBytes(value, cwd);
          const mediaType = bytes === null ? null : imageType(bytes);
          return bytes && mediaType ? { mediaType, bytes: new Uint8Array(bytes) } : null;
        }
      }
    } catch { return null; }
    finally { lines.close(); stream.destroy(); }
  }
  return null;
}
