import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { piAgentDir } from "./pi-models.ts";
import { join, relative, sep } from "node:path";

import type { SlashCommand } from "../shared/protocol.ts";

const BUILTINS: Record<string, readonly string[]> = {
  claude: ["clear", "compact", "config", "cost", "help", "init", "memory", "model", "permissions", "review", "status", "doctor", "login", "logout", "pr-comments", "release-notes", "terminal-setup", "vim"],
  omp: ["help", "clear", "compact", "model", "new", "sessions", "exit"],
  codex: ["clear", "compact", "diff", "help", "model", "new", "quit", "review", "status"],
  // pi 0.87.1, as its own palette lists them, less /tree — the way omp's list curates its own
  // commands. The chat reads pi's tree browser as nothing at all: no card, and the pane still looks
  // idle while the terminal waits for arrow keys. Offering the one command that opens it from the
  // chat would walk a reader into a state only the terminal lens can leave. Navigating stays in the
  // terminal; the chat's place is the abandoned-turns marker, which says where a /tree left off
  pi: ["settings", "model", "thinking", "scoped-models", "login", "logout", "llama", "new", "resume", "name", "session", "fork", "clone", "compact", "import", "copy", "export", "share", "bug", "trust", "reload", "hotkeys", "changelog", "quit"],
};

/** pi states what each command opens or does, in its own words, read off its palette. */
const PI_DESCRIPTIONS: Record<string, string> = {
  settings: "Open settings menu", model: "<provider/model> — Select model", thinking: "<level> — Set thinking level",
  "scoped-models": "Enable/disable models for Ctrl+P cycling", login: "<provider> — Configure provider authentication",
  logout: "Remove provider authentication", llama: "[t] Manage llama.cpp router models", new: "Start a new session",
  resume: "Resume a different session", name: "Set session display name", session: "Show session info and stats",
  fork: "Create a new fork from a previous user message",
  clone: "Duplicate the current session at the current position", compact: "Manually compact the session context",
  import: "Import and resume a session from a JSONL file", copy: "Copy last agent message to clipboard",
  export: "Export session (HTML default, or specify path: .html/.jsonl)", share: "Share session as a secret GitHub gist",
  bug: "<description> — Report a bug to the Pi developers", trust: "Save project trust decision for future sessions",
  reload: "Reload keybindings, extensions, skills, prompts, themes, and context files", hotkeys: "Show all keyboard shortcuts",
  changelog: "Show changelog entries", quit: "Quit pi",
};

const DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation", compact: "Compact conversation context", config: "Open configuration",
  cost: "Show token usage and cost", help: "Show available commands", init: "Initialize project instructions",
  memory: "Edit agent memory", model: "Choose a model", permissions: "Manage tool permissions", review: "Review changes",
  status: "Show session status", doctor: "Check the installation", login: "Sign in", logout: "Sign out",
  "pr-comments": "Fetch pull request comments", "release-notes": "Show release notes", "terminal-setup": "Configure terminal integration",
  vim: "Toggle Vim mode", new: "Start a new session", sessions: "List sessions", exit: "Exit the agent",
  diff: "Show the current diff", quit: "Exit the agent",
};

function description(markdown: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (frontmatter) {
    const found = frontmatter[1]?.match(/^description:\s*(.+?)\s*$/m)?.[1]?.trim();
    if (found) return found.replace(/^(["'])(.*)\1$/, "$2").slice(0, 120);
  }
  const body = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  return (body.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "").slice(0, 120);
}

/** `name:` from a SKILL.md's frontmatter, else its directory's name. */
function skillName(markdown: string, directory: string): string {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  const named = frontmatter?.[1]?.match(/^name:\s*(.+?)\s*$/m)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return named && /^[\p{L}\p{N}_:-]+$/u.test(named) ? named : directory;
}

/** Skills under a root: one directory each, with a SKILL.md; `prefix` names a plugin's. */
function skills(root: string, source: SlashCommand["source"], options: { prefix?: string; trigger?: "$" } = {}): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = join(root, entry.name, "SKILL.md");
    if (!existsSync(file)) continue;
    let markdown: string;
    try { markdown = readFileSync(file, "utf8"); } catch { continue; }
    const name = skillName(markdown, entry.name);
    result.push({ name: options.prefix ? `${options.prefix}:${name}` : name, description: description(markdown), source, ...(options.trigger ? { trigger: options.trigger } : {}) });
  }
  return result;
}

/**
 * The skills and commands of the Claude plugins turned on in settings.json, as Claude
 * offers them: `/<plugin>:<name>`.
 */
function pluginCommands(home: string): SlashCommand[] {
  const read = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
  const enabled = (read(join(home, ".claude", "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  const installed = (read(join(home, ".claude", "plugins", "installed_plugins.json")) as { plugins?: Record<string, Array<{ installPath?: unknown }>> } | null)?.plugins ?? {};
  const result: SlashCommand[] = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const installPath = installed[id]?.[0]?.installPath;
    if (typeof installPath !== "string") continue;
    const plugin = id.split("@")[0]!;
    result.push(...skills(join(installPath, "skills"), "plugin", { prefix: plugin }));
    result.push(...customCommands(join(installPath, "commands"), "plugin").map((command) => ({ ...command, name: `${plugin}:${command.name}` })));
  }
  return result;
}

function customCommands(root: string, source: SlashCommand["source"]): SlashCommand[] {  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const relativeName = relative(root, path).slice(0, -3).split(sep).join(":");
        result.push({ name: relativeName, description: description(readFileSync(path, "utf8")), source });
      }
    }
  };
  visit(root);
  return result;
}

