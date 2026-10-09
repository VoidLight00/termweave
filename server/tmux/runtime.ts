import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { TmuxClient, TmuxError } from "./client.ts";
import { validTmuxName } from "./actions.ts";
import type { TmuxState } from "../../shared/tmux.ts";

/** A private server for this app. Never discovers or changes the user's default tmux server. */
export class TmuxRuntime {
  readonly binary: string | null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, binary: string | null = Bun.which("tmux")) { this.binary = binary; }

  private async location(create: boolean): Promise<string | null> {
    if (!this.binary) throw new TmuxError("tmux_missing");
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !create) return null;
      throw new TmuxError("invalid_runtime_directory");
    });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new TmuxError("runtime_directory_not_private");
    const socket = join(await realpath(this.directory), "server.sock");
    if (Buffer.byteLength(socket) > 100) throw new TmuxError("socket_path_too_long");
    return socket;
  }

  private clientFor(socket: string): TmuxClient { return new TmuxClient({ binary: this.binary!, approvedSockets: [socket] }); }
  async client(socket: string): Promise<TmuxClient> {
    if (socket !== await this.location(false)) throw new TmuxError("socket_not_approved");
    return this.clientFor(socket);
  }

  async state(): Promise<TmuxState | null> {
    const socket = await this.location(false);
    if (!socket) return null;
    try { return await this.clientFor(socket).snapshot(socket); }
    catch (error) {
      if (error instanceof TmuxError && ["missing_socket", "server_unavailable"].includes(error.code)) return null;
      throw error;
    }
  }

  async create(name: string): Promise<TmuxState> {
    if (!validTmuxName(name)) throw new TmuxError("invalid_session_name");
    const run = this.queue.catch(() => {}).then(async () => {
      const socket = (await this.location(true))!;
      const existing = await this.state();
      // argv only. The managed server starts with tmux defaults, not an unrelated global config.
      const args = [this.binary!, "-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", name, "-x", "120", "-y", "40"];
      if (!existing) args.push(";", "set-option", "-g", "exit-unattached", "off", ";", "set-option", "-g", "mouse", "on",
        ";", "set-option", "-g", "pane-border-status", "top", ";", "set-option", "-g", "pane-border-format", " #{pane_index} · #{pane_id} ");
      const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined, HERDR_WEB_TOKEN: undefined, HERDR_BRIDGE_TOKEN: undefined } });
      const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
      const [, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).finally(() => clearTimeout(timer));
      if (code !== 0) throw new TmuxError("create_failed_or_uncertain");
      return this.clientFor(socket).snapshot(socket);
    });
    this.queue = run;
    return run;
  }
}
