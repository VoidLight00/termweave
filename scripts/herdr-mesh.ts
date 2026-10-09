#!/usr/bin/env bun
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { PaneDirectory, DirectoryError, terminalKey, type TerminalTarget, type DirectoryAllowlist } from "../server/pane-directory.ts";
import { assertPrivateFile, protectOwnershipState, PaneMeshOwnership, verifyTaskOwner, canonicalProject, OwnershipError, type TaskScope } from "../server/pane-mesh-ownership.ts";
import { terminalMesh, reference } from "./terminal-mesh.ts";

type Config = DirectoryAllowlist & { aliases?: Record<string, string> };
/** Local-only entrypoint. No HTTP routes, hook installation, pane output discovery, or implicit Enter. */
export async function run(args: readonly string[]): Promise<void> {
  const [action, ...rest] = args;
  let options: Record<string, string> = {};
  let scopes: TaskScope[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!key || value === undefined || !key.startsWith("--")) throw new DirectoryError("invalid_arguments");
    if (key === "--file" || key === "--directory") scopes = [...scopes, { kind: key === "--file" ? "file" : "directory", path: value }];
    else {
      if (!["--config", "--state", "--ref", "--text", "--mode", "--lines", "--project", "--task"].includes(key) || key in options) throw new DirectoryError("invalid_arguments");
      options = { ...options, [key]: value };
    }
  }
  if (!options["--config"] || !options["--state"]) throw new DirectoryError("explicit_private_configuration_required");
  const state = protectOwnershipState(options["--state"]);
  assertPrivateFile(options["--config"]);
  const config = await Bun.file(options["--config"]).json() as Config;
  const directory = new PaneDirectory(config);
  const latest = join(state, "latest.handles.json");
  if (action === "roster") {
    if (Object.keys(options).some(key => !["--config", "--state"].includes(key)) || scopes.length) throw new DirectoryError("invalid_arguments");
    const temporary = join(state, `${randomBytes(16).toString("hex")}.handles.json`);
    try {
      // Full agent session identity is in the private receipt only; listing omits session values.
      await terminalMesh(["list", "--allowlist", options["--config"], "--handles", temporary]);
      await rename(temporary, latest);
    } finally { await unlink(temporary).catch(() => {}); }
    return;
  }
  if (!["send", "read", "claim", "heartbeat", "release", "complete", "tasks"].includes(action ?? "")) throw new DirectoryError("invalid_action");
  if (action === "send" || action === "read") {
    if (Object.keys(options).some(key => !["--config", "--state", "--ref", ...(action === "send" ? ["--text", "--mode"] : ["--lines"])].includes(key)) || scopes.length) throw new DirectoryError("invalid_arguments");
    const command = [action, "--allowlist", options["--config"], "--handle", latest, "--ref", options["--ref"] ?? ""];
    await terminalMesh([...command, ...(action === "send" ? ["--text", options["--text"] ?? "", "--mode", options["--mode"] ?? "literal"] : options["--lines"] ? ["--lines", options["--lines"]] : [])]);
    return;
  }
  if (Object.keys(options).some(key => !["--config", "--state", "--ref", "--project", "--task"].includes(key))) throw new DirectoryError("invalid_arguments");
  const project = canonicalProject(options["--project"] ?? "");
  const store = new PaneMeshOwnership({ stateDir: join(state, "ownership") });
  try {
    if (action === "tasks") {
      if (scopes.length || options["--ref"] || options["--task"]) throw new DirectoryError("invalid_arguments");
      process.stdout.write(`${JSON.stringify(store.list(project).map(({ owner, ...task }) => ({ ...task, terminalId: owner.terminalId })))}\n`);
      return;
    }
    if (action !== "claim" && scopes.length) throw new DirectoryError("invalid_arguments");
    assertPrivateFile(latest);
    const file = await open(latest, constants.O_RDONLY | constants.O_NOFOLLOW);
    let parsed: { version: number; terminals: { ref: string; target: TerminalTarget }[] };
    try { parsed = JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
    const matches = parsed.version === 1 && Array.isArray(parsed.terminals) ? parsed.terminals.filter(entry => entry.ref === options["--ref"]) : [];
    if (matches.length !== 1) throw new DirectoryError("recipient_missing_or_ambiguous");
    const target = matches[0]!.target;
    terminalKey(target);
    const current = await directory.resolve(target);
    if (current.backend !== "herdr" || !current.agent?.session || JSON.stringify(current.agent) !== JSON.stringify(target.agent)) throw new DirectoryError("agent_unidentified_or_changed");
    const owner = await verifyTaskOwner({ backend: current.backend, serverId: current.generation, terminalId: current.terminalId,
      workspaceId: current.address.workspaceId!, tabId: current.address.tabId!, paneId: current.address.paneId, agentSession: current.agent.session }, async candidate => {
      const verified = await directory.resolve(current);
      return verified.generation === candidate.serverId && verified.terminalId === candidate.terminalId && JSON.stringify(verified.agent?.session) === JSON.stringify(candidate.agentSession);
    });
    const taskId = options["--task"] ?? "";
    const key = createHash("sha256").update(JSON.stringify([project, taskId, owner.serverId, owner.terminalId, owner.agentSession])).digest("hex");
    const receipt = join(state, `${key}.claim.json`);
    let record;
    if (action === "claim") {
      const claim = store.claim({ projectRoot: project, taskId, owner, scopes });
      try {
        const temporary = join(state, `${randomBytes(16).toString("hex")}.claim.tmp`);
        const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await output.writeFile(JSON.stringify({ token: claim.token })); } finally { await output.close(); }
        await rename(temporary, receipt);
      } catch (error) { store.mutate("release", { projectRoot: project, taskId, owner, token: claim.token }); throw error; }
      record = claim.record;
    } else {
      assertPrivateFile(receipt);
      const input = await open(receipt, constants.O_RDONLY | constants.O_NOFOLLOW);
      let token: string;
      try { ({ token } = JSON.parse(await input.readFile("utf8"))); } finally { await input.close(); }
      record = store.mutate(action as "heartbeat" | "release" | "complete", { projectRoot: project, taskId, owner, token });
    }
    process.stdout.write(`${JSON.stringify({ taskId: record.taskId, status: record.status, terminalId: record.owner.terminalId, ref: reference(current, config) })}\n`);
  } finally { store.close(); }
}
if (import.meta.main) {
  try { await run(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`herdr-mesh: ${error instanceof DirectoryError || error instanceof OwnershipError ? error.code : "operation_failed_or_uncertain"}\n`); process.exitCode = 1; }
}
