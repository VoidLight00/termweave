import { describe, expect, it } from "bun:test";
import type { AgentStatus } from "../../shared/protocol.ts";
import { alertsAllow, shouldNotifyStatus } from "./notifications.ts";

describe("shouldNotifyStatus", () => {
  it("notifies when a known pane becomes blocked", () => {
    expect(shouldNotifyStatus("working", "blocked")).toBe(true);
  });

  it("notifies when a known pane becomes done", () => {
    expect(shouldNotifyStatus("blocked", "done")).toBe(true);
  });

  it("does not notify for the busy baseline states", () => {
    expect(shouldNotifyStatus("idle", "working")).toBe(false);
    expect(shouldNotifyStatus("working", "idle")).toBe(false);
  });

  it("does not notify when the status does not change", () => {
    expect(shouldNotifyStatus("blocked", "blocked")).toBe(false);
  });

  it("does not notify on first sight of a pane", () => {
    // the app just opened or the pane is new: not news
    expect(shouldNotifyStatus(undefined, "blocked")).toBe(false);
  });

  it("carries unknown future statuses through without notifying", () => {
    expect(shouldNotifyStatus("working", "teleporting" as AgentStatus)).toBe(false);
  });
});

describe("alertsAllow", () => {
  it("lets through what the device chose, and nothing that is not an alert", () => {
    expect(alertsAllow({ input: true, done: "off" }, "blocked")).toBe(true);
    expect(alertsAllow({ input: false, done: "always" }, "blocked")).toBe(false);
    expect(alertsAllow({ input: false, done: "long" }, "done")).toBe(true);
    expect(alertsAllow({ input: true, done: "off" }, "done")).toBe(false);
    expect(alertsAllow({ input: true, done: "always" }, "working")).toBe(false);
  });
});
