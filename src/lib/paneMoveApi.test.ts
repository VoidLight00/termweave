import { expect, it } from "bun:test";
import { movePane } from "./api.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { moveRequest } from "../../shared/paneMove.ts";

it("uses the selected machine route and returns the authoritative new pane ID", async () => {
  const source = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "owned-term" } as HerdrPane;
  const target = { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", terminal_id: "other-term" } as HerdrPane;
  const body = moveRequest(source, target);
  const result = { changed: true, previous_pane_id: source.pane_id, pane: { ...source, pane_id: "w2:p4", tab_id: target.tab_id, workspace_id: target.workspace_id } };
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, options?: RequestInit) => {
    calls++;
    expect(String(url)).toBe("/api/machines/remote-owned/pane/move");
    expect(JSON.parse(options!.body as string)).toEqual(body);
    expect(new Headers(options!.headers).get("x-herdr-machine")).toBe("1");
    return Response.json(result);
  }) as unknown as typeof fetch;
  try { expect((await movePane(body, "remote-owned")).pane.pane_id).toBe("w2:p4"); expect(calls).toBe(1); }
  finally { globalThis.fetch = original; }
});

it("never retries unknown outcomes, disconnected PCs or unsuccessful responses", async () => {
  const source = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "term" } as HerdrPane;
  const request = moveRequest(source, { ...source, pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1" });
  const original = globalThis.fetch;
  try {
    for (const mode of ["malformed", "offline", "disconnect"]) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        if (mode === "disconnect") throw new Error("disconnected after dispatch");
        if (mode === "offline") return Response.json({ error: { code: "machine_offline", message: "offline" } }, { status: 503 });
        return Response.json({ changed: true, previous_pane_id: source.pane_id, pane: { ...source, terminal_id: "replacement" } });
      }) as unknown as typeof fetch;
      await expect(movePane(request, "remote-owned")).rejects.toThrow();
      expect(calls).toBe(1);
    }
  } finally { globalThis.fetch = original; }
});
