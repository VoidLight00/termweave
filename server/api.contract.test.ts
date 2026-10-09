import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "./index.ts";
import type { AgentKind, AgentStatus, ApiError, HealthAuth, PushKey, RemoteAccess, SessionSnapshot, PaneReadResult, UsageReport, WorkspaceCreated } from "../shared/protocol.ts";
import { HerdrUpdater } from "./herdr-update.ts";
import type { HerdrUpdateStatus } from "../shared/update.ts";
import { UsageService } from "./usage.ts";
import { VoiceService } from "./voice.ts";
import { herdrRpc, ping, workspaceCreate, workspaceClose } from "./herdr/client.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";

/**
 * Contract test for herdr-web-ui's HTTP + WS surface.
 * Runs against the REAL herdr server on the developer's machine: these are the
 * integration seams the browser UI depends on, so a mock here would prove nothing.
 * Tests never mutate a user's pane; mutation cases create labeled workspaces and close them in afterAll.
 * Every server here keeps its push state (VAPID key, subscriptions) in a temp dir: the
 * user's ~/.config/herdr-web-ui holds their real devices, which a test must never page.
 */
let server: { port: number; stop: () => void };
const stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-contract-"));

beforeAll(() => {
  server = createServer({ port: 0, stateDir, alertTiming: { short: 0, long: 0, longTurn: 0 } });
});

afterAll(() => {
  server?.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

const base = () => `http://localhost:${server.port}`;

describe("usage API", () => {
  it("answers the report and keeps it behind the token gate", async () => {
    const usageState = mkdtempSync(join(tmpdir(), "herdr-usage-auth-"));
    const usage = new UsageService(undefined, []);
    const open = createServer({ port: 0, stateDir: usageState, usage });
    const gated = createServer({ port: 0, stateDir: usageState, usage, token: "test-usage-token" });
    try {
      const answered = await fetch(`http://localhost:${open.port}/api/usage`);
      expect(answered.status).toBe(200);
      expect(answered.headers.get("cache-control")).toBe("no-store");
      expect(await answered.json() as UsageReport).toEqual({ providers: [] });
      expect((await fetch(`http://localhost:${gated.port}/api/usage`)).status).toBe(401);
      const withToken = await fetch(`http://localhost:${gated.port}/api/usage`, { headers: { authorization: "Bearer test-usage-token" } });
      expect(withToken.status).toBe(200);
    } finally { open.stop(); gated.stop(); rmSync(usageState, { recursive: true, force: true }); }
  });
});

describe("voice API", () => {
  it("keeps the key on the server, refuses cross-site writes and streams a transcript", async () => {
    const voiceState = mkdtempSync(join(tmpdir(), "herdr-voice-contract-"));
    const key = "sk-contract-0123456789";
    const provider = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/audio/transcriptions") return new Response("not found", { status: 404 });
        expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
        await request.formData();
        return new Response(`data: ${JSON.stringify({ type: "transcript.text.done", text: "git status" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const voice = new VoiceService({ stateDir: voiceState, env: { HERDR_WEB_OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1` }, fetch });
    const open = createServer({ port: 0, stateDir: voiceState, voice });
    const gated = createServer({ port: 0, stateDir: voiceState, voice, token: "test-voice-token" });
    const at = (path: string) => `http://localhost:${open.port}${path}`;
    try {
      expect((await fetch(`http://localhost:${gated.port}/api/voice`)).status).toBe(401);
      expect(await (await fetch(at("/api/voice"))).json()).toMatchObject({ configured: false, source: null });

      const crossSite = await fetch(at("/api/voice/config"), { method: "PUT", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ api_key: key }) });
      expect(crossSite.status).toBe(403);
      const saved = await fetch(at("/api/voice/config"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: key }) });
      expect(saved.status).toBe(200);
      const status = await (await fetch(at("/api/voice"))).text();
      expect(JSON.parse(status)).toMatchObject({ configured: true, source: "file" });
      expect(status).not.toContain(key);
      expect(statSync(join(voiceState, "voice.json")).mode & 0o777).toBe(0o600);

      const form = new FormData();
      form.append("audio", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "voice.webm");
      form.append("mode", "chat");
      form.append("polish", "0");
      const transcribed = await fetch(at("/api/voice/transcribe"), { method: "POST", body: form });
      expect(transcribed.headers.get("content-type")).toContain("application/x-ndjson");
      expect((await transcribed.text()).trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ type: "done", text: "git status" }]);
    } finally {
      open.stop(); gated.stop(); provider.stop(true);
      rmSync(voiceState, { recursive: true, force: true });
    }
  });
});

