import { expect, it } from "bun:test";
import { HerdrError } from "./herdr/client.ts";
import { MirrorSession, mirrorFrame, mirrorRows } from "./mirror.ts";

/** A pane whose every read waits until the test answers it. */
function pane(extra: Partial<ConstructorParameters<typeof MirrorSession>[0]> = {}) {
  const asked: { resolve(screen: string): void; reject(error: unknown): void }[] = [];
  let wake: (() => void) | null = null;
  const frames: string[] = [];
  const exits: (number | null)[] = [];
  const written: string[] = [];
  const session = new MirrorSession({
    read: () => new Promise<string>((resolve, reject) => { asked.push({ resolve, reject }); wake?.(); }),
    write: async (data) => { written.push(data); },
    onData: (frame) => frames.push(frame),
    onExit: (code) => exits.push(code),
    cols: 80,
    rows: 24,
    activeMs: 0,
    idleMs: 0,
    // every screen whole unless a test asks for rows
    wholeMs: 0,
    quietMs: 0,
    ...extra,
  });
  /** the nth read, once the mirror asks for it */
  const read = async (n: number) => {
    while (asked.length < n) await Promise.race([
      new Promise<void>((resolve) => { wake = resolve; }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`read ${n} never asked`)), 2000)),
    ]);
    return asked[n - 1]!;
  };
  return { session, read, asked, frames, exits, written };
}

it("paints a screen as home, clear and rows with line wrap off, without a newline after the last row", () => {
  expect(mirrorFrame("a\nb\r\n\r\n")).toBe("\x1b[?25l\x1b[0m\x1b[H\x1b[2J\x1b[?7la\r\nb\x1b[0m\x1b[?7h");
  // a read longer than the grid: its last rows are the screen
  expect(mirrorFrame("1\n2\n3", 2)).toBe("\x1b[?25l\x1b[0m\x1b[H\x1b[2J\x1b[?7l2\r\n3\x1b[0m\x1b[?7h");
});

it("draws the rows that changed, each cleared in its place with line wrap off, and the last row last", () => {
  const head = "\x1b[?25l\x1b[?7l";
  const tail = "\x1b[0m\x1b[?7h";
  const at = (row: number, text: string) => `\x1b[${row};1H\x1b[0m\x1b[2K${text}`;
  // the last row is drawn again each time, so the cursor ends where a whole frame leaves it
  expect(mirrorRows("a\r\nb\r\nc", "a\r\nB\r\nc", 24)).toBe(head + at(2, "B") + at(3, "c") + tail);
  expect(mirrorRows("a\r\nb\r\nc", "a\r\nb\r\nC", 24)).toBe(head + at(3, "C") + tail);
  // a row that is gone is cleared, one that is new is drawn; trailing newlines are no rows
  expect(mirrorRows("a\nb\nc\n", "a\n", 24)).toBe(head + at(2, "") + at(3, "") + at(1, "a") + tail);
  expect(mirrorRows("a", "a\nb", 24)).toBe(head + at(2, "b") + tail);
  // a read longer than the grid: the rows on the screen are its last ones, counted from the top of the grid
  expect(mirrorRows("1\n2\n3\n4", "1\n2\n3\nX", 2)).toBe(head + at(2, "X") + tail);
  expect(mirrorRows("1\n2\n3", "1\n2\n3\n4", 2)).toBe(head + at(1, "3") + at(2, "4") + tail);
});

it("sends the whole screen first and after a while, and the changed rows in between", async () => {
  let now = 1_000_000;
  const clock = Date.now;
  Date.now = () => now;
  try {
    const { session, read, frames } = pane({ wholeMs: 10_000 });
    const screen = (spinner: string) => ["first row of the screen", "second row of the screen", `working ${spinner}`, "last row of the screen"].join("\r\n");
    (await read(1)).resolve(screen("|"));
    (await read(2)).resolve(screen("/"));
    await read(3);
    now += 10_000;
    (await read(3)).resolve(screen("-"));
    await read(4);
    expect(frames).toEqual([mirrorFrame(screen("|")), mirrorRows(screen("|"), screen("/"), 24), mirrorFrame(screen("-"))]);
    expect(frames[1]).toBe("\x1b[?25l\x1b[?7l\x1b[3;1H\x1b[0m\x1b[2Kworking /\x1b[4;1H\x1b[0m\x1b[2Klast row of the screen\x1b[0m\x1b[?7h");
    // a client joining late gets the screen whole, whatever went out last
    expect(session.current).toBe(mirrorFrame(screen("-")));
    session.kill();
  } finally { Date.now = clock; }
});

