import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Selection = { type: string; pane_id: string; machine_id: string };
type WindowClient = { focused: boolean; postMessage: (data: Selection) => void; focus: () => Promise<void> };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Execute the shipped worker, including its asynchronous notificationclick listener. */
function notifications(
  windows: WindowClient[],
  matchAll = async () => windows,
  openWindow: (url: string) => Promise<WindowClient | null> = async () => null,
) {
  const listeners = new Map<string, (event: unknown) => void>();
  const opened: string[] = [];
  let closed = 0;
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    clients: { matchAll, openWindow: async (url: string) => { opened.push(url); return openWindow(url); } },
  };
  new Function("self", readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8"))(self);
  const click = (paneId: string | null = "pane-a", machineId = "local"): Promise<void> => {
    let completion!: Promise<void>;
    listeners.get("notificationclick")!({
      notification: { data: { pane_id: paneId, machine_id: machineId }, close: () => { closed++; } },
      waitUntil: (promise: Promise<void>) => { completion = promise; },
    });
    return completion;
  };
  return { click, opened, closed: () => closed };
}

function client(focus = async () => {}, focused = false) {
  const selected: Selection[] = [];
  return { focused, focus, selected, postMessage: (data: Selection) => selected.push(data) };
}

describe("notification clicks", () => {
  it("selects the pane before a delayed focus and repeats after the page resumes", async () => {
    const pending = deferred();
    const target = client(() => pending.promise);
    const worker = notifications([target]);
    const done = worker.click("remote pane/?", "remote&pc");
    await Promise.resolve();
    const selection = { type: "select-pane", pane_id: "remote pane/?", machine_id: "remote&pc" };
    expect(target.selected).toEqual([selection]);
    expect(worker.opened).toEqual([]);
    pending.resolve();
    await done;
    expect(target.selected).toEqual([selection, selection]);
    expect(worker.opened).toEqual([]);
    expect(worker.closed()).toBe(1);
  });

  it("keeps selection on focus rejection and opens the exact remote pane once", async () => {
    const target = client(async () => { throw new Error("NotAllowedError"); });
    const worker = notifications([target]);
    await worker.click("remote pane/?", "remote&pc");
    expect(target.selected).toEqual([{ type: "select-pane", pane_id: "remote pane/?", machine_id: "remote&pc" }]);
    expect(worker.opened).toEqual(["/?machine=remote%26pc&pane=remote%20pane%2F%3F"]);
  });

  it("chooses the focused window and does not open another after a successful focus", async () => {
    const background = client();
    const foreground = client(undefined, true);
    const worker = notifications([background, foreground]);
    await worker.click();
    expect(background.selected).toEqual([]);
    expect(foreground.selected).toHaveLength(2);
    expect(worker.opened).toEqual([]);
  });

  it("opens a pane URL when no app window exists, and root when no pane was supplied", async () => {
    const worker = notifications([]);
    await worker.click("pane-b", "remote");
    await worker.click(null);
    expect(worker.opened).toEqual(["/?machine=remote&pane=pane-b", "/"]);
  });

  it("focuses a generic notification without sending an empty pane selection", async () => {
    let focused = 0;
    const target = client(async () => { focused++; });
    const worker = notifications([target]);
    await worker.click(null);
    expect(focused).toBe(1);
    expect(target.selected).toEqual([]);
    expect(worker.opened).toEqual([]);
  });

  it("a late focus cannot switch away from a more recently tapped notification", async () => {
    const pending = deferred();
    let focuses = 0;
    const target = client(() => ++focuses === 1 ? pending.promise : Promise.resolve());
    const worker = notifications([target]);
    const first = worker.click("pane-a");
    await Promise.resolve();
    await worker.click("pane-b");
    pending.resolve();
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-a", "pane-b", "pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });

  it("a superseded focus rejection cannot open a stale duplicate window", async () => {
    const pending = deferred();
    let focuses = 0;
    const target = client(() => ++focuses === 1 ? pending.promise : Promise.resolve());
    const worker = notifications([target]);
    const first = worker.click("pane-a");
    await Promise.resolve();
    await worker.click("pane-b");
    pending.reject(new Error("NotAllowedError"));
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-a", "pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });

  it("a slow client lookup cannot deliver an older tap after the newer one", async () => {
    const pending = deferred();
    let lookups = 0;
    const target = client();
    const worker = notifications([target], async () => {
      if (++lookups === 1) await pending.promise;
      return [target];
    });
    const first = worker.click("pane-a");
    await worker.click("pane-b");
    pending.resolve();
    await first;
    expect(target.selected.map((selection) => selection.pane_id)).toEqual(["pane-b", "pane-b"]);
    expect(worker.opened).toEqual([]);
  });

  it("an older client foregrounded last shows the newest notification's exact PC and pane", async () => {
    const pending = deferred();
    let foreground = "";
    let focuses = 0;
    const older = client(async () => { focuses++; await pending.promise; foreground = "older"; });
    const newer = client(async () => { focuses++; foreground = "newer"; }, true);
    let lookups = 0;
    const worker = notifications([older], async () => ++lookups === 1 ? [older] : [newer, older]);
    const first = worker.click("pane-a", "local");
    await Promise.resolve();
    const selection = { type: "select-pane", pane_id: "latest pane/?", machine_id: "remote&pc" };
    // The newer focus must finish even while the older window's focus is hung.
    await worker.click(selection.pane_id, selection.machine_id);
    expect(foreground).toBe("newer");
    pending.resolve();
    await first;
    expect(foreground).toBe("older");
    expect(older.selected.at(-1)).toEqual(selection);
    expect(newer.selected.at(-1)).toEqual(selection);
    expect(focuses).toBe(2); // one focus per tap, no repair focus loop
    expect(worker.opened).toEqual([]);
  });

  it("repairs an old focused client while the newest notification's lookup is still pending", async () => {
    const focus = deferred();
    const lookup = deferred();
    let foreground = "";
    const older = client(async () => { await focus.promise; foreground = "older"; });
    const newer = client(async () => { foreground = "newer"; }, true);
    let lookups = 0;
    const worker = notifications([older], async () => {
      if (++lookups === 1) return [older];
      await lookup.promise;
      return [newer, older];
    });
    const first = worker.click("pane-a");
    await Promise.resolve();
    const selection = { type: "select-pane", pane_id: "pane-b", machine_id: "second/pc" };
    const second = worker.click(selection.pane_id, selection.machine_id);
    focus.resolve();
    await first;
    expect(foreground).toBe("older");
    expect(older.selected.at(-1)).toEqual(selection);
    expect(newer.selected).toEqual([]);
    lookup.resolve();
    await second;
    expect(foreground).toBe("newer");
    expect(newer.selected.at(-1)).toEqual(selection);
    expect(worker.opened).toEqual([]);
  });

  it("a rejected old client does not reopen its pane after another client was focused", async () => {
    const pending = deferred();
    let foreground = "";
    const older = client(() => pending.promise);
    const newer = client(async () => { foreground = "newer"; }, true);
    let lookups = 0;
    const worker = notifications([older], async () => ++lookups === 1 ? [older] : [newer, older]);
    const first = worker.click("pane-a");
    await Promise.resolve();
    await worker.click("pane-b", "remote");
    pending.reject(new Error("NotAllowedError"));
    await first;
    expect(foreground).toBe("newer");
    expect(newer.selected.at(-1)).toEqual({ type: "select-pane", pane_id: "pane-b", machine_id: "remote" });
    expect(older.selected).toEqual([{ type: "select-pane", pane_id: "pane-a", machine_id: "local" }]);
    expect(worker.opened).toEqual([]);
  });

  for (const fallback of [false, true]) {
    it(`a delayed ${fallback ? "focus fallback" : "cold app"} window shows the latest tap when it opens last`, async () => {
      const opening = deferred();
      const ready = deferred();
      let foreground = "";
      let focuses = 0;
      const refused = client(async () => { focuses++; throw new Error("NotAllowedError"); });
      const newer = client(async () => { focuses++; foreground = "newer"; }, true);
      const opened = client();
      let lookups = 0;
      const worker = notifications([], async () => {
        if (++lookups > 1) return [newer];
        return fallback ? [refused] : [];
      }, async () => {
        opening.resolve();
        await ready.promise;
        foreground = "opened";
        return opened;
      });
      const first = worker.click("older pane/?", "first&pc");
      await opening.promise;
      const selection = { type: "select-pane", pane_id: "latest pane/?", machine_id: "remote&pc" };
      // A frozen open must not hold up a later click on an existing window.
      await worker.click(selection.pane_id, selection.machine_id);
      expect(foreground).toBe("newer");
      ready.resolve();
      await first;
      expect(foreground).toBe("opened");
      expect(opened.selected.at(-1)).toEqual(selection);
      expect(newer.selected.at(-1)).toEqual(selection);
      expect(worker.opened).toEqual(["/?machine=first%26pc&pane=older%20pane%2F%3F"]);
      expect(focuses).toBe(fallback ? 2 : 1);
    });
  }

  it("repairs an opened window while the newest notification's client lookup is still pending", async () => {
    const opening = deferred();
    const ready = deferred();
    const lookup = deferred();
    const opened = client();
    const newer = client();
    let lookups = 0;
    const worker = notifications([], async () => {
      if (++lookups === 1) return [];
      await lookup.promise;
      return [newer];
    }, async () => {
      opening.resolve();
      await ready.promise;
      return opened;
    });
    const first = worker.click("pane-a");
    await opening.promise;
    const selection = { type: "select-pane", pane_id: "pane-b", machine_id: "second/pc" };
    const second = worker.click(selection.pane_id, selection.machine_id);
    ready.resolve();
    await first;
    expect(opened.selected.at(-1)).toEqual(selection);
    expect(newer.selected).toEqual([]);
    lookup.resolve();
    await second;
    expect(newer.selected.at(-1)).toEqual(selection);
    expect(worker.opened).toEqual(["/?machine=local&pane=pane-a"]);
  });
});