describe("update API", () => {
  it("reports unmanaged servers without performing network discovery", async () => {
    const response = await fetch(`${base()}/api/updates`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json() as { managed: boolean }).managed).toBe(false);
  });

  it("refuses cross-site/form update requests and unmanaged installs", async () => {
    for (const headers of [{}, { "x-herdr-update": "1", origin: "https://untrusted.invalid" },
      { "x-herdr-update": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const response = await fetch(`${base()}/api/updates/install`, { method: "POST", headers });
      expect(response.status).toBe(403);
    }
    const response = await fetch(`${base()}/api/updates/install`, { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(response.status).toBe(409);
    expect((await response.json() as ApiError).error.code).toBe("updates_unmanaged");
  });

  it("keeps status and update actions behind the token gate", async () => {
    const protectedState = mkdtempSync(join(tmpdir(), "herdr-update-auth-"));
    const protectedServer = createServer({ port: 0, stateDir: protectedState, token: "test-update-token" });
    try {
      for (const path of ["/api/updates", "/api/updates/check", "/api/updates/install"]) {
        const response = await fetch(`http://localhost:${protectedServer.port}${path}`, {
          method: path === "/api/updates" ? "GET" : "POST", headers: { "x-herdr-update": "1" },
        });
        expect(response.status).toBe(401);
      }
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`http://localhost:${protectedServer.port}/api/herdr/update`, { method, headers: { "x-herdr-update": "1" } });
        expect(response.status).toBe(401);
      }
    } finally { protectedServer.stop(); rmSync(protectedState, { recursive: true, force: true }); }
  });

  it("offers no herdr update on a server started without the updater", async () => {
    const response = await fetch(`${base()}/api/herdr/update`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json() as HerdrUpdateStatus).toMatchObject({ supported: false, phase: "idle", output: null });
    expect((await fetch(`${base()}/api/herdr/update`, { method: "POST" })).status).toBe(403);
    const refused = await fetch(`${base()}/api/herdr/update`, { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(refused.status).toBe(409);
    expect((await refused.json() as ApiError).error.code).toBe("herdr_update_unsupported");
  });

  it("updates herdr through the server and reports what herdr said", async () => {
    // a stand-in: the real `herdr update` would replace the herdr on PATH and hand its server off
    const state = mkdtempSync(join(tmpdir(), "herdr-update-api-"));
    const standIn = join(state, "herdr");
    writeFileSync(standIn, [
      "#!/bin/sh",
      `echo "$*" >> '${join(state, "calls")}'`,
      'case "$1" in',
      `  status) echo '{"client":{"version":"0.9.3","binary":"${standIn}"},"server":{"running":true,"version":"0.9.3","capabilities":{"live_handoff":true}},"update":{"server_binary_stale":false}}' ;;`,
      "  update) echo 'already up to date (0.9.3)' >&2 ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"));
    chmodSync(standIn, 0o755);
    const server = createServer({ port: 0, stateDir: state, token: "", herdrUpdate: new HerdrUpdater({ bin: standIn }) });
    const url = `http://localhost:${server.port}/api/herdr/update`;
    try {
      expect(await (await fetch(url)).json() as HerdrUpdateStatus).toMatchObject({ supported: true, phase: "idle", server_version: "0.9.3", binary_version: "0.9.3", stale: false });
      expect((await fetch(url, { method: "POST" })).status).toBe(403);
      expect(existsSync(join(state, "calls")) ? readFileSync(join(state, "calls"), "utf8") : "").not.toContain("update --handoff");
      const accepted = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
      expect(accepted.status).toBe(202);
      const deadline = Date.now() + 10_000;
      let status = await (await fetch(url)).json() as HerdrUpdateStatus;
      while (status.phase === "updating" || status.finished_at === null) {
        if (Date.now() >= deadline) throw new Error("Timed out: the herdr update finished");
        await Bun.sleep(20);
        status = await (await fetch(url)).json() as HerdrUpdateStatus;
      }
      expect(status).toMatchObject({ phase: "idle", output: "already up to date (0.9.3)" });
      expect(readFileSync(join(state, "calls"), "utf8")).toContain("update --handoff");
    } finally { server.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("phone access", () => {
  it("says how a phone can reach this server, whatever Tailscale is doing on this machine", async () => {
    const response = await fetch(`${base()}/api/access`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const access = (await response.json()) as RemoteAccess;
    expect(access.port).toBe(server.port);
    expect(["missing", "stopped", "running"]).toContain(access.tailscale.state);
    if (access.tailscale.state !== "running") {
      expect(access.tailscale).toEqual({ state: access.tailscale.state, dns_name: null, serving_url: null, serve_command: null, serve_url: null });
    } else {
      // either an address already works, or there is a command to make one
      expect((access.tailscale.serving_url === null) !== (access.tailscale.serve_command === null)).toBe(true);
      if (access.tailscale.serve_command !== null) expect(access.tailscale.serve_command).toContain(`http://127.0.0.1:${server.port}`);
    }
  });

  it("stays behind the token gate", async () => {
    const protectedState = mkdtempSync(join(tmpdir(), "herdr-access-auth-"));
    const protectedServer = createServer({ port: 0, stateDir: protectedState, token: "test-access-token" });
    try {
      expect((await fetch(`http://localhost:${protectedServer.port}/api/access`)).status).toBe(401);
    } finally { protectedServer.stop(); rmSync(protectedState, { recursive: true, force: true }); }
  });
});

describe("mutation body validation", () => {
  it("rejects non-object JSON without touching herdr or losing the error envelope", async () => {
    for (const path of [
      "/api/workspace/create", "/api/workspace/rename", "/api/workspace/move", "/api/workspace/close",
      "/api/pane/rename", "/api/pane/input", "/api/pane/keys", "/api/pane/close", "/api/pane/image",
      "/api/pane/scroll",
    ]) {
      for (const body of [null, [], "text", 42, true]) {
        const response = await fetch(`${base()}${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(((await response.json()) as ApiError).error.code).toBe("invalid_body");
      }
    }
  });

  it("rejects invalid pane identifiers and key/image fields before RPCs", async () => {
    for (const [path, body, code] of [
      ["/api/pane/input", { pane_id: true, text: "echo bad" }, "missing_pane_id"],
      ["/api/pane/close", { pane_id: 5 }, "missing_pane_id"],
      ["/api/pane/keys", { pane_id: "unknown", keys: [null] }, "missing_keys"],
      ["/api/pane/image", { pane_id: "unknown", content_type: "image/png", data_base64: {} }, "invalid_image"],
      ["/api/workspace/create", { agent: { kind: "claude", args: "--help" } }, "invalid_agent"],
    ] as const) {
      const response = await fetch(`${base()}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
  });
});

describe("workspace and discovery endpoints", () => {
  let workspaceId: string | null = null;
  let paneId: string | null = null;
  const label = `herdr-web-ui-test-${Math.random().toString(36).slice(2)}`;
  const fileName = `${label}-mention.txt`;
  const filePath = join(tmpdir(), fileName);

  afterAll(async () => {
    if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    rmSync(filePath, { force: true });
  });

  it("lists agent kinds with required fallbacks sorted by display label", async () => {
    const res = await fetch(`${base()}/api/agents`);
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: AgentKind[] };
    expect(agents.some((agent) => agent.kind === "claude")).toBeTrue();
    expect(agents.some((agent) => agent.kind === "omp")).toBeTrue();
    expect(agents.map((agent) => agent.label)).toEqual([...agents.map((agent) => agent.label)].sort((a, b) => a.localeCompare(b)));
  });

  it("offers omo and gjc, which herdr cannot start, exactly when they are on PATH", async () => {
    const bin = mkdtempSync(join(tmpdir(), "herdr-web-ui-shell-agents-"));
    const path = process.env["PATH"];
    const kinds = async () => ((await (await fetch(`${base()}/api/agents`)).json()) as { agents: AgentKind[] }).agents;
    try {
      process.env["PATH"] = bin;
      expect((await kinds()).map((agent) => agent.kind)).not.toContain("gjc");
      for (const name of ["omo", "gjc"]) writeFileSync(join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
      const offered = await kinds();
      expect(offered).toContainEqual({ kind: "omo", label: "OmO" });
      expect(offered).toContainEqual({ kind: "gjc", label: "Gajae Code" });
    } finally {
      process.env["PATH"] = path;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("rejects a workspace cwd that is not an existing directory", async () => {
    const res = await fetch(`${base()}/api/workspace/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: join(tmpdir(), `does-not-exist-${crypto.randomUUID()}`) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error.code).toBe("invalid_cwd");
  });

  it("creates, edits, searches, inspects, and closes an owned workspace", async () => {
    writeFileSync(filePath, "mention fixture");
    // the dialog sends null for "not given" (agent: null = shell only): nulls must read as absent
    const create = await fetch(`${base()}/api/workspace/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: tmpdir(), label, agent: null }),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as WorkspaceCreated;
    workspaceId = created.workspace_id;
    paneId = created.pane_id;
    expect(created.agent_started).toBeFalse();

    const commands = await fetch(`${base()}/api/pane/commands?pane_id=${encodeURIComponent(paneId)}`);
    expect(commands.status).toBe(200);
    expect(await commands.json()).toEqual({ commands: [] });

    const files = await fetch(`${base()}/api/pane/files?pane_id=${encodeURIComponent(paneId)}&q=${encodeURIComponent(fileName)}&limit=5`);
    expect(files.status).toBe(200);
    expect(((await files.json()) as { files: string[] }).files).toContain(fileName);

    const prompt = await fetch(`${base()}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
    expect(prompt.status).toBe(200);
    expect(await prompt.json()).toEqual({ prompt: null, suggestion: null });

    for (const [path, body] of [
      ["/api/workspace/rename", { workspace_id: workspaceId, label: `${label}-renamed` }],
      ["/api/workspace/move", { workspace_id: workspaceId, insert_index: 0 }],
      ["/api/pane/rename", { pane_id: paneId, label: "renamed pane" }],
    ] as const) {
      const changed = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({ ok: true });
    }

    const close = await fetch(`${base()}/api/workspace/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
    expect(close.status).toBe(200);
    expect(await close.json()).toEqual({ ok: true });
    workspaceId = null;
  }, 20_000);

  it("starts another agent of a kind whose name is already taken", async () => {
    // muse stands in for the agent: herdr answers agent.start once the launch is typed into the
    // pane, so the kind needs no program behind it and no real agent runs
    const kind = "muse";
    const explicit = `given-${Math.random().toString(36).slice(2, 10)}`;
    const owned: string[] = [];
    const start = async (agent: { kind: string; name?: string }) => {
      const res = await fetch(`${base()}/api/workspace/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: tmpdir(), label: `${label}-agent-${owned.length}`, agent }),
      });
      expect(res.status).toBe(200);
      const created = (await res.json()) as WorkspaceCreated;
      owned.push(created.workspace_id);
      expect(created.error).toBeUndefined();
      expect(created.agent_started).toBeTrue();
      return (await herdrRpc<{ agent: { name?: string | null } }>("agent.get", { target: created.pane_id })).agent.name;
    };
    try {
      const first = await start({ kind });
      const second = await start({ kind });
      expect(first).toMatch(/^muse(-\d+)?$/);
      expect(second).toMatch(/^muse-\d+$/);
      expect(second).not.toBe(first);
      // a name the client gives is used as given
      expect(await start({ kind, name: explicit })).toBe(explicit);
    } finally {
      for (const id of owned) await herdrRpc("workspace.close", { workspace_id: id }).catch(() => undefined);
    }
  }, 20_000);

  it("uses the shared error envelope for malformed mutation bodies", async () => {
    for (const [path, body, code] of [
      ["/api/workspace/rename", {}, "missing_workspace_id"],
      ["/api/workspace/move", { workspace_id: "x", insert_index: -1 }, "invalid_index"],
      ["/api/workspace/close", {}, "missing_workspace_id"],
      ["/api/pane/rename", {}, "missing_pane_id"],
    ] as const) {
      const res = await fetch(`${base()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as ApiError).error.code).toBe(code);
    }
  });
});

describe("GET /api/pane/omo-tasks", () => {
  it("answers 400 without a pane, and no tasks for a pane that runs no OmO", async () => {
    const missing = await fetch(`${base()}/api/pane/omo-tasks`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as ApiError).error.code).toBe("missing_pane_id");
    const unknown = await fetch(`${base()}/api/pane/omo-tasks?pane_id=w0:p0`);
    expect(unknown.status).toBe(200);
    const body = await unknown.json() as { tasks: unknown[]; runs: unknown[]; server_time: string };
    expect(body.tasks).toEqual([]);
    expect(body.runs).toEqual([]);
    expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
  });
});

describe("GET /api/session", () => {
  it("returns the live herdr snapshot with at least one real workspace", async () => {
    const res = await fetch(`${base()}/api/session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshot: SessionSnapshot };
    expect(Array.isArray(body.snapshot.workspaces)).toBe(true);
    expect(body.snapshot.workspaces.length).toBeGreaterThan(0);
    // Every workspace carries the identity fields the sidebar renders.
    for (const ws of body.snapshot.workspaces) {
      expect(typeof ws.workspace_id).toBe("string");
      expect(ws.workspace_id.length).toBeGreaterThan(0);
      expect(typeof ws.label).toBe("string");
    }
    expect(body.snapshot.panes.length).toBeGreaterThan(0);
  });
});

describe("/api/pane/scroll and /api/pane/selection", () => {
  async function firstPane(): Promise<string> {
    const { snapshot } = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
    expect(snapshot.panes[0]).toBeDefined();
    return snapshot.panes[0]!.pane_id;
  }

  it("reads and sets the viewport position of a real pane", async () => {
    const paneId = await firstPane();
    const read = await fetch(`${base()}/api/pane/scroll?pane_id=${encodeURIComponent(paneId)}`);
    expect(read.status).toBe(200);
    const { scroll } = (await read.json()) as { scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number } };
    expect(Number.isInteger(scroll.max_offset_from_bottom)).toBe(true);
    expect(scroll.viewport_rows).toBeGreaterThan(0);
    const set = await fetch(`${base()}/api/pane/scroll`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, offset_from_bottom: 0 }),
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { scroll: { offset_from_bottom: number } }).scroll.offset_from_bottom).toBe(0);
  });

  it("reads a selection from the pane's history", async () => {
    const paneId = await firstPane();
    const query = new URLSearchParams({ pane_id: paneId, anchor_row: "0", anchor_col: "0", cursor_row: "0", cursor_col: "0" });
    const response = await fetch(`${base()}/api/pane/selection?${query}`);
    // an empty first cell has no text: herdr's refusal still comes back as a JSON error
    const body = (await response.json()) as { text?: string; error?: { code: string } };
    if (response.ok) expect(typeof body.text).toBe("string");
    else expect(typeof body.error?.code).toBe("string");
  });

  it("rejects bad coordinates and offsets before any RPC", async () => {
    for (const query of ["", "pane_id=w1:p1&anchor_row=0&anchor_col=0&cursor_row=0", "pane_id=w1:p1&anchor_row=-1&anchor_col=0&cursor_row=0&cursor_col=0", "pane_id=w1:p1&anchor_row=1.5&anchor_col=0&cursor_row=0&cursor_col=0"]) {
      const response = await fetch(`${base()}/api/pane/selection?${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe(query ? "invalid_range" : "missing_pane_id");
    }
    for (const offset of [-1, 1.5, "3", null]) {
      const response = await fetch(`${base()}/api/pane/scroll`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: "w1:p1", offset_from_bottom: offset }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiError).error.code).toBe("invalid_offset");
    }
    expect((await fetch(`${base()}/api/pane/scroll`)).status).toBe(400);
  });
});

describe("GET /api/pane/read", () => {
  it("returns terminal text for a real live pane", async () => {
    const snapRes = await fetch(`${base()}/api/session`);
    const { snapshot } = (await snapRes.json()) as { snapshot: SessionSnapshot };
    const pane = snapshot.panes[0];
    expect(pane).toBeDefined();

    const res = await fetch(`${base()}/api/pane/read?pane_id=${encodeURIComponent(pane!.pane_id)}&source=visible&format=text`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { read: PaneReadResult };
    expect(body.read.pane_id).toBe(pane!.pane_id);
    expect(typeof body.read.text).toBe("string");
  });

  it("rejects an unknown pane id with a clean JSON error and keeps serving", async () => {
    const res = await fetch(`${base()}/api/pane/read?pane_id=w9999:p9999&source=visible&format=text`);
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(typeof body.error.code).toBe("string");
    // the server survives a bad request
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });

  it("rejects a missing pane_id parameter", async () => {
    const res = await fetch(`${base()}/api/pane/read?source=visible`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/pane/close", () => {
  /** Own workspace again: this test really kills its root pane, never a user pane. */
  let workspaceId: string | null = null;
  let paneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-close", cwd: "/tmp", focus: false },
    );
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (workspaceId) await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
  });

  it("closes the named pane and it leaves the snapshot", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: paneId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // real cross-process state: fake timers cannot see herdr's snapshot, so this is
    // one of the rare genuine-delay polls (same shape as the exit test's retries)
    let gone = false;
    for (let attempt = 0; attempt < 10 && !gone; attempt += 1) {
      const session = (await (await fetch(`${base()}/api/session`)).json()) as { snapshot: SessionSnapshot };
      gone = !session.snapshot.panes.some((pane) => pane.pane_id === paneId);
      if (!gone) await Bun.sleep(500);
    }
    expect(gone).toBeTrue();
  }, 20000);

  it("answers the error envelope for an unknown pane", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "no-such-pane" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBeTruthy();
    expect(typeof body.error.message).toBe("string");
  });

  it("rejects a missing pane_id with 400 missing_pane_id", async () => {
    const res = await fetch(`${base()}/api/pane/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("missing_pane_id");
  });
});

describe("POST /api/pane/image", () => {
  /** Own workspace with its own cwd: the upload writes a real file into it. */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;
  let qaCwd: string | null = null;

  // a real 1x1 png
  const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  const post = (body: unknown) =>
    fetch(`${base()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    qaCwd = mkdtempSync(join(tmpdir(), "herdr-web-ui-image-"));
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-image", cwd: qaCwd, focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId });
    if (qaCwd) rmSync(qaCwd, { recursive: true, force: true });
  });

  it("stores a pasted image under the pane cwd and returns its absolute path", async () => {
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    // the prompt must reference a file the agent can read without leaving its project
    expect(body.path.startsWith(qaCwd!)).toBe(true);
    expect(body.path.includes(".termweave")).toBe(true);
    expect(body.path.endsWith(".png")).toBe(true);
    const stored = statSync(body.path);
    expect(stored.size).toBeGreaterThan(0);
    expect(stored.isFile()).toBe(true);
  });

  it("rejects an unknown pane with the shared error envelope", async () => {
    const res = await post({ pane_id: "w9999:p9999", content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("pane_not_found");
  });

  it("stores any other file under its own sanitised name", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64");
    const res = await post({ pane_id: qaPaneId, content_type: "image/svg+xml", data_base64: svg, name: "../omo icon.SVG" });
    expect(res.status).toBe(200);
    const { path } = (await res.json()) as { path: string };
    expect(path.startsWith(join(qaCwd!, ".termweave") + "/")).toBe(true);
    expect(basename(path)).toMatch(/^omo_icon-\d{8}-\d{6}-[0-9a-f]{8}\.svg$/);
    expect(readFileSync(path, "utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
    // no name, or one without a usable extension: still stored, as .bin
    const bare = (await (await post({ pane_id: qaPaneId, content_type: "", data_base64: svg })).json()) as { path: string };
    expect(basename(bare.path)).toMatch(/^file-.*\.bin$/);
  });

  it("rejects an image above the size ceiling with 413", async () => {
    const oversized = Buffer.alloc(9 * 1024 * 1024, 1).toString("base64");
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: oversized });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("image_too_large");
  });

  it("rejects empty image data with 400", async () => {
    const res = await post({ pane_id: qaPaneId, content_type: "image/png", data_base64: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("empty_image");
  });

  it("rejects a missing pane_id with 400 and keeps serving", async () => {
    const res = await post({ content_type: "image/png", data_base64: TINY_PNG_BASE64 });
    expect(res.status).toBe(400);
    const health = await fetch(`${base()}/api/health`);
    expect(health.status).toBe(200);
  });
});

describe("WebSocket /ws", () => {
  /**
   * Uses a workspace this test creates and closes, never one of the user's:
   * attaching starts a real `herdr terminal attach` against a live terminal.
   */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test", cwd: "/tmp", focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId });
  });

  it("pushes a snapshot on connect and streams real pty bytes for an attached pane", async () => {
    const paneId = qaPaneId!;
    expect(paneId).toBeTruthy();

    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    const seen: any[] = [];
    const waitFor = (predicate: (msg: any) => boolean, label: string, ms: number) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} not received within ${ms}ms`)), ms);
        const listener = (event: MessageEvent) => {
          const msg = JSON.parse(String(event.data));
          seen.push(msg);
          if (predicate(msg)) {
            clearTimeout(timer);
            ws.removeEventListener("message", listener as EventListener);
            resolve(msg);
          }
        };
        ws.addEventListener("message", listener as EventListener);
      });

    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const snapshot = await waitFor((m) => m.type === "snapshot", "snapshot", 5000);
    expect(snapshot.snapshot.workspaces.length).toBeGreaterThan(0);

    const streamed = waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "pty-data", 15000);
    ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 }));
    const frame = await streamed;
    expect(typeof frame.data).toBe("string");
    expect(frame.data.length).toBeGreaterThan(0);

    ws.send(JSON.stringify({ type: "detach", pane_id: paneId }));
    ws.close();
  }, 30000);

  it("rejects a malformed websocket frame without dropping the connection", async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
    const errored = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error frame within 5s")), 5000);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(String((event as MessageEvent).data));
        if (msg.type === "error") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
    ws.send("this is not json");
    const error = await errored;
    expect(error.code).toBe("invalid_json");
    ws.close();
  }, 15000);
});

type CookieWebSocketCtor = new (url: string, options: { headers: { cookie: string } }) => WebSocket;
/** A WS frame as tests read it: the discriminator plus whatever fields they assert on. */
type RecordedFrame = { type: string; [key: string]: unknown };

/** A WS client that records every frame it receives, with a bounded wait for one that matches. */
class RecordingSocket {
  readonly seen: RecordedFrame[] = [];
  private readonly ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      this.seen.push(JSON.parse(String((event as MessageEvent).data)));
    });
  }

  static async connect(url: string): Promise<RecordingSocket> {
    const socket = new RecordingSocket(url);
    await new Promise<void>((resolve) => socket.ws.addEventListener("open", () => resolve()));
    // drain the initial snapshot so callers wait only for what they named
    await socket.waitFor((message) => message.type === "snapshot", "snapshot", 10_000);
    return socket;
  }

  waitFor(predicate: (message: RecordedFrame) => boolean, label: string, ms: number): Promise<RecordedFrame> {
    const already = this.seen.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise<RecordedFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} not received within ${ms}ms`)), ms);
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as RecordedFrame;
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.ws.removeEventListener("message", listener as EventListener);
        resolve(message);
      };
      this.ws.addEventListener("message", listener as EventListener);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}

describe("WebSocket roles and status push", () => {
  /** Own workspace again: the role tests resize a real pty, the exit test kills a real shell. */
  let qaWorkspaceId: string | null = null;
  let qaPaneId: string | null = null;
  let exitWorkspaceId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-roles", cwd: "/tmp", focus: false },
    );
    qaWorkspaceId = created.workspace.workspace_id;
    qaPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (exitWorkspaceId) await herdrRpc("workspace.close", { workspace_id: exitWorkspaceId }).catch(() => undefined);
    if (qaWorkspaceId) await herdrRpc("workspace.close", { workspace_id: qaWorkspaceId }).catch(() => undefined);
  });

  it("rejects input from a non-attached client and signals readiness to the owner", async () => {
    const owner = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stranger = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      owner.send({ type: "attach", pane_id: qaPaneId!, cols: 100, rows: 30 });
      await owner.waitFor((m) => m.type === "input-ready" && m.pane_id === qaPaneId, "input ready", 15_000);
      const captured = join(stateDir, "unicode-input.txt");
      owner.send({ type: "input", pane_id: qaPaneId!, text: `printf '%s' '한글😀' > '${captured}'\r` });
      const deadline = Date.now() + 15_000;
      while (!existsSync(captured) && Date.now() < deadline) await Bun.sleep(25);
      expect(readFileSync(captured, "utf8")).toBe("한글😀");
      stranger.send({ type: "input", pane_id: qaPaneId!, text: "must-not-reach-the-pane" });
      const error = await stranger.waitFor((m) => m.type === "error", "input rejection", 5000);
      expect(error.code).toBe("input_not_ready");
      owner.send({ type: "detach", pane_id: qaPaneId! });
      owner.send({ type: "input", pane_id: qaPaneId!, text: "must-not-reach-the-pane" });
      expect((await owner.waitFor((m) => m.type === "error", "detached rejection", 5000)).code).toBe("input_not_ready");
    } finally { owner.close(); stranger.close(); }
  });

  it("never resizes the shared pty for an observe connection, and read-only frames answer input, keys and resize", async () => {
    const paneId = qaPaneId!;
    const operator = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);

    try {
      operator.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await operator.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "operator pty-data", 15_000);

      observer.send({ type: "role", mode: "observe" });
      const ack = await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      expect(ack.mode).toBe("observe");

      // an observer attaching a smaller screen must NOT resize the shared pty:
      // the attach answers with the grid to adopt (the operator's 100x30), not its own
      observer.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20 });
      const adopted = await observer.waitFor(
        (m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 100,
        "observer adopts geometry",
        5000,
      );
      expect(adopted.rows).toBe(30);
      expect(operator.seen.some((m) => m.type === "pane-geometry")).toBe(false);

      observer.send({ type: "resize", pane_id: paneId, cols: 40, rows: 20 });
      const resizeError = await observer.waitFor((m) => m.type === "error", "resize read_only error", 5000);
      expect(resizeError.code).toBe("read_only");

      observer.send({ type: "input", pane_id: paneId, text: "echo nope" });
      const inputError = await observer.waitFor((m) => m.type === "error", "input read_only error", 5000);
      expect(inputError.code).toBe("read_only");

      observer.send({ type: "keys", pane_id: paneId, keys: ["Enter"] });
      const keysError = await observer.waitFor((m) => m.type === "error", "keys read_only error", 5000);
      expect(keysError.code).toBe("read_only");

      // the operator keeps driving the shared grid, and everyone attached hears it
      operator.send({ type: "resize", pane_id: paneId, cols: 120, rows: 40 });
      const geometry = await operator.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "geometry broadcast", 5000);
      expect(geometry.cols).toBe(120);
      expect(geometry.rows).toBe(40);
      await observer.waitFor((m) => m.type === "pane-geometry" && m.cols === 120, "observer hears geometry", 5000);
    } finally {
      operator.close();
      observer.close();
    }
  }, 40_000);

  it("leaves the shared pty's size alone for an attach whose grid the chat lens covers", async () => {
    const created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-keep-size" });
    const paneId = created.root_pane.pane_id;
    const chat = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const otherChat = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const operator = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    // an observer re-attaching is told the grid the shared pty has now
    const grid = async () => {
      observer.seen.length = 0;
      observer.send({ type: "attach", pane_id: paneId, cols: 30, rows: 10 });
      return observer.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "observer geometry", 5000);
    };
    try {
      observer.send({ type: "role", mode: "observe" });
      await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);

      // a phone's chat lens attaches first: the pty starts at the pane's own grid, not 40x20
      chat.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20, keep_size: true });
      await chat.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "chat pty-data", 15_000);
      const own = await grid();
      expect([own.cols, own.rows]).not.toEqual([40, 20]);
      // and the chat lens is told that grid, to draw the screen it reads as the pty does
      expect(await chat.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId, "chat geometry", 5000)).toMatchObject({ cols: own.cols, rows: own.rows });

      // another covered attach to the running pty resizes nothing either
      otherChat.send({ type: "attach", pane_id: paneId, cols: 33, rows: 11, keep_size: true });
      await otherChat.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "other chat pty-data", 15_000);
      expect(await grid()).toMatchObject({ cols: own.cols, rows: own.rows });

      // a terminal lens still drives it: the same check sees a real resize
      operator.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await operator.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "operator pty-data", 15_000);
      expect(await grid()).toMatchObject({ cols: 100, rows: 30 });
    } finally {
      for (const socket of [chat, otherChat, observer, operator]) socket.close();
      await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    }
  }, 60_000);

  it("applies a resize that arrives while a covered attach is still creating the pty", async () => {
    const created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-keep-size-switch" });
    const paneId = created.root_pane.pane_id;
    const phone = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // the chat lens attaches, and the user switches to the terminal lens before the terminal
      // was looked up: both frames are on the server before the pty exists
      phone.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20, keep_size: true });
      phone.send({ type: "resize", pane_id: paneId, cols: 91, rows: 27 });
      // the terminal lens's grid is the pty's, not the pane's own one the covered attach left it at
      expect(await phone.waitFor((m) => m.type === "pane-geometry" && m.pane_id === paneId && m.cols === 91, "the resize applied after creation", 15_000)).toMatchObject({ cols: 91, rows: 27 });
      await phone.waitFor((m) => m.type === "input-ready" && m.pane_id === paneId, "attach took", 15_000);
      const sizeFile = join(stateDir, `covered-grid-${Date.now()}.txt`);
      await herdrRpc('pane.send_text', { pane_id: paneId, text: `stty size > '${sizeFile}'\n` });
      const deadline = Date.now() + 15_000;
      while (!existsSync(sizeFile) && Date.now() < deadline) await Bun.sleep(25);
      expect(readFileSync(sizeFile, 'utf8').trim()).toBe('27 91');
      // Geometry is asserted through the owned shell's stty result, not a substring
      // in one transport chunk. WebSocket input ownership/Unicode is covered above.
      expect(phone.seen.some(frame => frame.type === 'input-ready' && frame.pane_id === paneId)).toBe(true);
    } finally {
      phone.close();
      await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    }
  }, 60_000);

  it("rejects an unknown role mode with an in-band error", async () => {
    const client = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      client.send({ type: "role", mode: "wat" });
      const error = await client.waitFor((m) => m.type === "error", "invalid_role error", 5000);
      expect(error.code).toBe("invalid_role");
    } finally {
      client.close();
    }
  }, 15_000);

  it("pushes pane-status and pane-exited for a pane nobody is attached to", async () => {
    const paneId = qaPaneId!;
    const watcher = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // the collector subscribed to this pane when it was created; prove it by pushing
      // status changes through herdr itself and seeing the frames. herdr tears down a
      // subscription batch that references a pane which vanished mid-reconcile, so the
      // collector may briefly re-subscribe - retry the report (alternating states, so
      // each is a real change) until the frame arrives instead of trusting the clock
      let seen = false;
      for (let attempt = 0; attempt < 8 && !seen; attempt += 1) {
        await herdrRpc("pane.report_agent", {
          pane_id: paneId,
          source: "manual",
          agent: "claude",
          state: attempt % 2 === 0 ? "blocked" : "working",
        });
        seen = await watcher
          .waitFor(
            (m) => m.type === "pane-status" && m.pane_id === paneId && m.agent_status === (attempt % 2 === 0 ? "blocked" : "working"),
            "unattached pane-status",
            2_500,
          )
          .then(() => true)
          .catch(() => false);
      }
      expect(seen).toBeTrue();

      // a pane ending while unattached pushes pane-exited
      const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
        "workspace.create",
        { label: "herdr-web-ui-test-exit", cwd: "/tmp", focus: false },
      );
      exitWorkspaceId = created.workspace.workspace_id;
      const exitPaneId = created.root_pane.pane_id;
      // the collector picks a brand-new pane up via pane.created -> reconcile, which is
      // debounced: retry the status report (alternating states, so each is a real
      // change) until the frame proves the subscription is live - no clock-waiting
      let subscribed = false;
      for (let attempt = 0; attempt < 8 && !subscribed; attempt += 1) {
        await herdrRpc("pane.report_agent", {
          pane_id: exitPaneId,
          source: "manual",
          agent: "claude",
          state: attempt % 2 === 0 ? "blocked" : "working",
        });
        subscribed = await watcher
          .waitFor((m) => m.type === "pane-status" && m.pane_id === exitPaneId, "exit pane subscribed", 1_500)
          .then(() => true)
          .catch(() => false);
      }
      expect(subscribed).toBeTrue();
      await herdrRpc("pane.send_text", { pane_id: exitPaneId, text: "exit\r" });
      const exited = await watcher.waitFor(
        (m) => m.type === "pane-exited" && m.pane_id === exitPaneId,
        "unattached pane-exited",
        10_000,
      );
      expect(exited.type).toBe("pane-exited");
    } finally {
      watcher.close();
    }
  }, 40_000);
});

