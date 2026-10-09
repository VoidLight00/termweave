import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { PaneDirectory, DirectoryError, terminalKey, type DirectoryAllowlist, type TerminalTarget } from "../server/pane-directory.ts";

type Config = DirectoryAllowlist & { aliases?: Record<string, string> };
export function reference(target: TerminalTarget, config: Config): string {
  const paths = target.backend === "tmux" ? config.tmuxSockets : config.herdrSockets;
  const alias = config.aliases?.[target.socket] ?? `server${paths.indexOf(target.socket) + 1}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) throw new DirectoryError("invalid_server_alias");
  return `${target.backend}/${alias}/${encodeURIComponent(target.terminalId)}`;
}
async function saveHandles(path: string, terminals: readonly TerminalTarget[], config: Config): Promise<void> {
  // Never overwrite a stale receipt or follow a symlink; native session refs stay private.
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, terminals: terminals.map((target) => ({ ref: reference(target, config), target })) })); }
  finally { await file.close(); }
}
async function loadHandle(path: string, ref: string): Promise<TerminalTarget> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.nlink !== 1) throw new DirectoryError("unsafe_handle_file");
    const parsed = JSON.parse(await file.readFile("utf8")) as { version: number; terminals: { ref: string; target: TerminalTarget }[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.terminals)) throw new DirectoryError("invalid_handle_file");
    const matches = parsed.terminals.filter((entry) => entry.ref === ref);
    if (matches.length !== 1) throw new DirectoryError("recipient_missing_or_ambiguous");
    terminalKey(matches[0]!.target);
    return matches[0]!.target;
  } finally { await file.close(); }
}

/**
 * list --allowlist FILE [--handles NEW_PRIVATE_FILE]
 * read/send --allowlist FILE --handle PRIVATE_FILE --ref herdr/server1/FULL_NATIVE_TERMINAL_ID
 * References pin immutable terminalId, never a reusable mutable pane address.
 * Exact fresh refs also require @FULL_GENERATION, so a server restart never retargets a send.
 * Literal mode is terminal input ONLY: no Enter, shell execution, agent receipt or completion.
 */
export async function terminalMesh(args: readonly string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!["list", "read", "send"].includes(action ?? "")) throw new DirectoryError("usage_list_read_send");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!key || !["--allowlist", "--target", "--lines", "--text", "--recipient", "--mode", "--handles", "--handle", "--ref"].includes(key) || value === undefined || flags.has(key)) throw new DirectoryError("invalid_arguments");
    flags.set(key, value);
  }
  const path = flags.get("--allowlist");
  if (!path) throw new DirectoryError("explicit_allowlist_required");
  const config = await Bun.file(path).json() as Config;
  const directory = new PaneDirectory(config);
  for (const paths of [config.tmuxSockets, config.herdrSockets]) {
    const aliases = paths.map((socket, index) => config.aliases?.[socket] ?? `server${index + 1}`);
    if (aliases.some((alias) => !/^[a-zA-Z0-9_-]+$/.test(alias)) || new Set(aliases).size !== aliases.length) throw new DirectoryError("ambiguous_server_alias");
  }
  if (action === "list") {
    if ([...flags.keys()].some((k) => !["--allowlist", "--handles"].includes(k))) throw new DirectoryError("invalid_arguments");
    const targets = await directory.list();
    if (new Set(targets.map((t) => reference(t, config))).size !== targets.length) throw new DirectoryError("ambiguous_server_alias");
    if (flags.has("--handles")) await saveHandles(flags.get("--handles")!, targets, config);
    process.stdout.write(`${JSON.stringify({ terminals: targets.map((target) => ({
      ref: reference(target, config), pinnedRef: `${reference(target, config)}@${target.generation}`,
      backend: target.backend, socket: target.socket, generation: target.generation,
      terminalId: target.terminalId, address: target.address,
      ...(target.agent ? { agent: { kind: target.agent.kind, name: target.agent.name } } : {}),
    })) })}\n`);
    return;
  }
  const allowed = ["--allowlist", "--target", "--handle", "--ref", ...(action === "read" ? ["--lines"] : ["--text", "--recipient", "--mode"])];
  if ([...flags.keys()].some((k) => !allowed.includes(k))) throw new DirectoryError("invalid_arguments");
  if (flags.has("--target") && (flags.has("--handle") || flags.has("--ref"))) throw new DirectoryError("ambiguous_target_arguments");
  let target: TerminalTarget;
  if (flags.has("--target")) target = JSON.parse(flags.get("--target")!) as TerminalTarget;
  else if (flags.has("--handle") && flags.has("--ref")) target = await loadHandle(flags.get("--handle")!, flags.get("--ref")!);
  else if (flags.has("--ref") && !flags.has("--handle")) {
    const ref = flags.get("--ref")!;
    const targets = (await directory.list()).filter((t) => `${reference(t, config)}@${t.generation}` === ref);
    if (targets.length !== 1) throw new DirectoryError("recipient_missing_or_ambiguous");
    target = targets[0]!;
  } else throw new DirectoryError("target_required");
  if (action === "read") {
    process.stdout.write(await directory.read(target, flags.has("--lines") ? Number(flags.get("--lines")) : 80));
    return;
  }
  await directory.send(target, flags.get("--text") ?? "", {
    recipientKey: flags.get("--recipient") ?? terminalKey(target),
    mode: (flags.get("--mode") ?? "literal") as "literal" | "agent-prompt",
  });
  process.stdout.write("terminal input delivered; agent receipt and completion not confirmed\n");
}
if (import.meta.main) {
  try { await terminalMesh(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof DirectoryError ? error.code : "operation_failed_or_uncertain"}\n`);
    process.exitCode = 1;
  }
}
