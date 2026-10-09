import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DISMISS_DRAG_PX, dismissKeyboardOn, dragDismisses, tapDismisses } from "./keyboard.ts";

describe("dragDismisses", () => {
  test("a drag down the transcript puts the keyboard away", () => {
    expect(dragDismisses(0, DISMISS_DRAG_PX)).toBe(true);
    expect(dragDismisses(10, 80)).toBe(true);
  });

  test("a short, upward or sideways drag leaves it up", () => {
    expect(dragDismisses(0, DISMISS_DRAG_PX - 1)).toBe(false);
    expect(dragDismisses(0, -80)).toBe(false);
    expect(dragDismisses(90, 40)).toBe(false);
  });
});

describe("tapDismisses", () => {
  test("a tap with no element or on plain transcript reads", () => {
    expect(tapDismisses(null, "")).toBe(true);
  });

  test("a tap that ends a text selection keeps the keyboard", () => {
    expect(tapDismisses(null, "copied words")).toBe(false);
  });
});

/** The transcript's listeners, on a stand-in node and document, with the keyboard up. */
describe("dismissKeyboardOn", () => {
  type Handler = (event: unknown) => void;
  const names = ["window", "document", "HTMLElement"] as const;
  let saved: Record<string, unknown>;
  let selection: string;
  let blurred: number;

  beforeEach(() => {
    saved = Object.fromEntries(names.map((name) => [name, (globalThis as Record<string, unknown>)[name]]));
    selection = "";
    blurred = 0;
    class Element { blur(): void { blurred++; } }
    (globalThis as Record<string, unknown>)["HTMLElement"] = Element;
    (globalThis as Record<string, unknown>)["window"] = { getSelection: () => ({ toString: () => selection }) };
    (globalThis as Record<string, unknown>)["document"] = { documentElement: { hasAttribute: () => true }, activeElement: new Element() };
  });
  afterEach(() => {
    for (const name of names) (globalThis as Record<string, unknown>)[name] = saved[name];
  });

  const drag = (target: unknown, during?: () => void): number => {
    const listeners = new Map<string, Handler>();
    const node = { addEventListener: (type: string, handler: Handler) => listeners.set(type, handler), removeEventListener: () => {} };
    const stop = dismissKeyboardOn(node as unknown as HTMLElement);
    const touch = (y: number) => ({ target, touches: [{ clientX: 100, clientY: y }] });
    listeners.get("touchstart")!(touch(200));
    during?.();
    listeners.get("touchmove")!(touch(200 + DISMISS_DRAG_PX + 10));
    stop();
    return blurred;
  };

  test("a drag down plain transcript puts the keyboard away", () => {
    expect(drag({ closest: () => null })).toBe(1);
  });

  test("a drag that became a text selection after it started keeps the keyboard", () => {
    expect(drag({ closest: () => null }, () => { selection = "picked words"; })).toBe(0);
  });

  test("a drag that starts on a field in the transcript keeps the keyboard", () => {
    expect(drag({ closest: (selector: string) => (selector.includes("input") ? {} : null) })).toBe(0);
  });
});