describe("WebSocket observer-first attach", () => {
  /** Own pane: the observer must be the one that creates the attachment. */
  let observeWorkspaceId: string | null = null;
  let observePaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-observe", cwd: "/tmp", focus: false },
    );
    observeWorkspaceId = created.workspace.workspace_id;
    observePaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (observeWorkspaceId) await herdrRpc("workspace.close", { workspace_id: observeWorkspaceId }).catch(() => undefined);
  });

  it("sizes a PTY an observe connection creates from the pane, never from the observer's grid", async () => {
    // observer-FIRST attach: nobody holds the attachment, so the observer's connect
    // spawns the shared pty. The user's named scenario (a phone opens the pane first)
    // must not seed the pty with the phone's viewport.
    const paneId = observePaneId!;
    const rectOf = async (): Promise<{ width: number; height: number } | null> => {
      const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      return snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    };
    const rectBefore = await rectOf();
    expect(rectBefore).not.toBeNull();

    const observer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      observer.send({ type: "role", mode: "observe" });
      await observer.waitFor((m) => m.type === "role-ack", "role-ack", 5000);
      observer.send({ type: "attach", pane_id: paneId, cols: 40, rows: 20 });
      const geometry = await observer.waitFor(
        (m) => m.type === "pane-geometry" && m.pane_id === paneId,
        "observer geometry",
        15_000,
      );
      // the spawned pty carries the pane's grid, not the observer's 40x20
      expect(geometry.cols).toBe(rectBefore!.width);
      expect(geometry.rows).toBe(rectBefore!.height);
      // herdr's layout is untouched either way
      expect(await rectOf()).toEqual(rectBefore);
    } finally {
      observer.close();
    }
  }, 30_000);
});