/**
 * Templates are commands. A conventional prompt directory holds direct `.md` children only —
 * pi reads no deeper there, so recursing would offer commands pi never loads.
 *
 * A link is asked of what it points at, not of itself: pi stats the entry, so a `.md` reached
 * through a symlink is a template it loads, and a directory is not one however the link is named.
 */
function piTemplates(root: string, source: SlashCommand["source"]): SlashCommand[] {
  if (!existsSync(root)) return [];
  const result: SlashCommand[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let markdown: string;
    try {
      // the target is what gets read, so the target is what gets asked: a broken link throws here
      // and is skipped, as pi skips it, and a link to a folder fails isFile however it is named.
      // One path for links and plain files alike — the stat costs less than the read that follows
      // and keeps the two from being judged by different rules
      const target = join(root, entry.name);
      if (!statSync(target).isFile()) continue;
      markdown = readFileSync(target, "utf8");
    } catch {
      continue;
    }
    result.push({ name: entry.name.slice(0, -3), description: description(markdown), source });
  }
  return result;
}

export function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, home = process.env.HOME ?? ""): SlashCommand[] {
  if (!agent || !(agent in BUILTINS)) return [];
  const commands: SlashCommand[] = (BUILTINS[agent] ?? []).map((name) => ({ name, description: (agent === "pi" ? PI_DESCRIPTIONS[name] : undefined) ?? DESCRIPTIONS[name] ?? `Run /${name}`, source: "builtin" }));
  if (agent === "claude") {
    commands.push(...customCommands(join(home, ".claude", "commands"), "user"));
    if (cwd) commands.push(...customCommands(join(cwd, ".claude", "commands"), "project"));
    commands.push(...skills(join(home, ".claude", "skills"), "skill"));
    if (cwd) commands.push(...skills(join(cwd, ".claude", "skills"), "skill"));
    commands.push(...pluginCommands(home));
  }
  if (agent === "pi") {
    // Only what pi loads from the person's own folders, which it loads whether or not the
    // folder's project is trusted: the agent directory and ~/.agents. A project's own skills
    // and prompts are left out on purpose — pi gates them behind a trust decision and a
    // project root of its own choosing, and offering a command the agent will not run is worse
    // than offering one fewer command. Neither are pi's packages and extension commands, which
    // no file scan can know: they are in the terminal's own `/` menu either way.
    // PI_CODING_AGENT_DIR moves the agent directory, as it does for pi's sessions and models
    const agentDir = process.env["PI_CODING_AGENT_DIR"] ? piAgentDir() : join(home, ".pi", "agent");
    commands.push(...piTemplates(join(agentDir, "prompts"), "user"));
    commands.push(...skills(join(agentDir, "skills"), "skill", { prefix: "skill" }));
    commands.push(...skills(join(home, ".agents", "skills"), "skill", { prefix: "skill" }));
  }
  if (agent === "codex") {
    // Codex's saved prompts run as /prompts:<name>; its skills are named with `$`
    commands.push(...customCommands(join(home, ".codex", "prompts"), "user").map((command) => ({ ...command, name: `prompts:${command.name}` })));
    commands.push(...skills(join(home, ".codex", "skills"), "skill", { trigger: "$" }));
    if (cwd) commands.push(...skills(join(cwd, ".codex", "skills"), "skill", { trigger: "$" }));
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}
