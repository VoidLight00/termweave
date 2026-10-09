import { expect, it } from "bun:test";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

it("routes moves only to the requested remote bridge, with no local fallback or retries", async () => {
  let calls = 0;
  const remote = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    calls++;
    expect(new URL(request.url).pathname).toBe("/api/pane/move");
    expect(request.headers.get("authorization")).toBe("Bearer owned-remote-token");
    expect(request.headers.get("cookie")).toBeNull();
    expect(await request.json()).toEqual({ pane_id: "collision", target_pane_id: "same-id-on-local" });
    return Response.json({ changed: true, pane: { pane_id: "remote-returned-id" } });
  } });
  const manager = { endpoint: (id: string) => id === "owned-remote" ? { url: `http://127.0.0.1:${remote.port}`, token: "owned-remote-token" } : null,
    trackTerminal: () => () => undefined } as unknown as MachineManager;
  const request = (id: string, extra: Record<string, string> = {}) => new Request(`http://localhost/api/machines/${id}/pane/move`, {
    method: "POST", headers: { "x-herdr-machine": "1", "content-type": "application/json", cookie: "browser-secret", authorization: "Bearer browser-secret", ...extra },
    body: JSON.stringify({ pane_id: "collision", target_pane_id: "same-id-on-local" }),
  });
  try {
    expect(await (await handleMachineRequest(request("owned-remote"), manager)).json()).toMatchObject({ pane: { pane_id: "remote-returned-id" } });
    expect((await handleMachineRequest(request("missing"), manager)).status).toBe(503);
    expect((await handleMachineRequest(request("owned-remote", { origin: "https://evil.invalid" }), manager)).status).toBe(403);
    expect(calls).toBe(1);
    remote.stop(true);
    expect((await handleMachineRequest(request("owned-remote"), manager)).status).toBe(502);
    expect(calls).toBe(1);
  } finally { remote.stop(true); }
});