describe("WebSocket concurrent attach", () => {
  /** A pane nobody holds yet: the race is in CREATING the attachment. */
  let raceWorkspaceId: string | null = null;
  let racePaneId: string | null = null;

  beforeAll(async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-race", cwd: "/tmp", focus: false },
    );
    raceWorkspaceId = created.workspace.workspace_id;
    racePaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    if (raceWorkspaceId) await herdrRpc("workspace.close", { workspace_id: raceWorkspaceId }).catch(() => undefined);
  });

  it("shares one pty between clients whose attaches to the same pane race", async () => {
    const paneId = racePaneId!;
    const first = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const second = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // same tick: both attaches are in flight before either resolves the terminal
      first.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      second.send({ type: "attach", pane_id: paneId, cols: 120, rows: 40 });
      await first.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "first pty-data", 15_000);
      await second.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "second pty-data", 15_000);

      // one attachment means one client set: a resize reaches both. Two attachments
      // would leave one client on an orphaned record that never hears it.
      first.send({ type: "resize", pane_id: paneId, cols: 90, rows: 25 });
      await first.waitFor((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 25, "first hears resize", 5000);
      await second.waitFor((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 25, "second hears resize", 5000);
    } finally {
      first.close();
      second.close();
    }
  }, 40_000);
});

