import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { herdrSocketPath, sessionSnapshot } from "../server/herdr/client.ts";
import { assertPrivateFile, canonicalProject, defaultOwnershipStateDir, OwnershipError, PaneMeshOwnership,
  protectOwnershipState, verifyTaskOwner, type TaskOwner, type TaskScope, type VerifiedTaskOwner } from "../server/pane-mesh-ownership.ts";

const knownTerminals = new Map<string, TaskOwner>();

/** Native metadata only. No pane.read, output scraping, message transport, or shell commands. */
export async function resolveHerdrTaskOwner(explicit?: TaskOwner): Promise<VerifiedTaskOwner> {
  if (process.platform === "win32") throw new OwnershipError("native_server_identity_unavailable");
  const configuredSocket = herdrSocketPath();
  const socket = join(realpathSync(dirname(configuredSocket)), basename(configuredSocket));
  const serverKey = () => {
    const info = lstatSync(socket);
    if (!info.isSocket() || (process.getuid && info.uid !== process.getuid())) throw new OwnershipError("unknown_identity");
    return JSON.stringify([socket, info.dev, info.ino, info.birthtimeMs, info.ctimeMs]);
  };
  const before = serverKey();
  const paneId = explicit?.paneId ?? process.env.HERDR_PANE_ID;
  const workspaceId = explicit?.workspaceId ?? process.env.HERDR_WORKSPACE_ID;
  if (!paneId || !workspaceId) throw new OwnershipError("unknown_identity");
  const routingKey = JSON.stringify([before, workspaceId, paneId]);
  explicit = explicit ?? knownTerminals.get(routingKey);
  const snapshot = await sessionSnapshot(socket);
  if (serverKey() !== before) throw new OwnershipError("unknown_identity");
  const candidates = snapshot.panes.filter((pane) => explicit
    ? pane.terminal_id === explicit.terminalId && JSON.stringify(pane.agent_session) === JSON.stringify(explicit.agentSession)
    : pane.pane_id === paneId && pane.workspace_id === workspaceId);
  const pane = candidates.length === 1 ? candidates[0] : undefined;
  if (!pane?.agent_session) throw new OwnershipError("unknown_identity");
  const owner: TaskOwner = { backend: "herdr", serverId: before, workspaceId: pane.workspace_id,
    tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id, agentSession: pane.agent_session };
  const same = (candidate: TaskOwner) => JSON.stringify([candidate.backend, candidate.serverId,
    candidate.terminalId, candidate.agentSession]) === JSON.stringify([owner.backend,
    owner.serverId, owner.terminalId, owner.agentSession]);
  if (explicit && !same(explicit)) throw new OwnershipError("unknown_identity");
  const result = await verifyTaskOwner(owner, same);
  knownTerminals.set(routingKey, result);
  return result;
}

