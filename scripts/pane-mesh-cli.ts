#!/usr/bin/env bun
import { TmuxClient, TmuxError, type TmuxTarget } from "../server/tmux/client.ts";

/** Explicit socket and full target only. No production discovery or implicit submission. */
export async function main(args: readonly string[]): Promise<void> {
  const [command, socket, ...rest] = args;
  if (!socket || !["list", "read", "send"].includes(command ?? "")) throw new TmuxError("usage_list_read_send");
  let approvedSockets: string[];
  try {
    const parsed: unknown = JSON.parse(process.env.TERMWEAVE_TMUX_SOCKETS ?? "[]");
    if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) throw new Error();
    approvedSockets = parsed as string[];
  } catch { throw new TmuxError("invalid_socket_allowlist"); }
  const client = new TmuxClient({ approvedSockets });
  if (command === "list") {
    if (rest.length) throw new TmuxError("unexpected_arguments");
    process.stdout.write(`${JSON.stringify(await client.list(socket))}\n`);
    return;
  }
  const [generation, paneId, ...options] = rest;
  if (!generation || !paneId) throw new TmuxError("full_target_required");
  const target: TmuxTarget = { socket, generation, paneId };
  if (command === "read") {
    if (options.length && (options.length !== 2 || options[0] !== "--lines")) throw new TmuxError("invalid_options");
    process.stdout.write(await client.read(target, options.length ? Number(options[1]) : 80));
    return;
  }
  const submit = options[0] === "--submit";
  const literal = submit ? options.slice(1) : options;
  if (literal.length !== 2 || literal[0] !== "--") throw new TmuxError("send_requires_literal_separator");
  await client.send(target, literal[1]!, submit);
  process.stdout.write("Input delivered; agent receipt and task completion are not confirmed.\n");
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof TmuxError ? error.message : "tmux adapter failed"}\n`);
    process.exitCode = 1;
  });
}