it("sends the screen whole once more when it goes quiet after rows", async () => {
  const { session, read, frames } = pane({ wholeMs: 60_000 });
  const screen = (spinner: string) => ["first row of the screen", "second row of the screen", `working ${spinner}`, "last row of the screen"].join("\r\n");
  (await read(1)).resolve(screen("|"));
  (await read(2)).resolve(screen("/"));
  // unchanged: the changes have stopped, and whatever a client's screen holds is whole again
  (await read(3)).resolve(screen("/"));
  (await read(4)).resolve(screen("/"));
  await read(5);
  expect(frames).toEqual([mirrorFrame(screen("|"), 24), mirrorRows(screen("|"), screen("/"), 24), mirrorFrame(screen("/"), 24)]);
  session.kill();
});

it("goes whole a second after the last change, also while keys that change nothing keep the reads coming", async () => {
  let now = 1_000_000;
  const clock = Date.now;
  Date.now = () => now;
  try {
    const { session, read, frames } = pane({ wholeMs: 60_000, quietMs: 1000, activeMs: 60_000, idleMs: 60_000, echoMs: 0 });
    const screen = (spinner: string) => ["first row of the screen", "second row of the screen", `working ${spinner}`, "last row of the screen"].join("\r\n");
    (await read(1)).resolve(screen("|"));
    session.poke();
    (await read(2)).resolve(screen("/"));
    // keys the program ignores: each brings a read, none a change
    for (let n = 3; n <= 5; n++) {
      session.poke();
      const next = await read(n);
      now += 400;
      next.resolve(screen("/"));
    }
    session.poke();
    await read(6);
    expect(frames).toEqual([mirrorFrame(screen("|"), 24), mirrorRows(screen("|"), screen("/"), 24), mirrorFrame(screen("/"), 24)]);
    session.kill();
  } finally { Date.now = clock; }
});

it("waits for a read on the new grid after a resize, even when a paused viewer resumes first", async () => {
  let size = { cols: 20, rows: 6 };
  const { session, read, frames } = pane({ size: async () => size, sizeMs: 0, wholeMs: 60_000, cols: 20, rows: 6 });
  (await read(1)).resolve("abcdefghijklmnopqrst\r\nrow two");
  await read(2);
  session.pause();
  size = { cols: 10, rows: 6 };
  (await read(2)).resolve("abcdefghijklmnopqrst\r\nrow two");
  // the resize is seen at the next read; the viewer resumes while that read is on its way
  const third = await read(3);
  session.resume();
  expect(frames).toHaveLength(1);
  third.resolve("ABCDEFGHIJ\r\nrow two");
  await read(4);
  expect(frames).toEqual([mirrorFrame("abcdefghijklmnopqrst\r\nrow two"), mirrorFrame("ABCDEFGHIJ\r\nrow two")]);
  session.kill();
});

it("does not put the echo read off while keys keep coming", async () => {
  const { session, read, asked } = pane({ idleMs: 60_000, activeMs: 60_000, echoMs: 25 });
  (await read(1)).resolve("$ ");
  await new Promise((resolve) => setTimeout(resolve, 5));
  // a key every 10 ms: the read due 25 ms after the first one still happens
  const typing = setInterval(() => session.poke(), 10);
  try { await read(2); } finally { clearInterval(typing); }
  expect(asked.length).toBe(2);
  session.kill();
});

