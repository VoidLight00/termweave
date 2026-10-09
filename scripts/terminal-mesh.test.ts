import { expect, test, spyOn } from "bun:test";
import { PaneDirectory, terminalKey, type TerminalTarget } from "../server/pane-directory.ts";
import { terminalMesh, reference } from "./terminal-mesh.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("CLI has no automatic socket discovery and rejects unexpected/duplicate flags", async () => {
  const root = await mkdtemp("/tmp/tw-cli-contract-");
  const file = join(root, "allowlist.json");
  await writeFile(file, JSON.stringify({ tmuxSockets: [], herdrSockets: [] }));
  const run = async (args: string[]) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "terminal-mesh.ts"), ...args], {
      env: { ...process.env, HERDR_SOCKET: "/must-not-be-used.sock", TMUX: "/must-not-be-used.sock,1,0", TERMWEAVE_TMUX_SOCKETS: '["/must-not-be-used.sock"]' },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };
  try {
    expect(await run(["list", "--allowlist", file])).toEqual({ out: '{"terminals":[]}\n', err: "", code: 0 });
    expect((await run(["list"])).code).toBe(1);
    expect((await run(["list", "--allowlist", file, "--allowlist", file])).code).toBe(1);
    expect((await run(["list", "--allowlist", file, "--production", "true"])).code).toBe(1);
    expect((await run(["read", "--allowlist", file])).code).toBe(1);
    expect((await run(["send", "--allowlist", file])).code).toBe(1);
    expect((await run(["unknown", "--allowlist", file])).code).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI immutable reference refuses completed pane-address replacement and follows native moves", async () => {
  const root = await mkdtemp("/tmp/tw-cli-ref-");
  const file = join(root, "allow.json");
  const config = { tmuxSockets: [], herdrSockets: ["/fixture/herdr.sock"] };
  await writeFile(file, JSON.stringify(config));
  const generation = "a".repeat(64);
  const old: TerminalTarget = { backend: "herdr", socket: "/fixture/herdr.sock", generation, terminalId: "terminal-A", address: { paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" } };
  const replacement = { ...old, terminalId: "terminal-B" };
  const moved = { ...old, address: { paneId: "w2:p9", workspaceId: "w2", tabId: "w2:t1" } };
  const stableRef = `${reference(old, config)}@${generation}`;
  let delivered: readonly TerminalTarget[] = [];
  const listing = spyOn(PaneDirectory.prototype, "list").mockResolvedValue([replacement]);
  const sending = spyOn(PaneDirectory.prototype, "send").mockImplementation(async (target, _text, options) => {
    expect(options.recipientKey).toBe(terminalKey(target));
    delivered = [...delivered, target];
  });
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await expect(terminalMesh(["send", "--allowlist", file, "--ref", `herdr/server1/w1%3Ap1@${generation}`, "--text", "message"])).rejects.toThrow("recipient_missing_or_ambiguous");
    await expect(terminalMesh(["send", "--allowlist", file, "--ref", stableRef, "--text", "message"])).rejects.toThrow("recipient_missing_or_ambiguous");
    expect(delivered).toHaveLength(0);
    listing.mockResolvedValue([moved, replacement]);
    expect(reference(moved, config)).toBe(reference(old, config));
    await terminalMesh(["send", "--allowlist", file, "--ref", stableRef, "--text", "message"]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.terminalId).toBe("terminal-A");
    expect(delivered[0]!.address.paneId).toBe("w2:p9");
    expect(stdout.mock.calls.at(-1)?.[0]).toContain("agent receipt and completion not confirmed");
    listing.mockResolvedValue([{ ...moved, generation: "b".repeat(64) }]);
    await expect(terminalMesh(["send", "--allowlist", file, "--ref", stableRef, "--text", "stale"])).rejects.toThrow("recipient_missing_or_ambiguous");
    expect(delivered).toHaveLength(1);
  } finally { listing.mockRestore(); sending.mockRestore(); stdout.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test("CLI private handles preserve original recipient and reject aliases/malformed refs", async () => {
  const root = await mkdtemp("/tmp/tw-cli-handles-");
  const file = join(root, "allow.json"), handles = join(root, "handles.json");
  const config = { tmuxSockets: [], herdrSockets: ["/fixture/herdr.sock"], aliases: { "/fixture/herdr.sock": "local" } };
  await writeFile(file, JSON.stringify(config));
  const old: TerminalTarget = { backend: "herdr", socket: "/fixture/herdr.sock", generation: "a".repeat(64), terminalId: "terminal-A", address: { paneId: "w1:p1" } };
  const ref = reference(old, config);
  const listing = spyOn(PaneDirectory.prototype, "list").mockResolvedValue([old]);
  const sending = spyOn(PaneDirectory.prototype, "send").mockResolvedValue();
  const reading = spyOn(PaneDirectory.prototype, "read").mockResolvedValue("owned fixture");
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await terminalMesh(["list", "--allowlist", file, "--handles", handles]);
    const output = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(output.terminals[0].ref).toBe("herdr/local/terminal-A");
    listing.mockResolvedValue([{ ...old, terminalId: "terminal-B" }]);
    await terminalMesh(["send", "--allowlist", file, "--handle", handles, "--ref", ref, "--text", "message"]);
    expect(sending.mock.calls[0]![0].terminalId).toBe("terminal-A");
    await terminalMesh(["read", "--allowlist", file, "--handle", handles, "--ref", ref]);
    expect(reading.mock.calls[0]![0].terminalId).toBe("terminal-A");
    for (const bad of ["pane 1", "herdr/local/w1%3Ap1", ref, `${ref}@bad`, "herdr/other/terminal-A@" + old.generation]) {
      await expect(terminalMesh(["send", "--allowlist", file, "--ref", bad, "--text", "message"])).rejects.toThrow("recipient_missing_or_ambiguous");
    }
    await writeFile(file, JSON.stringify({ tmuxSockets: [], herdrSockets: ["/fixture/a.sock", "/fixture/b.sock"], aliases: { "/fixture/a.sock": "same", "/fixture/b.sock": "same" } }));
    await expect(terminalMesh(["send", "--allowlist", file, "--ref", ref, "--text", "message"])).rejects.toThrow("ambiguous_server_alias");
    expect(sending.mock.calls).toHaveLength(1);
  } finally { listing.mockRestore(); sending.mockRestore(); reading.mockRestore(); stdout.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
