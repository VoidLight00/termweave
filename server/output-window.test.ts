import { describe, expect, it } from "bun:test";
import { OutputWindow, OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES, ReplayBuffer } from "./output-window.ts";

describe("terminal output credit", () => {
  it("holds high-water backpressure until the low watermark, without duplicate credit", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.blocked).toBe(true);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES - 1);
    expect(window.blocked).toBe(true);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(window.blocked).toBe(false);
    const pending = window.pending;
    window.acknowledge(window.id, 0);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(window.pending).toBe(pending);
  });

  it("rejects stale subscriptions, impossible offsets and non-integer credit", () => {
    const old = new OutputWindow();
    const current = new OutputWindow();
    current.write(100);
    expect(current.acknowledge(old.id, 100)).toBe(false);
    for (const value of [-1, 101, 0.5, NaN, Infinity]) expect(current.acknowledge(current.id, value)).toBe(false);
    expect(current.pending).toBe(100);
    expect(current.acknowledge(current.id, 100)).toBe(true);
    expect(current.pending).toBe(0);
  });

  it("bounds replay in bytes without corrupting Korean or emoji at the cut", () => {
    const text = "시작🙂끝";
    for (let limit = 1; limit <= Buffer.byteLength(text); limit++) {
      const replay = new ReplayBuffer(limit);
      replay.append("prefix");
      replay.append(text);
      const tail = replay.text();
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(limit);
      expect(tail).not.toContain("�");
      expect(text.endsWith(tail)).toBe(true);
    }
  });

  it("leads a late joiner's replay with the modes that fell out of the tail", () => {
    const replay = new ReplayBuffer(16);
    replay.append("\x1b[?1006l\x1b[?1016l\x1b[?1000l\x1b[?1049h\x1b[?1000h\x1b[?1002;1006h\x1b[?25l");
    replay.append("x".repeat(40));
    // each at its last state, in the order of those last switches: 1006h after 1016l
    expect(replay.text()).toBe("\x1b[?1016l\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l" + "x".repeat(16));
    // a switch the cut would split is kept whole in the tail, not lost to both halves
    replay.append("\x1b[?1049l" + "y".repeat(16));
    replay.append("y".repeat(16));
    expect(replay.text()).toBe("\x1b[?1016l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[?1049l" + "y".repeat(16));
  });

  it("replays a short stream as it is, and nothing before any output", () => {
    const replay = new ReplayBuffer(1024);
    expect(replay.text()).toBe("");
    replay.append("\x1b[?1049h\x1b[?1000hhello");
    expect(replay.text()).toBe("\x1b[?1049h\x1b[?1000hhello");
  });
});
