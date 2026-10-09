/**
 * The film's recorder: every frame Chrome paints (CDP screencast) with its paint time, plus a log
 * of what the "hand" did (pointer moves, clicks, taps) for the compositor to draw the cursor.
 * Same Recording shape as scripts/readme-media/record.ts (which stays the README's own), with what
 * the film takes need on top of it:
 * - `scale`: the browser's device scale factor (the screencast's px per CSS px), not a fixed 2;
 * - a clock-driven glide: a slow mouse.move on a busy page cannot stretch it past `ms`;
 * - `place` (the pointer set down at once, e.g. parked outside the viewport before `begin`) and
 *   `press` (a click where the pointer already is, so a take can glide first and click on its beat).
 */
import type { CDPSession, Page } from "playwright-core";

export interface Frame { t: number; jpeg: Buffer }
export type Cue =
  | { t: number; kind: "move"; x: number; y: number }
  | { t: number; kind: "down" | "up"; x: number; y: number }
  | { t: number; kind: "tap"; x: number; y: number };

export interface Recording { frames: Frame[]; cues: Cue[]; start: number; end: number; width: number; height: number }

const now = (): number => Date.now() / 1000;
const ease = (s: number): number => (s < 0.5 ? 4 * s * s * s : 1 - (-2 * s + 2) ** 3 / 2);

export class Hand {
  private readonly frames: Frame[] = [];
  private readonly cues: Cue[] = [];
  private cdp: CDPSession | null = null;
  private start = 0;
  private x: number;
  private y: number;

  constructor(private readonly page: Page, private readonly width: number, private readonly height: number, private readonly scale = 2) {
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
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: this.width * this.scale, maxHeight: this.height * this.scale });
    this.cues.push({ t: this.start, kind: "move", x: this.x, y: this.y });
  }

  async end(): Promise<Recording> {
    await this.cdp?.send("Page.stopScreencast").catch(() => undefined);
    return { frames: this.frames, cues: this.cues, start: this.start, end: now(), width: this.width, height: this.height };
  }

  /** Puts the pointer at (x, y) at once, no glide. */
  async place(x: number, y: number): Promise<void> {
    this.x = x;
    this.y = y;
    await this.page.mouse.move(x, y);
    if (this.cdp) this.cues.push({ t: now(), kind: "move", x, y });
  }

  /** The pointer glides to (x, y) on an eased path, as a hand would, in `ms` of wall time. */
  async moveTo(x: number, y: number, ms = 650): Promise<void> {
    const [fromX, fromY] = [this.x, this.y];
    const t0 = performance.now();
    for (;;) {
      const done = Math.min(1, (performance.now() - t0) / ms);
      const s = ease(done);
      this.x = fromX + (x - fromX) * s;
      this.y = fromY + (y - fromY) * s;
      await this.page.mouse.move(this.x, this.y);
      this.cues.push({ t: now(), kind: "move", x: this.x, y: this.y });
      if (done >= 1) break;
      await Bun.sleep(16);
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
    await this.press();
  }

  /** A click where the pointer already is. */
  async press(): Promise<void> {
    this.cues.push({ t: now(), kind: "down", x: this.x, y: this.y });
    await this.page.mouse.down();
    await Bun.sleep(90);
    await this.page.mouse.up();
    this.cues.push({ t: now(), kind: "up", x: this.x, y: this.y });
  }

  async tap(selector: string): Promise<void> {
    const { x, y } = await this.center(selector);
    this.cues.push({ t: now(), kind: "tap", x, y });
    await this.page.locator(selector).first().tap();
  }
}
