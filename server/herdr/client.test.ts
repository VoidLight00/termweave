import { describe, expect, it } from "bun:test";
import {
  HerdrError,
  paneRead,
  ping,
  sessionSnapshot,
  subscribeEvents,
} from "./client.ts";

/**
 * Exercised against the REAL running herdr server: this client exists to speak a
 * live socket protocol, so a mocked socket would prove nothing about it.
 * STRICTLY READ-ONLY - no pane is written to, created, or closed here.
 */

describe("ping", () => {
  it("reaches the live herdr server and reports its protocol", async () => {
    const result = await ping();
    expect(typeof result.version).toBe("string");
    expect(result.version.length).toBeGreaterThan(0);
    expect(result.protocol).toBeGreaterThan(0);
  });
});

describe("sessionSnapshot", () => {
  it("returns the live workspace/tab/pane tree", async () => {
    const snapshot = await sessionSnapshot();
    expect(snapshot.workspaces.length).toBeGreaterThan(0);
    expect(snapshot.panes.length).toBeGreaterThan(0);
    for (const workspace of snapshot.workspaces) {
      expect(typeof workspace.workspace_id).toBe("string");
      expect(workspace.workspace_id.length).toBeGreaterThan(0);
      expect(typeof workspace.label).toBe("string");
    }
    for (const pane of snapshot.panes) {
      expect(typeof pane.pane_id).toBe("string");
      expect(typeof pane.workspace_id).toBe("string");
    }
  });

  it("issues a fresh connection per call, so sequential calls both succeed", async () => {
    const first = await sessionSnapshot();
    const second = await sessionSnapshot();
    expect(first.workspaces.length).toBe(second.workspaces.length);
  });
});

describe("paneRead", () => {
  it("returns terminal text for a live pane and echoes its id", async () => {
    const snapshot = await sessionSnapshot();
    const pane = snapshot.panes[0];
    expect(pane).toBeDefined();
    const read = await paneRead({ paneId: pane!.pane_id, source: "visible" });
    expect(read.pane_id).toBe(pane!.pane_id);
    expect(typeof read.text).toBe("string");
  });

  it("keeps escape sequences when reading ansi", async () => {
    const snapshot = await sessionSnapshot();
    const pane = snapshot.panes[0]!;
    const read = await paneRead({ paneId: pane.pane_id, source: "visible", format: "ansi" });
    expect(typeof read.text).toBe("string");
    expect(read.format).toBe("ansi");
  });

  it("rejects an unknown pane with a coded HerdrError", async () => {
    let caught: unknown = null;
    try {
      await paneRead({ paneId: "w9999:p9999", source: "visible" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HerdrError);
    const error = caught as HerdrError;
    expect(typeof error.code).toBe("string");
    expect(error.code.length).toBeGreaterThan(0);
    // a timeout would mean the client hung rather than parsed the server's refusal
    expect(error.code).not.toBe("timeout");
  });
});

describe("subscribeEvents", () => {
  it("opens a streaming connection and closes cleanly", async () => {
    const snapshot = await sessionSnapshot();
    const pane = snapshot.panes[0]!;
    let handle: { close: () => void } | null = null;

    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscription_started not received within 5s")), 5000);
      handle = subscribeEvents(
        [
          { type: "pane.updated", pane_id: pane.pane_id },
          { type: "workspace.focused" },
        ],
        {
          onEvent: () => {},
          onStarted: () => {
            clearTimeout(timer);
            resolve();
          },
          onError: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        },
      );
    });

    await started;
    expect(handle).not.toBeNull();
    expect(() => handle!.close()).not.toThrow();
  });

  it("reports a connect that fails as closed, so a subscriber retrying on close retries", async () => {
    const closed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("onClose not called within 5s")), 5000);
      let error = "";
      subscribeEvents([{ type: "workspace.focused" }], {
        onEvent: () => {},
        onError: (err) => { error = (err as Error & { code?: string }).code ?? ""; },
        onClose: () => {
          clearTimeout(timer);
          resolve(error);
        },
      }, "/nonexistent/herdr-web-ui-test.sock");
    });
    expect(await closed).toBe("connect_failed");
  });
});
