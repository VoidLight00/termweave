import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EDGE_PX, SWIPE_PX, swipeVerdict, watchDrawerSwipe } from "./edgeSwipe.ts";

describe("swipeVerdict", () => {
  test("a swipe in from the left edge opens the closed drawer", () => {
    expect(swipeVerdict(false, 4, 20, 2)).toBe("claim");
    expect(swipeVerdict(false, 4, SWIPE_PX, 5)).toBe("open");
  });

  test("a stroke that starts away from the edge is the page's", () => {
    expect(swipeVerdict(false, EDGE_PX + 1, SWIPE_PX * 2, 0)).toBe("ignore");
  });

  test("a vertical stroke from the edge still scrolls", () => {
    expect(swipeVerdict(false, 4, 12, 40)).toBe("ignore");
  });

  test("a tiny movement is not a direction yet", () => {
    expect(swipeVerdict(false, 4, 3, 2)).toBe("pending");
  });

  test("a swipe to the left anywhere closes the open drawer", () => {
    expect(swipeVerdict(true, 200, -20, 3)).toBe("claim");
    expect(swipeVerdict(true, 200, -SWIPE_PX, 3)).toBe("close");
    expect(swipeVerdict(true, 200, SWIPE_PX, 3)).toBe("ignore");
  });
});

/**
 * The listener itself, on a stand-in document: a claimed stroke must keep every later move
 * from the page (the terminal's one-finger scroll listens below it) until the finger lifts.
 */
describe("watchDrawerSwipe", () => {
  type Handler = (event: unknown) => void;
  let listeners: Map<string, Handler>;
  let saved: { window: unknown; document: unknown };
  let narrow: { matches: boolean };
  let modal: unknown;
  let selection: { isCollapsed: boolean };

  beforeEach(() => {
    listeners = new Map();
    narrow = { matches: true };
    modal = null;
    selection = { isCollapsed: true };
    saved = { window: (globalThis as Record<string, unknown>)["window"], document: (globalThis as Record<string, unknown>)["document"] };
    (globalThis as Record<string, unknown>)["window"] = { matchMedia: () => narrow };
    (globalThis as Record<string, unknown>)["document"] = {
      addEventListener: (type: string, handler: Handler) => listeners.set(type, handler),
      removeEventListener: (type: string) => listeners.delete(type),
      querySelector: () => modal,
      getSelection: () => selection,
    };
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>)["window"] = saved.window;
    (globalThis as Record<string, unknown>)["document"] = saved.document;
  });

  /** One stroke through the listener; how many moves reached the page, and what the drawer did. */
  const stroke = (points: [number, number][], open = false, target: unknown = null, midway?: () => void) => {
    const calls: boolean[] = [];
    const stop = watchDrawerSwipe(() => open, (next) => calls.push(next));
    let reached = 0;
    const event = (x: number, y: number) => {
      let blocked = false;
      return { touches: [{ clientX: x, clientY: y }], preventDefault: () => { blocked = true; }, stopPropagation: () => { blocked = true; }, get blocked() { return blocked; } };
    };
    const [first, ...rest] = points;
    listeners.get("touchstart")!({ ...event(first![0], first![1]), target });
    for (const [index, [x, y]] of rest.entries()) {
      if (index === 1) midway?.();
      const move = event(x, y);
      listeners.get("touchmove")!(move);
      if (!move.blocked) reached++;
    }
    listeners.get("touchend")!({ touches: [] });
    stop();
    return { reached, calls };
  };

  test("a claimed stroke that comes back within the slop keeps every move from the page", () => {
    expect(stroke([[4, 400], [24, 400], [6, 400], [5, 400]])).toEqual({ reached: 0, calls: [] });
  });

  test("a claimed stroke that comes back and goes on opens the drawer once, and keeps its moves", () => {
    expect(stroke([[4, 400], [24, 400], [6, 400], [70, 400], [90, 460], [120, 520]])).toEqual({ reached: 0, calls: [true] });
  });

  test("a vertical stroke from mid-screen belongs to the page", () => {
    expect(stroke([[200, 300], [200, 330], [200, 360], [200, 400]])).toEqual({ reached: 3, calls: [] });
  });

  test("a swipe to the left closes the open drawer", () => {
    expect(stroke([[300, 400], [270, 400], [200, 400]], true)).toEqual({ reached: 0, calls: [false] });
  });

  test("a stroke that turns to scrolling before the drawer moved goes back to the page", () => {
    expect(stroke([[4, 300], [15, 302], [15, 360], [15, 430]])).toEqual({ reached: 2, calls: [] });
  });

  test("a swipe over a dialog, the palette or a sheet leaves the drawer under it alone", () => {
    modal = {};
    expect(stroke([[4, 400], [24, 400], [90, 400]])).toEqual({ reached: 2, calls: [] });
  });

  test("a swipe on a code block scrolled sideways scrolls it back instead", () => {
    const code = { scrollLeft: 40, scrollWidth: 900, clientWidth: 350, parentElement: null };
    const text = { scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: code };
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, text)).toEqual({ reached: 2, calls: [] });
  });

  test("a stroke that goes on after the screen turned wide leaves the drawer alone", () => {
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, null, () => { narrow.matches = false; })).toEqual({ reached: 1, calls: [] });
  });

  test("a stroke on a text field edits it, the drawer open or closed", () => {
    const input = { tagName: "TEXTAREA", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: null };
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, input)).toEqual({ reached: 2, calls: [] });
    expect(stroke([[300, 400], [270, 400], [200, 400]], true, input)).toEqual({ reached: 2, calls: [] });
    const block = { isContentEditable: true, tagName: "DIV", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: null };
    const inner = { tagName: "SPAN", scrollLeft: 0, scrollWidth: 0, clientWidth: 0, parentElement: block };
    expect(stroke([[4, 400], [24, 400], [90, 400]], false, inner)).toEqual({ reached: 2, calls: [] });
  });

  test("a stroke while text is selected drags the selection, not the drawer", () => {
    selection = { isCollapsed: false };
    expect(stroke([[4, 400], [24, 400], [90, 400]])).toEqual({ reached: 2, calls: [] });
    expect(stroke([[300, 400], [270, 400], [200, 400]], true)).toEqual({ reached: 2, calls: [] });
  });

  test("a selection begun mid-stroke, before the drawer moved, hands the stroke back", () => {
    expect(stroke([[4, 400], [24, 400], [40, 400], [90, 400]], false, null, () => { selection = { isCollapsed: false }; })).toEqual({ reached: 2, calls: [] });
  });

  test("a selection after the drawer moved leaves the stroke with it", () => {
    expect(stroke([[4, 400], [70, 400], [90, 400], [100, 400]], false, null, () => { selection = { isCollapsed: false }; })).toEqual({ reached: 0, calls: [true] });
  });
});