describe("WebSocket client leaving mid-attach", () => {
  /** One pane per trigger, so neither test inherits the other's attachment. */
  const leaveWorkspaceIds: string[] = [];

  async function createLeavePane(label: string): Promise<{ paneId: string; terminalId: string }> {
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label, cwd: "/tmp", focus: false },
    );
    leaveWorkspaceIds.push(created.workspace.workspace_id);
    const paneId = created.root_pane.pane_id;
    const snapshot = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as { terminal_id?: string } | undefined;
    expect(pane?.terminal_id).toBeTruthy();
    return { paneId, terminalId: pane!.terminal_id! };
  }

  /** The leaked resource itself: a live `herdr terminal attach` (or its sidecar) on this terminal. */
  function attachProcessCount(terminalId: string): number {
    const found = Bun.spawnSync(["pgrep", "-f", `terminal attach ${terminalId}`]);
    return found.stdout.toString().split("\n").filter(Boolean).length;
  }

  async function waitForAttachGone(terminalId: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (attachProcessCount(terminalId) > 0) {
      if (Date.now() > deadline) throw new Error(`attach on ${terminalId} still running ${ms}ms after its last client left`);
      await Bun.sleep(50);
    }
  }

  afterAll(async () => {
    for (const workspaceId of leaveWorkspaceIds) {
      await herdrRpc("workspace.close", { workspace_id: workspaceId }).catch(() => undefined);
    }
  });

  it("never pins the pty for a client that disconnects before its attach is ready", async () => {
    const { paneId, terminalId } = await createLeavePane("herdr-web-ui-test-leave-close");
    expect(attachProcessCount(terminalId)).toBe(0);
    const leaver = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stayer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // same tick: the close lands while the attach is still looking up the terminal
      leaver.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      leaver.close();
      stayer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await stayer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "stayer pty-data", 15_000);
      expect(attachProcessCount(terminalId)).toBeGreaterThan(0);
    } finally {
      stayer.close();
    }
    // the last live client left, so nothing may keep the attach running
    await waitForAttachGone(terminalId, 5000);
  }, 40_000);

  it("never pins the pty for a client that detaches before its attach is ready", async () => {
    const { paneId, terminalId } = await createLeavePane("herdr-web-ui-test-leave-detach");
    expect(attachProcessCount(terminalId)).toBe(0);
    const switcher = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    const stayer = await RecordingSocket.connect(`ws://localhost:${server.port}/ws`);
    try {
      // switching panes fast: the detach lands while the attach is still looking up the terminal
      switcher.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      switcher.send({ type: "detach", pane_id: paneId });
      stayer.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
      await stayer.waitFor((m) => m.type === "pty-data" && m.pane_id === paneId, "stayer pty-data", 15_000);
      expect(attachProcessCount(terminalId)).toBeGreaterThan(0);
      stayer.close();
      // the switcher is still connected but detached: it must not keep the attach running
      await waitForAttachGone(terminalId, 5000);
      expect(switcher.seen.some((m) => m.type === "pty-data" && m.pane_id === paneId)).toBe(false);
    } finally {
      switcher.close();
      stayer.close();
    }
  }, 40_000);
});

/**
 * Bun's WebSocket client sends request headers, but this project compiles with lib.dom,
 * whose WebSocket type only knows subprotocols (bun-types steps aside via
 * UseLibDomIfAvailable). Reaching the real capability through a guard keeps the test
 * honest: if Bun ever stopped sending the header, the server refuses the upgrade and
 * the test fails instead of silently passing.
 */
function takesCookieHeader(value: unknown): value is CookieWebSocketCtor {
  return typeof value === "function";
}

function connectWithCookie(url: string, cookie: string): WebSocket {
  const ctor: unknown = globalThis.WebSocket;
  if (!takesCookieHeader(ctor)) throw new Error("no WebSocket constructor in this runtime");
  return new ctor(url, { headers: { cookie } });
}

