import { describe, expect, it } from "bun:test";
import { DROPLET_REPEAT_MS, FLICK_WINDOW_MS, LONG_TURN_MS, dropletAllows, endedTurn, flickVelocity, onDroplet, showDroplet, trackTurn, type DropletNotice, type QueuedDroplet } from "./droplet.ts";

const notice: DropletNotice = { machineId: "local", paneId: "p1", agent: "claude", title: "api", machine: null, kind: "blocked" };

describe("dropletAllows", () => {
  it("follows the device's choices, a finished turn's length included", () => {
    expect(dropletAllows({ input: true, done: "off" }, "blocked", null)).toBe(true);
    expect(dropletAllows({ input: false, done: "always" }, "blocked", null)).toBe(false);
    expect(dropletAllows({ input: true, done: "off" }, "done", LONG_TURN_MS)).toBe(false);
    expect(dropletAllows({ input: true, done: "always" }, "done", 1_000)).toBe(true);
    expect(dropletAllows({ input: true, done: "long" }, "done", 1_000)).toBe(false);
    expect(dropletAllows({ input: true, done: "long" }, "done", LONG_TURN_MS)).toBe(true);
    expect(dropletAllows({ input: true, done: "always" }, "working", null)).toBe(false);
  });

  it("tells a long-turn device about a turn it did not see start, as the server does", () => {
    expect(dropletAllows({ input: true, done: "long" }, "done", null)).toBe(true);
  });
});

describe("trackTurn", () => {
  it("measures a turn from the moment the pane started working", () => {
    const started = new Map<string, number>();
    expect(trackTurn(started, "p", "idle", "working", 1_000)).toBeNull();
    expect(trackTurn(started, "p", "working", "done", 71_000)).toBe(70_000);
    expect(started.size).toBe(0);
  });

  it("knows no length for a pane first seen working", () => {
    const started = new Map<string, number>();
    expect(trackTurn(started, "p", undefined, "working", 1_000)).toBeNull();
    expect(trackTurn(started, "p", "working", "done", 2_000)).toBeNull();
  });

  it("counts a wait for the user as part of the turn", () => {
    const started = new Map<string, number>();
    trackTurn(started, "p", "idle", "working", 1_000);
    expect(trackTurn(started, "p", "working", "blocked", 5_000)).toBeNull();
    trackTurn(started, "p", "blocked", "working", 7_000);
    expect(trackTurn(started, "p", "working", "done", 9_000)).toBe(8_000);
  });
});

describe("endedTurn", () => {
  it("keeps a pane that ended after a known short turn quiet on a long-turn device", () => {
    const started = new Map<string, number>();
    const lasted = new Map<string, number>();
    trackTurn(started, "p", "idle", "working", 1_000);
    lasted.set("p", trackTurn(started, "p", "working", "done", 3_000)!);
    const worked = endedTurn(started, lasted, "p", 500_000);
    expect(worked).toBe(2_000);
    expect(dropletAllows({ input: true, done: "long" }, "done", worked)).toBe(false);
    expect(dropletAllows({ input: true, done: "always" }, "done", worked)).toBe(true);
    expect(lasted.size).toBe(0);
  });

  it("measures a pane that ended mid-turn from when it started working", () => {
    const started = new Map<string, number>();
    const lasted = new Map<string, number>([["p", 2_000]]);
    trackTurn(started, "p", "done", "working", 10_000);
    const worked = endedTurn(started, lasted, "p", 10_000 + LONG_TURN_MS);
    expect(worked).toBe(LONG_TURN_MS);
    expect(dropletAllows({ input: true, done: "long" }, "done", worked)).toBe(true);
    expect(started.size).toBe(0);
  });

  it("knows no length for a pane whose turns this page did not see", () => {
    expect(endedTurn(new Map(), new Map(), "p", 1_000)).toBeNull();
  });
});

describe("flickVelocity", () => {
  it("does not count a hold before the flick", () => {
    // held for a second, then 15px up in 20ms: 0.015 px/ms over the whole press
    const samples = [{ y: 100, t: 0 }, { y: 100, t: 1_000 }, { y: 92, t: 1_010 }];
    expect(flickVelocity(samples, 85, 1_020)).toBe(-0.75);
  });

  it("measures a quick press from where it began", () => {
    expect(flickVelocity([{ y: 100, t: 0 }, { y: 92, t: 10 }], 85, 20)).toBe(-0.75);
  });

  it("is still when nothing moved lately", () => {
    expect(flickVelocity([{ y: 100, t: 0 }, { y: 60, t: 50 }], 60, 51 + FLICK_WINDOW_MS)).toBe(0);
  });
});

describe("showDroplet", () => {
  it("is false with nothing to draw it", () => {
    expect(showDroplet(notice, 1)).toBe(false);
  });

  it("hands each notice to the drawer once, and the same one again right away is one notice", () => {
    const seen: QueuedDroplet[] = [];
    const off = onDroplet((n) => seen.push(n));
    try {
      expect(showDroplet(notice, 10_000)).toBe(true);
      expect(showDroplet(notice, 10_000 + DROPLET_REPEAT_MS - 1)).toBe(false);
      expect(showDroplet({ ...notice, kind: "done" }, 10_001)).toBe(true);
      expect(showDroplet(notice, 10_000 + DROPLET_REPEAT_MS)).toBe(true);
      expect(seen.map((n) => n.kind)).toEqual(["blocked", "done", "blocked"]);
      expect(new Set(seen.map((n) => n.id)).size).toBe(3);
    } finally {
      off();
    }
    expect(showDroplet({ ...notice, paneId: "p2" }, 20_000)).toBe(false);
  });
});