it("sends the whole screen when the changed rows would be longer, as when output scrolls", async () => {
  const { session, read, frames } = pane({ wholeMs: 60_000 });
  const before = Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\r\n");
  const scrolled = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join("\r\n");
  (await read(1)).resolve(before);
  (await read(2)).resolve(scrolled);
  (await read(3)).resolve(scrolled.replace("line 24", "line 24!"));
  await read(4);
  expect(frames).toEqual([mirrorFrame(before), mirrorFrame(scrolled), mirrorRows(scrolled, scrolled.replace("line 24", "line 24!"), 24)]);
  session.kill();
});

it("reads the screen at once after something was typed, instead of waiting out an idle screen", async () => {
  const { session, read, asked, frames } = pane({ idleMs: 60_000, activeMs: 60_000, echoMs: 0 });
  (await read(1)).resolve("$ ");
  // the next read is a minute away
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(asked.length).toBe(1);
  session.write("l");
  (await read(2)).resolve("$ l");
  // typed again while that read was on its way: one more read follows it, not a second loop
  session.write("s");
  session.poke();
  (await read(3)).resolve("$ ls");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(asked.length).toBe(3);
  expect(frames).toEqual([mirrorFrame("$ "), mirrorFrame("$ l"), mirrorFrame("$ ls")]);
  session.kill();
});

it("sends a screen once, and again only when it changed", async () => {
  const { session, read, frames } = pane();
  (await read(1)).resolve("one");
  (await read(2)).resolve("one");
  (await read(3)).resolve("two");
  await read(4);
  expect(frames).toEqual([mirrorFrame("one"), mirrorFrame("two")]);
  session.kill();
});

it("holds screens while paused and sends only the latest on resume", async () => {
  const { session, read, frames } = pane();
  (await read(1)).resolve("one");
  await read(2);
  session.pause();
  (await read(2)).resolve("two");
  (await read(3)).resolve("three");
  await read(4);
  expect(frames).toEqual([mirrorFrame("one")]);
  session.resume();
  expect(frames).toEqual([mirrorFrame("one"), mirrorFrame("three")]);
  session.kill();
});

it("adopts the pane's new size, says so first, and paints the unchanged screen again", async () => {
  let size = { cols: 80, rows: 24 };
  const events: string[] = [];
  const { session, read, frames } = pane({ size: async () => size, sizeMs: 0, onResize: (cols, rows) => events.push(`resize ${cols}x${rows}`) });
  (await read(1)).resolve("one");
  await read(2);
  events.push(`frames ${frames.length}`);
  size = { cols: 100, rows: 30 };
  (await read(2)).resolve("one");
  (await read(3)).resolve("one");
  await read(4);
  events.push(`frames ${frames.length}`);
  expect(events).toEqual(["frames 1", "resize 100x30", "frames 2"]);
  expect(frames).toEqual([mirrorFrame("one"), mirrorFrame("one")]);
  session.kill();
});

it("keeps the latest screen whole for a client joining late", async () => {
  const { session, read } = pane({ rows: 700 });
  expect(session.current).toBeNull();
  const big = Array.from({ length: 700 }, () => "x".repeat(400)).join("\r\n");
  (await read(1)).resolve(big);
  await read(2);
  expect(session.current).toBe(mirrorFrame(big, 700));
  expect(Buffer.byteLength(session.current!)).toBeGreaterThan(256 * 1024);
  session.kill();
});

it("stops reading once killed, without calling it an exit", async () => {
  const { session, read, asked, frames, exits } = pane();
  const first = await read(1);
  session.kill();
  first.resolve("late");
  await session.exited;
  // the timer a live mirror would have set for its next read has had its turn
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(asked.length).toBe(1);
  expect(frames).toEqual([]);
  expect(exits).toEqual([]);
});

it("ends as a terminal does when herdr says the pane is gone, and keeps trying a herdr that does not answer", async () => {
  const { session, read, exits } = pane();
  (await read(1)).reject(new HerdrError("connect_failed", "no herdr"));
  (await read(2)).reject(new HerdrError("pane_not_found", "pane gone"));
  await session.exited;
  expect(exits).toEqual([null]);
});

it("types into the pane through herdr", () => {
  const { session, written } = pane();
  session.write("ls\r");
  expect(written).toEqual(["ls\r"]);
  session.kill();
});