describe("web push", () => {
  /** A fake push service that decrypts like a device: see push.fake.ts. */
  let fake: FakePushService;
  let pushWorkspaceId: string | null = null;
  let pushPaneId: string | null = null;

  const postJson = (path: string, body: unknown, method = "POST") =>
    fetch(`${base()}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    fake = await startFakePushService();
    const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create",
      { label: "herdr-web-ui-test-push", cwd: "/tmp", focus: false },
    );
    pushWorkspaceId = created.workspace.workspace_id;
    pushPaneId = created.root_pane.pane_id;
  });

  afterAll(async () => {
    await postJson("/api/push/subscribe", { endpoint: fake.subscription.endpoint }, "DELETE").catch(() => undefined);
    fake.stop();
    if (pushWorkspaceId) await herdrRpc("workspace.close", { workspace_id: pushWorkspaceId }).catch(() => undefined);
  });

  it("hands out its VAPID key and refuses what is not a subscription", async () => {
    const key = (await (await fetch(`${base()}/api/push`)).json()) as PushKey;
    expect(Buffer.from(key.public_key, "base64url").length).toBe(65);

    const malformed = await postJson("/api/push/subscribe", { subscription: { endpoint: fake.subscription.endpoint, keys: {} } });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ApiError).error.code).toBe("invalid_subscription");

    const wrongMethod = await fetch(`${base()}/api/push/subscribe`);
    expect(wrongMethod.status).toBe(400);
    expect(((await wrongMethod.json()) as ApiError).error.code).toBe("method_not_allowed");
  });

  it("confirms a new device with a push it can decrypt, and forgets it on request", async () => {
    expect((await postJson("/api/push/subscribe", { subscription: fake.subscription })).status).toBe(204);
    expect((await postJson("/api/push/test", { endpoint: fake.subscription.endpoint })).status).toBe(204);
    const confirmation = await fake.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    expect(confirmation.payload.pane_id).toBeNull();
    expect(confirmation.vapidValid).toBe(true);
    const key = (await (await fetch(`${base()}/api/push`)).json()) as PushKey;
    expect(confirmation.vapidKey).toBe(key.public_key);

    expect((await postJson("/api/push/subscribe", { endpoint: fake.subscription.endpoint }, "DELETE")).status).toBe(204);
    const gone = await postJson("/api/push/test", { endpoint: fake.subscription.endpoint });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as ApiError).error.code).toBe("subscription_not_found");
  });

  it("pushes a live pane's status change to a subscribed device", async () => {
    const paneId = pushPaneId!;
    expect((await postJson("/api/push/subscribe", { subscription: fake.subscription })).status).toBe(204);
    // same retry as the pane-status test: the collector may still be re-subscribing to
    // the new pane, so alternate real changes until one lands as a push
    let pushed = null;
    for (let attempt = 0; attempt < 8 && !pushed; attempt += 1) {
      const state = attempt % 2 === 0 ? "blocked" : "working";
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state });
      if (state !== "blocked") continue;
      pushed = await fake
        .waitFor((push) => push.payload.pane_id === paneId, "status push", 2_500)
        .catch(() => null);
    }
    expect(pushed).not.toBeNull();
    expect(pushed!.payload.body).toBe("waiting for your input");
    expect(pushed!.payload.tag).toBe(`herdr-pane-${paneId}`);
    expect(pushed!.urgency).toBe("high");
    expect(pushed!.vapidValid).toBe(true);
  }, 40_000);

  it("reports a Codex unknown after work as done over WS and HTTP and delivers its completion push", async () => {
    // Exercise the real collector -> CompletionTracker -> PushService path using
    // manually reported statuses in owned panes. No Codex request or real device.
    let created: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let probe: Awaited<ReturnType<typeof workspaceCreate>> | undefined;
    let dir: string | undefined;
    let cleanupDevice: FakePushService | undefined;
    let bridge: ReturnType<typeof createServer> | undefined;
    let watcher: RecordingSocket | undefined;
    try {
      created = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-codex-finish" });
      probe = await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-codex-probe" });
      const paneId = created.root_pane.pane_id;
      const probeId = probe.root_pane.pane_id;
      dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-codex-finish-"));
      const device = await startFakePushService();
      cleanupDevice = device;
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "unknown" });
      bridge = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: dir, machines: false,
        alertTiming: { short: 0, long: 0, longTurn: 0 } });
      const origin = `http://127.0.0.1:${bridge.port}`;
      watcher = await RecordingSocket.connect(`ws://127.0.0.1:${bridge.port}/ws`);
      const subscribe = await fetch(`${origin}/api/push/subscribe`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: device.subscription, alerts: { input: false, done: "always" } }),
      });
      expect(subscribe.status).toBe(204);

      // Prove the subscription is live before changing the watched pane exactly
      // once. Alternating a separate probe does not fabricate its work history.
      let live = false;
      for (let attempt = 0; attempt < 8 && !live; attempt++) {
        const state = attempt % 2 === 0 ? "working" : "blocked";
        await herdrRpc("pane.report_agent", { pane_id: probeId, source: "manual", agent: "claude", state });
        live = await watcher.waitFor((message) => message.type === "pane-status" && message.pane_id === probeId && message.agent_status === state,
          "Codex regression probe", 2_500).then(() => true).catch(() => false);
      }
      expect(live).toBe(true);

      const report = async (agent: string, state: string, expected: string) => {
        watcher!.seen.length = 0;
        await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent, state });
        await watcher!.waitFor((message) => message.type === "pane-status" && message.pane_id === paneId && message.agent_status === expected,
          `${agent}/${state} presented as ${expected}`, 5_000);
        const raw = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
        // herdr itself may promote an unfocused idle after work to done.
        const rawStatus = raw.panes.find((pane) => pane.pane_id === paneId)?.agent_status;
        if (state === "idle") expect(rawStatus === "idle" || rawStatus === "done").toBe(true);
        else expect(rawStatus).toBe(state);
        const shown = await (await fetch(`${origin}/api/session`)).json() as { snapshot: SessionSnapshot };
        expect(shown.snapshot.panes.find((pane) => pane.pane_id === paneId)?.agent_status).toBe(expected);
        expect(shown.snapshot.agents.find((pane) => pane.pane_id === paneId)?.agent_status).toBe(expected);
      };

      for (let turn = 0; turn < 2; turn++) {
        await report("codex", "working", "working");
        await report("codex", "unknown", "done");
        await device.waitFor((message) => message.payload.pane_id === paneId &&
          device.received.filter((received) => received.payload.pane_id === paneId).length === turn + 1,
          "Codex completion push", 5_000);
      }
      const finishes = () => device.received.filter((message) => message.payload.pane_id === paneId);
      expect(finishes()).toHaveLength(2);
      expect(finishes().every((message) => message.payload.body === "work finished" && message.vapidValid)).toBe(true);

      // The same unknown status after an identity handoff is still ongoing work.
      await report("pi", "working", "working");
      await report("claude", "unknown", "working");
      expect(finishes()).toHaveLength(2);
      await report("claude", "idle", "done");
      await device.waitFor((message) => message.payload.pane_id === paneId && finishes().length === 3, "handoff completion push", 5_000);
      expect(finishes()).toHaveLength(3);
    } finally {
      if (bridge && cleanupDevice) await fetch(`http://127.0.0.1:${bridge.port}/api/push/subscribe`, {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: cleanupDevice.subscription.endpoint }),
      }).catch(() => undefined);
      watcher?.close();
      bridge?.stop();
      cleanupDevice?.stop();
      if (dir) rmSync(dir, { recursive: true, force: true });
      if (created) await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
      if (probe) await workspaceClose(probe.workspace.workspace_id).catch(() => undefined);
    }
  }, 40_000);

  it("alerts on the very first change after a restart, measured against herdr's snapshot", async () => {
    // A server restart must not cost the first alert: the collector seeds each pane's
    // status from its startup snapshot. Pane `watched` is already working when the new
    // server starts; pane `probe` shares the status subscription and proves it is live
    // before `watched` changes exactly once.
    const createPane = async (label: string) =>
      herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", {
        label,
        cwd: "/tmp",
        focus: false,
      });
    const watched = await createPane("herdr-web-ui-test-push-restart");
    const probe = await createPane("herdr-web-ui-test-push-probe");
    const watchedId = watched.root_pane.pane_id;
    const probeId = probe.root_pane.pane_id;
    const restartDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-restart-"));
    const device = await startFakePushService();
    let restarted: { port: number; stop: () => void } | null = null;
    let watcher: RecordingSocket | null = null;
    try {
      await herdrRpc("pane.report_agent", { pane_id: watchedId, source: "manual", agent: "claude", state: "working" });
      const before = (await herdrRpc<{ snapshot: SessionSnapshot }>("session.snapshot", {})).snapshot;
      expect(before.panes.find((pane) => pane.pane_id === watchedId)?.agent_status).toBe("working");

      restarted = createServer({ port: 0, stateDir: restartDir, alertTiming: { short: 0, long: 0, longTurn: 0 } });
      const subscribe = await fetch(`http://localhost:${restarted.port}/api/push/subscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: device.subscription }),
      });
      expect(subscribe.status).toBe(204);
      watcher = await RecordingSocket.connect(`ws://localhost:${restarted.port}/ws`);

      let live = false;
      for (let attempt = 0; attempt < 8 && !live; attempt += 1) {
        const state = attempt % 2 === 0 ? "working" : "idle";
        await herdrRpc("pane.report_agent", { pane_id: probeId, source: "manual", agent: "claude", state });
        live = await watcher
          .waitFor((m) => m.type === "pane-status" && m.pane_id === probeId && m.agent_status === state, "probe status", 2_500)
          .then(() => true)
          .catch(() => false);
      }
      expect(live).toBeTrue();

      await herdrRpc("pane.report_agent", { pane_id: watchedId, source: "manual", agent: "claude", state: "blocked" });
      await watcher.waitFor((m) => m.type === "pane-status" && m.pane_id === watchedId, "watched status", 5_000);
      const pushed = await device.waitFor((push) => push.payload.pane_id === watchedId, "first push after restart", 5_000);
      expect(pushed.payload.body).toBe("waiting for your input");
    } finally {
      watcher?.close();
      restarted?.stop();
      device.stop();
      rmSync(restartDir, { recursive: true, force: true });
      for (const created of [watched, probe]) {
        await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id }).catch(() => undefined);
      }
    }
  }, 60_000);
});

