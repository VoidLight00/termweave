/**
 * The website's stills, cut from the film's raw stills (_film/footage/stills, made by capture.ts):
 * WebP (q82) for the page with a JPEG (desktop) or PNG (phone) fallback, plus the stage grain and
 * the two logo marks. Crops are in px of the 2x stills (2880x1800 desktop, 780x1688 phone) and never
 * magnify. og.png is not made here (scripts/readme-media/banner.ts).
 *
 *   bun scripts/film/site-assets.ts [--out site/assets]
 *
 * Needs ffmpeg with libwebp. The outputs are committed; re-run after a re-capture of the stills.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "../../..");
const stills = join(root, "_film/footage/stills");
const i = process.argv.indexOf("--out");
const out = (i >= 0 ? process.argv[i + 1] : undefined) ?? join(root, "site/assets");
mkdirSync(out, { recursive: true });

function ff(...args: string[]) {
  const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args], { stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
}

// desktop: name, still, output size, optional crop (w:h:x:y of the still)
function desk(name: string, still: string, w: number, h: number, crop?: string) {
  const vf = `${crop ? `crop=${crop},` : ""}scale=${w}:${h}:flags=lanczos`;
  ff("-i", join(stills, still), "-vf", vf, "-c:v", "libwebp", "-quality", "82", "-compression_level", "6", join(out, `${name}.webp`));
  ff("-i", join(stills, still), "-vf", `${vf},format=yuvj444p`, "-q:v", "4", join(out, `${name}.jpg`));
}

// phone: native 780x1688
function phone(name: string, still: string) {
  ff("-i", join(stills, still), "-c:v", "libwebp", "-quality", "82", "-compression_level", "6", join(out, `${name}.webp`));
  ff("-i", join(stills, still), "-vf", "format=rgb24", "-compression_level", "9", join(out, `${name}.png`));
}

desk("chat-folded", "01-desktop-chat-claude.png", 1920, 1200);
desk("chat-worked-open", "02-desktop-chat-worked-open.png", 1920, 1200);
desk("chat-todo", "03-desktop-todo-open.png", 1920, 1200);
// theme/language strip: the window's top-left corner (title, sidebar, statuses), near 1:1
desk("strip-dark", "01-desktop-chat-claude.png", 920, 576, "920:576:0:0");
desk("strip-light", "10-desktop-chat-light.png", 920, 576, "920:576:0:0");
desk("strip-korean", "11-desktop-chat-korean.png", 920, 576, "920:576:0:0");
desk("prompt", "04-desktop-codex-approval.png", 1920, 1200);
desk("terminal", "07-desktop-terminal.png", 1920, 1200);
// sidebar: the host row and the five panes
desk("sidebar", "09b-sidebar-statuses-crop.png", 640, 720, "640:720:0:234");
// the chat chapter's steps below 1024px: 4:3 crops of each step's focus region
desk("chat-step-1", "01-desktop-chat-claude.png", 1200, 900, "1200:900:900:108");
desk("chat-step-2", "02-desktop-chat-worked-open.png", 1200, 900, "1200:900:900:250");
desk("chat-step-3", "02-desktop-chat-worked-open.png", 1200, 900, "1480:1110:930:660");
desk("chat-step-4", "03-desktop-todo-open.png", 1200, 900, "1680:1260:920:540");
desk("chat-step-5", "03-desktop-todo-open.png", 1200, 900, "1200:900:900:900");

phone("phone-chat", "12-phone-chat.png");
phone("phone-sessions", "13-phone-sessions-drawer.png");
phone("phone-approve", "14-phone-codex-approval.png");
phone("phone-terminal", "15b-phone-terminal-font10.png");

// stage grain: 256x256 monochrome noise, tiled at 3% on the site
ff("-f", "lavfi", "-i", "nullsrc=s=256x256,geq=random(1)*255:128:128,format=gray", "-frames:v", "1", join(out, "grain.png"));
// the logo mark in paper (for graphite) and ink, same crop and alpha as scripts/generate-brand.ts
const icon = join(root, "docs/brand/icon-source.png");
const mark = (rgb: string) => `crop=1040:1040:145:127,scale=512:512:flags=lanczos,format=rgba,geq=${rgb}:a='clip((200-r(X,Y))*2.5,0,255)'`;
ff("-i", icon, "-vf", mark("r=242:g=235:b=223"), join(out, "mark-paper.png"));
ff("-i", icon, "-vf", mark("r=22:g=18:b=13"), join(out, "mark-ink.png"));
console.log(`site assets written to ${out}`);
