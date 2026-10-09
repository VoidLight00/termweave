/**
 * Records a page for the README media: every frame Chrome paints, at 2x (the browser runs
 * with --force-device-scale-factor=2, or headless screencasts come at 1x), with the time
 * it was painted, plus a log of what the "hand" did — pointer moves, clicks, taps, drags
 * and camera cues — for compose.ts to draw the cursor and move the camera afterwards.
 */
import type { CDPSession, Page } from "playwright-core";

export interface Frame { t: number; jpeg: Buffer }
export type Cue =
  | { t: number; kind: "move"; x: number; y: number }
  | { t: number; kind: "down" | "up"; x: number; y: number }
  | { t: number; kind: "tap"; x: number; y: number }
  | { t: number; kind: "camera"; zoom: number; x: number; y: number };

export interface Recording { frames: Frame[]; cues: Cue[]; start: number; end: number; width: number; height: number }

const now = (): number => Date.now() / 1000;
const ease = (s: number): number => (s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2);

export class Recorder {
  private readonly frames: Frame[] = [];
  private readonly cues: Cue[] = [];
  private cdp: CDPSession | null = null;
  private start = 0;
  private x: number;
  private y: number;

  constructor(private readonly page: Page, private readonly width: number, private readonly height: number) {
    this.x = width * 0.62;
    this.y = height * 0.6;
  }

  async begin(): Promise<void> {
    const cdp = await this.page.context().newCDPSession(this.page);
    this.cdp = cdp;
    cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      this.frames.push({ t: frame.metadata.timestamp ?? now(), jpeg: Buffer.from(frame.data, "base64") });
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
    });
    this.start = now();
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: this.width * 2, maxHeight: this.height * 2 });
    this.cues.push({ t: this.start, kind: "move", x: this.x, y: this.y });
  }

  async end(): Promise<Recording> {
    await this.cdp?.send("Page.stopScreencast").catch(() => undefined);
    return { frames: this.frames, cues: this.cues, start: this.start, end: now(), width: this.width, height: this.height };
  }

  /** The pointer glides to (x, y) on an eased path, as a hand would. */
  async moveTo(x: number, y: number, ms = 650): Promise<void> {
    const steps = Math.max(8, Math.round(ms / 16));
    const [fromX, fromY] = [this.x, this.y];
    for (let i = 1; i <= steps; i++) {
      const s = ease(i / steps);
      this.x = fromX + (x - fromX) * s;
      this.y = fromY + (y - fromY) * s;
      await this.page.mouse.move(this.x, this.y);
      this.cues.push({ t: now(), kind: "move", x: this.x, y: this.y });
      await Bun.sleep(ms / steps);
    }
  }

  async center(selector: string): Promise<{ x: number; y: number }> {
    const box = (await this.page.locator(selector).first().boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async click(selector: string): Promise<void> {
    const { x, y } = await this.center(selector);
    await this.moveTo(x, y);
    await Bun.sleep(120);
    this.cues.push({ t: now(), kind: "down", x, y });
    await this.page.mouse.down();
    await Bun.sleep(90);
    await this.page.mouse.up();
    this.cues.push({ t: now(), kind: "up", x, y });
  }

  async tap(selector: string): Promise<void> {
    const { x, y } = await this.center(selector);
    this.cues.push({ t: now(), kind: "tap", x, y });
    await this.page.locator(selector).first().tap();
  }

  /** A one-finger drag, drawn as a touch that follows the finger. */
  async drag(x: number, fromY: number, toY: number, ms = 450): Promise<void> {
    const cdp = this.cdp!;
    const steps = Math.round(ms / 25);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
    this.cues.push({ t: now(), kind: "tap", x, y: fromY });
    for (let i = 1; i <= steps; i++) {
      const y = fromY + (toY - fromY) * ease(i / steps);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      this.cues.push({ t: now(), kind: "tap", x, y });
      await Bun.sleep(25);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /** The camera eases to `zoom` around (x, y); zoom 1 is the whole window. */
  camera(zoom: number, x = this.width / 2, y = this.height / 2): void {
    this.cues.push({ t: now(), kind: "camera", zoom, x, y });
  }
}