describe("pairing and identity", () => {
  /** no token: the gate is where the request comes from, who Tailscale says it is, or a paired device's cookie */
  const OWNER = "owner@example.com";
  let open: { port: number; stop: () => void };
  const openState = mkdtempSync(join(tmpdir(), "herdr-pairing-"));
  beforeAll(() => { open = createServer({ port: 0, stateDir: openState, tailscaleOwner: OWNER }); });
  afterAll(() => { open?.stop(); rmSync(openState, { recursive: true, force: true }); });
  const base = () => `http://127.0.0.1:${open.port}`;
  /** as if `tailscale serve` or a reverse proxy had forwarded it: the test client is on loopback, like a proxy */
  const proxied = (login?: string, extra: Record<string, string> = {}) => ({ "x-forwarded-for": "100.64.0.9", ...(login ? { "tailscale-user-login": login } : {}), ...extra });
  const auth = async (headers: Record<string, string> = {}) => ((await (await fetch(`${base()}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
  const guard = { "content-type": "application/json", "x-herdr-machine": "1" };
  let cookie = "";
  let deviceId = "";

  it("lets this PC in, and not a proxied request with no login while the PC's Tailscale login is known", async () => {
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
    // tailscale serve names no person for a tagged node: it pairs, even before the first device
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: proxied() })).status).toBe(401);
  });

  it("does not take a proxied request for this PC when the proxy sends no X-Forwarded-For", async () => {
    // a proxy that keeps the browser's Host, or sends only another forwarding header
    expect(await auth({ host: "app.example.test" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: { host: "app.example.test" } })).status).toBe(401);
    for (const name of ["x-forwarded-proto", "x-forwarded-host", "x-real-ip", "forwarded", "via"]) {
      expect(await auth({ [name]: "https" })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    }
    // this PC under its other names is still this PC
    for (const host of [`localhost:${open.port}`, `herdr.localhost:${open.port}`, "localhost:5173"]) {
      expect(await auth({ host })).toMatchObject({ authenticated: true, via: "local" });
    }
  });

  it("trusts the PC's own Tailscale login and refuses another", async () => {
    expect(await auth(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect(await auth(proxied("Owner@Example.com"))).toMatchObject({ authenticated: true, via: "tailscale" });
    expect(await auth(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "other_user" });
    const refused = await fetch(`${base()}/api/session`, { headers: proxied("someone@example.com") });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ApiError).error.code).toBe("other_user");
  });

  it("takes the login named in HERDR_WEB_TAILSCALE_OWNER for the PC's own, as a tagged node needs", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-named-owner-"));
    const before = process.env["HERDR_WEB_TAILSCALE_OWNER"];
    process.env["HERDR_WEB_TAILSCALE_OWNER"] = " named@example.com ";
    const named = createServer({ port: 0, stateDir: state });
    try {
      const at = async (headers: Record<string, string>) => ((await (await fetch(`http://127.0.0.1:${named.port}/api/health?scope=bridge`, { headers })).json()) as { auth: HealthAuth }).auth;
      expect(await at(proxied("named@example.com"))).toMatchObject({ authenticated: true, via: "tailscale" });
      expect(await at(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "other_user" });
      expect(await at(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    } finally {
      named.stop();
      if (before === undefined) delete process.env["HERDR_WEB_TAILSCALE_OWNER"]; else process.env["HERDR_WEB_TAILSCALE_OWNER"] = before;
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("never treats a Funnel request as open", async () => {
    expect(await auth(proxied(undefined, { "tailscale-funnel-request": "?1" }))).toMatchObject({ authenticated: false, reason: "pairing_required" });
  });

  it("pairs a device with a code from this PC, and the gate closes for strangers", async () => {
    expect((await fetch(`${base()}/api/devices/pair/start`, { method: "POST" })).status).toBe(403); // the mutation guard
    const started = await fetch(`${base()}/api/devices/pair/start`, { method: "POST", headers: guard });
    expect(started.status).toBe(200);
    const { code } = (await started.json()) as { code: string; expires_at: string };
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code: code === "000000" ? "111111" : "000000", label: "x" }) });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as ApiError).error.code).toBe("invalid_code");
    const paired = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code, label: "  Test  phone " }) });
    expect(paired.status).toBe(204);
    const setCookie = paired.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^termweave_device=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=/);
    cookie = setCookie.split(";")[0]!;
    // the device is in, from anywhere; a stranger no longer is; this PC still is
    expect(await auth({ ...proxied(), cookie })).toMatchObject({ authenticated: true, via: "device" });
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect((await fetch(`${base()}/api/session`, { headers: proxied() })).status).toBe(401);
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
    expect(await auth(proxied(OWNER))).toMatchObject({ authenticated: true, via: "tailscale" });
    const list = (await (await fetch(`${base()}/api/devices`, { headers: { ...proxied(), cookie } })).json()) as { devices: Array<{ id: string; label: string; current: boolean }> };
    expect(list.devices.map((d) => [d.label, d.current])).toEqual([["Test phone", true]]);
    deviceId = list.devices[0]!.id;
    expect(readFileSync(join(openState, "devices.json"), "utf8")).not.toContain(cookie.split("=")[1]);
  });

  it("renames and revokes a device; signing out drops its cookie", async () => {
    const renamed = await fetch(`${base()}/api/devices/${deviceId}`, { method: "PATCH", headers: guard, body: JSON.stringify({ label: "Kitchen iPad" }) });
    expect(((await renamed.json()) as { label: string }).label).toBe("Kitchen iPad");
    const out = await fetch(`${base()}/api/auth`, { method: "DELETE", headers: { cookie } });
    expect(out.headers.get("set-cookie") ?? "").toContain("termweave_device=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    expect((await fetch(`${base()}/api/devices/${deviceId}`, { method: "DELETE", headers: guard })).status).toBe(204);
    expect((await fetch(`${base()}/api/devices/${deviceId}`, { method: "DELETE", headers: guard })).status).toBe(404);
    // the revoked device is out, and so are strangers: revoking the last device never reopens the gate
    expect(await auth({ ...proxied(), cookie })).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect(await auth(proxied())).toMatchObject({ authenticated: false, reason: "pairing_required" });
    expect(await auth()).toMatchObject({ authenticated: true, via: "local" });
  });

  it("the plugin script prints a code a headless PC's owner can hand to a phone", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "herdr-pair-cli-"));
    try {
      // spawned asynchronously: a synchronous spawn would block the very server the script asks
      const pairCli = async (port: number) => {
        const child = Bun.spawn(["bun", "scripts/plugin.ts", "pair"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_WEB_TOKEN: "" }, stdout: "pipe", stderr: "pipe" });
        const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { out, err, exitCode };
      };
      const run = await pairCli(open.port);
      const out = run.out;
      expect(run.exitCode, run.err).toBe(0);
      const code = /Pairing code: (\d{3}) (\d{3})/.exec(out);
      expect(code).not.toBeNull();
      expect(out).toContain("enter the code");
      const paired = await fetch(`${base()}/api/devices/pair`, { method: "POST", headers: { ...guard, ...proxied() }, body: JSON.stringify({ code: `${code![1]}${code![2]}`, label: "Phone by CLI" }) });
      expect(paired.status).toBe(204);
      const list = (await (await fetch(`${base()}/api/devices`)).json()) as { devices: Array<{ label: string }> };
      expect(list.devices.map((d) => d.label)).toContain("Phone by CLI");
      // with a token configured, the script reads it from the plugin's .env file and gets past the gate
      const tokenState = mkdtempSync(join(tmpdir(), "herdr-pair-cli-token-"));
      const secured = createServer({ port: 0, stateDir: tokenState, token: "cli-t0k3n", tailscaleOwner: null });
      try {
        writeFileSync(join(configDir, ".env"), "HERDR_WEB_TOKEN=cli-t0k3n\n");
        const withToken = await pairCli(secured.port);
        expect(withToken.exitCode, withToken.err).toBe(0);
        expect(withToken.out).toMatch(/Pairing code: \d{3} \d{3}/);
        // `.env` wins over a stale token in the older `env` file
        writeFileSync(join(configDir, "env"), "HERDR_WEB_TOKEN=stale\n");
        const withLegacy = await pairCli(secured.port);
        expect(withLegacy.exitCode, withLegacy.err).toBe(0);
        expect(withLegacy.out).toMatch(/Pairing code: \d{3} \d{3}/);
      } finally { secured.stop(); rmSync(tokenState, { recursive: true, force: true }); }
    } finally { rmSync(configDir, { recursive: true, force: true }); }
  });

  it("a configured token gates this PC and its Tailscale login, and a paired device gets past it", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-pairing-token-"));
    const secured = createServer({ port: 0, stateDir: state, token: "t0k3n", tailscaleOwner: OWNER });
    const at = (headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${secured.port}/api/health?scope=bridge`, { headers }).then((r) => r.json() as Promise<{ auth: HealthAuth }>).then((b) => b.auth);
    try {
      expect(await at()).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at({ authorization: "Bearer t0k3n" })).toMatchObject({ authenticated: true, via: "token" });
      // another proxy on this PC can pass a visitor's copy of the login header on: the token is asked for anyway
      expect(await at(proxied(OWNER))).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at(proxied("someone@example.com"))).toMatchObject({ authenticated: false, reason: "token_required" });
      expect(await at({ ...proxied(OWNER), authorization: "Bearer t0k3n" })).toMatchObject({ authenticated: true, via: "token" });
      // health only reports the decision: the guarded routes and the upgrade must refuse the header too
      expect((await fetch(`http://127.0.0.1:${secured.port}/api/session`, { headers: proxied(OWNER) })).status).toBe(401);
      expect((await fetch(`http://127.0.0.1:${secured.port}/ws`, { headers: proxied(OWNER) })).status).toBe(401);
      // a pairing started with the token lets a device in without it
      const started = await fetch(`http://127.0.0.1:${secured.port}/api/devices/pair/start`, { method: "POST", headers: { ...guard, authorization: "Bearer t0k3n" } });
      const { code } = (await started.json()) as { code: string };
      const paired = await fetch(`http://127.0.0.1:${secured.port}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code }) });
      expect(paired.status).toBe(204);
      expect(await at({ cookie: (paired.headers.get("set-cookie") ?? "").split(";")[0]! })).toMatchObject({ authenticated: true, via: "device" });
    } finally { secured.stop(); rmSync(state, { recursive: true, force: true }); }
  });
});

describe("token auth", () => {
  /**
   * A second server with the gate ON: the default instance above stays open so the
   * rest of the suite keeps proving that an empty token changes nothing.
   */
  const TOKEN = "s3cret";
  let secured: { port: number; stop: () => void };

  beforeAll(() => {
    secured = createServer({ port: 0, token: TOKEN, stateDir });
  });

  afterAll(() => {
    secured?.stop();
  });

  const securedBase = () => `http://127.0.0.1:${secured.port}`;
  const wsUrl = () => `ws://127.0.0.1:${secured.port}/ws`;

  it("rejects an unauthenticated API call with 401 unauthorized", async () => {
    const res = await fetch(`${securedBase()}/api/session`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps web push behind the gate: a subscription receives pane titles", async () => {
    for (const [method, path] of [["GET", "/api/push"], ["POST", "/api/push/subscribe"], ["POST", "/api/push/test"]] as const) {
      const res = await fetch(`${securedBase()}${path}`, { method, body: method === "GET" ? undefined : "{}" });
      expect(res.status).toBe(401);
    }
  });

  it("keeps the image upload behind the gate", async () => {
    const res = await fetch(`${securedBase()}/api/pane/image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "w1:p1", content_type: "image/png", data_base64: "aaaa" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps /api/health public and advertises the gate state", async () => {
    const res = await fetch(`${securedBase()}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; auth: HealthAuth; herdr: { version: string; protocol: number; terminal_attach?: boolean } };
    expect(body.auth).toEqual({ required: true, authenticated: false, reason: "token_required" });
    // a Unix herdr attaches terminals; Windows PCs report false and open in the chat lens
    expect(body.herdr.terminal_attach).toBe(true);
  });

  it("refuses a token that does not match", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiError;
    expect(body.error.code).toBe("invalid_token");
  });

  it("hands back a hardened session cookie for the right token", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`termweave_token=${TOKEN}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=31536000");
  });

  it("accepts the session cookie", async () => {
    const res = await fetch(`${securedBase()}/api/session`, {
      headers: { cookie: `termweave_token=${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts a bearer token", async () => {
    const res = await fetch(`${securedBase()}/api/session`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("expires the cookie on logout", async () => {
    const res = await fetch(`${securedBase()}/api/auth`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("never upgrades a websocket without a token", async () => {
    const ws = new WebSocket(wsUrl());
    const outcome = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error/close within 5000ms")), 5000);
      const settle = (result: string) => {
        clearTimeout(timer);
        resolve(result);
      };
      ws.addEventListener("error", () => settle("error"));
      ws.addEventListener("close", () => settle("close"));
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        ws.close();
        reject(new Error("the upgrade succeeded without a token"));
      });
    });
    expect(["error", "close"]).toContain(outcome);
  }, 10000);

  it("upgrades a websocket that carries the cookie", async () => {
    const ws = connectWithCookie(wsUrl(), `termweave_token=${TOKEN}`);
    const first = await new Promise<{ type: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no message within 5000ms")), 5000);
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("the upgrade was refused despite a valid cookie"));
      });
      // a status of some pane may be broadcast before this connection's own snapshot is read
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as { type: string };
        if (message.type !== "snapshot") return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    expect(first.type).toBe("snapshot");
    ws.close();
  }, 10000);
});

describe("bind address", () => {
  let loopback: { port: number; stop: () => void };

  beforeAll(() => {
    loopback = createServer({ port: 0, hostname: "127.0.0.1", stateDir });
  });

  afterAll(() => {
    loopback?.stop();
  });

  it("serves the API on the requested hostname", async () => {
    const res = await fetch(`http://127.0.0.1:${loopback.port}/api/health`);
    expect(res.status).toBe(200);
  });
});

describe("generated wire types", () => {
  it("carries an unknown agent_status through instead of dropping or throwing", async () => {
    // herdr gives no stability guarantee: a status this build has never heard of
    // must still reach the UI so it can render something honest.
    const res = await fetch(`${base()}/api/session`);
    const { snapshot } = (await res.json()) as { snapshot: SessionSnapshot };
    const mutated: SessionSnapshot = {
      ...snapshot,
      workspaces: snapshot.workspaces.map((workspace) => ({
        ...workspace,
        agent_status: "teleporting" as AgentStatus,
      })),
    };
    const roundTripped = JSON.parse(JSON.stringify(mutated)) as SessionSnapshot;
    for (const workspace of roundTripped.workspaces) {
      expect(workspace.agent_status).toBe("teleporting");
    }
    expect(roundTripped.workspaces.length).toBe(snapshot.workspaces.length);
  });
});


describe("PC management API", () => {
  it("reports bridge auth independently of herdr and exposes the local PC", async () => {
    const health = await fetch(`${base()}/api/health?scope=bridge`);
    expect(health.status).toBe(200);
    const body = await health.json() as { auth: HealthAuth; bridge_protocol: number };
    expect(body.bridge_protocol).toBe(1);
    expect(body.auth.authenticated).toBe(true);
    const list = await fetch(`${base()}/api/machines`);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const data = await list.json() as { machines: { id: string; kind: string }[] };
    expect(data.machines[0]).toMatchObject({ id: "local", kind: "local" });
    const local = await fetch(`${base()}/api/machines/local/session`);
    expect(local.status).toBe(200);
  });
  it("rejects CSRF, malformed targets and remote forwarding outside the allowlist", async () => {
    for (const headers of [{}, { "x-herdr-machine": "1", origin: "https://evil.invalid" }, { "x-herdr-machine": "1", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const response = await fetch(`${base()}/api/machines/setup`, { method: "POST", headers, body: JSON.stringify({ destination: "host" }) });
      expect(response.status).toBe(403);
    }
    const bad = await fetch(`${base()}/api/machines/setup`, { method: "POST", headers: { "x-herdr-machine": "1" }, body: JSON.stringify({ destination: "-oProxyCommand=bad" }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base()}/api/machines/missing/pane/read?pane_id=p1`)).status).toBe(503);
    expect((await fetch(`${base()}/api/machines/missing/auth`)).status).toBe(404);
  });
  it("gates PC metadata, setup and SSE behind the existing token", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "herdr-machine-auth-"));
    const gated = createServer({ port: 0, token: "machine-test-secret", stateDir });
    try {
      for (const path of ["/api/machines", "/api/machines/events", "/api/machines/setup", "/api/bridge"]) expect((await fetch(`http://localhost:${gated.port}${path}`)).status).toBe(401);
      const health = await fetch(`http://localhost:${gated.port}/api/health?scope=bridge`).then((r) => r.json()) as { auth: HealthAuth };
      expect(health.auth).toEqual({ required: true, authenticated: false, reason: "token_required" });
    } finally { gated.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  });
});

describe("terminal lens of a bridge without the PTY sidecar", () => {
  const TOKEN = "sidecar-test-secret";
  /** what /api/health and /api/bridge tell of herdr, from a bridge whose runtime has the sidecar or lacks it */
  const told = async (sidecar: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-sidecar-"));
    const bridge = createServer({ port: 0, stateDir: dir, token: TOKEN, machines: false, sidecar });
    try {
      const get = async (path: string) => {
        const response = await fetch(`http://localhost:${bridge.port}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        expect(response.status).toBe(200);
        return (await response.json()) as { herdr: unknown };
      };
      return { health: (await get("/api/health")).herdr, bridge: (await get("/api/bridge")).herdr };
    } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
  };

  it("reports a mirror from /api/health and /api/bridge though herdr itself can attach", async () => {
    const herdr = await ping();
    // the case only means something against a herdr that can attach
    expect(herdr.terminal_attach).toBe(true);
    const mirrored = { ...herdr, terminal_attach: false, terminal_mirror: true };
    expect(await told(false)).toEqual({ health: mirrored, bridge: mirrored });
  });

  it("passes herdr's own answer through where the sidecar runs", async () => {
    const herdr = await ping();
    expect(herdr).not.toHaveProperty("terminal_mirror");
    expect(await told(true)).toEqual({ health: herdr, bridge: herdr });
  });
});

it("refuses cross-origin changes while allowing same-origin and CLI requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-origin-"));
  const instance = createServer({ port: 0, stateDir: root, token: "", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${instance.port}`;
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-origin" });
  try {
    for (const path of ["pane/input", "pane/keys", "pane/close", "workspace/create", "push/subscribe"]) {
      const response = await fetch(`${base}/api/${path}`, { method: "POST", headers: { origin: "http://other.example", "content-type": "text/plain" }, body: JSON.stringify({ pane_id: created.root_pane.pane_id, text: "must not type", keys: ["Enter"] }) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_origin" } });
    }
    for (const headers of [{ origin: base }, {}] as Record<string, string>[]) {
      const response = await fetch(`${base}/api/pane/rename`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ pane_id: created.root_pane.pane_id, label: "allowed rename" }) });
      expect(response.status).toBe(200);
    }
  } finally { instance.stop(); await workspaceClose(created.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
});