function parse(args: readonly string[]): { action: string; options: Record<string, string>; scopes: TaskScope[] } {
  const [action = "", ...rest] = args;
  let options: Record<string, string> = {};
  let scopes: TaskScope[] = [];
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]; const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new OwnershipError("invalid_arguments");
    if (key === "--file" || key === "--directory") scopes = [...scopes, { kind: key === "--file" ? "file" : "directory", path: value }];
    else {
      if (!["--project", "--task", "--state-dir", "--identity-file", "--ttl-ms"].includes(key) || options[key] !== undefined) throw new OwnershipError("invalid_arguments");
      options = { ...options, [key]: value };
    }
  }
  if (!["claim", "heartbeat", "complete", "release", "list"].includes(action) || !options["--project"] || (action !== "list" && !options["--task"])) throw new OwnershipError("invalid_arguments");
  if (action !== "claim" && scopes.length) throw new OwnershipError("invalid_arguments");
  return { action, options, scopes };
}
export async function runTaskCli(args: readonly string[]): Promise<void> {
  const { action, options, scopes } = parse(args);
  const projectRoot = canonicalProject(options["--project"]!);
  const directory = protectOwnershipState(options["--state-dir"] ?? defaultOwnershipStateDir());
  // Explicit identities are not trusted just because a flag says 'verified'. Current adapter checks them live.
  const identityFile = options["--identity-file"];
  if (identityFile) assertPrivateFile(identityFile);
  let explicit = identityFile ? JSON.parse(readFileSync(identityFile, "utf8")) as TaskOwner : undefined;
  if (!explicit && ["heartbeat", "complete", "release"].includes(action)) {
    const lookup = new PaneMeshOwnership({ stateDir: directory });
    let currentOwner: TaskOwner | undefined;
    try { currentOwner = lookup.list(projectRoot).find((record) => record.taskId === options["--task"])?.owner; }
    finally { lookup.close(); }
    const stableKey = (candidate: TaskOwner) => JSON.stringify([candidate.backend, candidate.serverId, candidate.terminalId,
      candidate.agentSession.agent, candidate.agentSession.kind, candidate.agentSession.source, candidate.agentSession.value]);
    const matching = readdirSync(directory).filter((name) => name.endsWith(".claim.json")).map((name) => {
      const path = join(directory, name); assertPrivateFile(path);
      return JSON.parse(readFileSync(path, "utf8")) as { projectRoot?: string; taskId?: string; owner?: TaskOwner };
    }).filter((receipt) => receipt.projectRoot === projectRoot && receipt.taskId === options["--task"] &&
      receipt.owner?.paneId === process.env.HERDR_PANE_ID && receipt.owner?.workspaceId === process.env.HERDR_WORKSPACE_ID &&
      receipt.owner !== undefined && currentOwner !== undefined && stableKey(receipt.owner) === stableKey(currentOwner));
    if (matching.length !== 1 || !matching[0]?.owner) throw new OwnershipError("unknown_identity");
    explicit = matching[0].owner;
  }
  const owner = await resolveHerdrTaskOwner(explicit);
  const store = new PaneMeshOwnership({ stateDir: directory });
  try {
    if (action === "list") { process.stdout.write(`${JSON.stringify(store.list(projectRoot))}\n`); return; }
    const taskId = options["--task"]!;
    const ttlMs = options["--ttl-ms"] === undefined ? undefined : Number(options["--ttl-ms"]);
    const hash = createHash("sha256").update(JSON.stringify([projectRoot, taskId, owner.backend, owner.serverId,
      owner.terminalId, owner.agentSession.agent, owner.agentSession.kind, owner.agentSession.source, owner.agentSession.value])).digest("hex");
    const receipt = join(directory, `${hash}.claim.json`);
    if (action === "claim") {
      // An existing receipt can belong to a previous release. It must still be private.
      try { assertPrivateFile(receipt); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const claim = store.claim({ projectRoot, taskId, owner, scopes, ttlMs });
      try { writeFileSync(receipt, JSON.stringify({ token: claim.token, owner, projectRoot, taskId }), { mode: 0o600, flag: "w" }); }
      catch (error) { store.mutate("release", { projectRoot, taskId, owner, token: claim.token }); throw error; }
      process.stdout.write(`${JSON.stringify(claim.record)}\n`);
    } else {
      assertPrivateFile(receipt);
      const { token } = JSON.parse(readFileSync(receipt, "utf8")) as { token: string };
      process.stdout.write(`${JSON.stringify(store.mutate(action as "heartbeat" | "complete" | "release", { projectRoot, taskId, owner, token, ttlMs }))}\n`);
    }
  } finally { store.close(); }
}
if (import.meta.main) {
  try { await runTaskCli(process.argv.slice(2)); }
  catch (error) {
    // Never include native responses, user data, tokens, or raw exceptions in CLI diagnostics.
    process.stderr.write(`pane-mesh-task: ${error instanceof OwnershipError ? error.code : "operation_failed"}\n`);
    process.exitCode = 1;
  }
}
