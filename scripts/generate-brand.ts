/** Export the supplied artwork without redrawing it. Requires ffmpeg with drawtext. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const source = join(root, "docs/brand/icon-source.png");
mkdirSync(join(root, "public/icons"), { recursive: true });

function exportImage(path: string, filter: string, extra: string[] = []): void {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", source,
    "-vf", filter, "-frames:v", "1", "-threads", "1", ...extra, join(root, path),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not export ${path}`);
  console.log(path);
}

for (const size of [192, 512]) {
  exportImage(`public/icons/icon-${size}.png`, `scale=${size}:${size}:flags=lanczos`);
  const inset = Math.round(size * 0.76);
  exportImage(`public/icons/icon-maskable-${size}.png`,
    `scale=${inset}:${inset}:flags=lanczos,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0xd7d8d8`);
}
// Android draws a notification's small icon from its alpha alone: the dark artwork becomes
// white on transparent, cropped to the mark. Without it Chrome shows its own bell.
exportImage("public/icons/badge-96.png",
  "crop=1040:1040:145:127,scale=96:96:flags=lanczos,format=rgba,geq=r=255:g=255:b=255:a='clip((200-r(X,Y))*2.5,0,255)'");
exportImage("public/apple-touch-icon.png", "scale=180:180:flags=lanczos");
exportImage("public/favicon.png", "scale=64:64:flags=lanczos");
exportImage("public/favicon.ico", "scale=32:32:flags=lanczos", ["-c:v", "bmp"]);
exportImage("public/social-preview.png", [
  "scale=640:640:flags=lanczos",
  "pad=1280:640:0:0:color=0xd7d8d8",
  "drawtext=font=DejaVu Sans:fontcolor=0x2c3133:fontsize=76:text='herdr web ui':x=660:y=218",
  "drawtext=font=DejaVu Sans:fontcolor=0x454c50:fontsize=28:text='Your agents. Any screen.':x=664:y=330",
  "drawtext=font=DejaVu Sans:fontcolor=0x454c50:fontsize=20:text='CHAT  /  TERMINAL  /  MOBILE':x=666:y=410",
].join(","));
