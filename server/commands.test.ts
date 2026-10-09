import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneCommands } from "./commands.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("paneCommands", () => {
  it("returns sorted built-ins for supported agents and none for unknown agents", () => {
    const claude = paneCommands("claude", null, temp("commands-home-"));
    expect(claude.some((command) => command.name === "clear" && command.source === "builtin")).toBeTrue();
    expect(claude.map((command) => command.name)).toEqual([...claude.map((command) => command.name)].sort());
    expect(paneCommands("unknown", "/tmp")).toEqual([]);
    expect(paneCommands(null, "/tmp")).toEqual([]);
  });

  it("loads user and nested project Claude commands with descriptions", () => {
    const home = temp("commands-home-");
    const cwd = temp("commands-project-");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    mkdirSync(join(cwd, ".claude", "commands", "team"), { recursive: true });
    writeFileSync(join(home, ".claude", "commands", "deploy.md"), "---\ndescription: Deploy safely\n---\nignored body\n");
    writeFileSync(join(cwd, ".claude", "commands", "team", "review.md"), "\nReview this project thoroughly\nMore detail");

    const commands = paneCommands("claude", cwd, home);
    expect(commands).toContainEqual({ name: "deploy", description: "Deploy safely", source: "user" });
    expect(commands).toContainEqual({ name: "team:review", description: "Review this project thoroughly", source: "project" });
  });
});

describe("skills and plugins", () => {
  const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

  it("offers Claude's skills, user and project, and the enabled plugins' skills and commands", () => {
    const home = temp("skills-home-");
    const cwd = temp("skills-cwd-");
    write(join(home, ".claude", "skills", "patina", "SKILL.md"), "---\nname: patina\ndescription: Rewrite AI prose\n---\n");
    write(join(home, ".claude", "skills", "notes", "README.md"), "no SKILL.md: not a skill");
    write(join(cwd, ".claude", "skills", "deploy", "SKILL.md"), "---\ndescription: Ship it\n---\n");
    const plugin = join(home, ".claude", "plugins", "cache", "market", "hud", "1.0.0");
    write(join(plugin, "skills", "setup", "SKILL.md"), "---\nname: setup\ndescription: Configure the HUD\n---\n");
    write(join(plugin, "commands", "configure.md"), "---\ndescription: Configure options\n---\n");
    const off = join(home, ".claude", "plugins", "cache", "market", "off", "1.0.0");
    write(join(off, "skills", "hidden", "SKILL.md"), "---\nname: hidden\n---\n");
    write(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "hud@market": [{ installPath: plugin }], "off@market": [{ installPath: off }] } }));
    write(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "hud@market": true, "off@market": false } }));
    const extra = paneCommands("claude", cwd, home).filter((command) => command.source === "skill" || command.source === "plugin");
    expect(extra).toEqual([
      { name: "deploy", description: "Ship it", source: "skill" },
      { name: "hud:configure", description: "Configure options", source: "plugin" },
      { name: "hud:setup", description: "Configure the HUD", source: "plugin" },
      { name: "patina", description: "Rewrite AI prose", source: "skill" },
    ]);
  });

  it("offers Codex's saved prompts as /prompts:<name> and its skills with $", () => {
    const home = temp("codex-home-");
    write(join(home, ".codex", "prompts", "review.md"), "Review the diff\n");
    write(join(home, ".codex", "skills", "deepinit", "SKILL.md"), "---\nname: deepinit\ndescription: Deep codebase initialization\n---\n");
    const extra = paneCommands("codex", null, home).filter((command) => command.source !== "builtin");
    expect(extra).toEqual([
      { name: "deepinit", description: "Deep codebase initialization", source: "skill", trigger: "$" },
      { name: "prompts:review", description: "Review the diff", source: "user" },
    ]);
  });
});

// Measured against pi 0.87.1: its `/` palette (the built-ins and their wording), and what a
// headless `get_commands` reports for resources planted in each folder pi reads.
describe("pi's slash commands", () => {
  const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
  const skill = (root: string, name: string, description: string) => put(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);

  it("offers pi's own built-ins, in pi's words", () => {
    const commands = paneCommands("pi", null, temp("pi-empty-home-"));
    expect(commands.map((command) => command.name)).toContain("compact");
    // /tree is offered by pi itself but not by the chat, the way omp's list omits it: the command
    // opens pi's tree browser, which the chat reads as nothing at all — no card, pane looks idle —
    // so offering it invites a reader into a state only the terminal lens can leave
    expect(commands.map((command) => command.name)).not.toContain("tree");
    // its own verbs, not the omp/codex wording shared by the rest
    expect(commands).toContainEqual({ name: "quit", description: "Quit pi", source: "builtin" });
    expect(commands.map((command) => command.name)).not.toContain("sessions");
    expect(commands.every((command) => command.source === "builtin")).toBeTrue();
  });

  it("offers the templates and skills pi loads from the person's own folders", () => {
    const home = temp("pi-home-");
    put(join(home, ".pi", "agent", "prompts", "review.md"), "---\ndescription: Review staged git changes\n---\nbody\n");
    put(join(home, ".pi", "agent", "prompts", "plain.md"), "First line wins when there is no frontmatter\n");
    skill(join(home, ".pi", "agent", "skills"), "pdf-tools", "Extract text from PDFs");
    skill(join(home, ".agents", "skills"), "from-agents", "Found under ~/.agents");

    const extra = paneCommands("pi", null, home).filter((command) => command.source !== "builtin");
    expect(extra).toEqual([
      { name: "plain", description: "First line wins when there is no frontmatter", source: "user" },
      { name: "review", description: "Review staged git changes", source: "user" },
      // a skill is a command under skill:, which is how pi names it and how it must be typed
      { name: "skill:from-agents", description: "Found under ~/.agents", source: "skill" },
      { name: "skill:pdf-tools", description: "Extract text from PDFs", source: "skill" },
    ]);
  });

  it("offers a template reached through a symbolic link", () => {
    // pi reads a prompt directory with readdir + stat, so a link to a .md file is a file to it and
    // the command is loaded. `entry.isFile()` on the directory entry asks the link itself, which
    // answers false, and the chat silently hid a command the agent would run — the common way to
    // keep one review prompt shared between a dotfiles repo and an agent dir
    const home = temp("pi-home-");
    const elsewhere = temp("pi-shared-");
    put(join(elsewhere, "review.md"), "---\ndescription: Review staged git changes\n---\nbody\n");
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
    symlinkSync(join(elsewhere, "review.md"), join(home, ".pi", "agent", "prompts", "review.md"));
    const commands = paneCommands("pi", null, home).filter((command) => command.source === "user");
    expect(commands).toEqual([{ name: "review", description: "Review staged git changes", source: "user" }]);
  });

  it("skips a prompt link that resolves to nothing or to a folder", () => {
    // a broken link is skipped by pi too (its stat throws), and a folder is not a template: a
    // conventional prompt directory loads its direct .md children and nothing below one, so
    // following a link to a folder would offer commands pi never loads
    const home = temp("pi-home-");
    const elsewhere = temp("pi-shared-");
    put(join(elsewhere, "deep.md"), "---\ndescription: nested under a linked folder\n---\n");
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });
    symlinkSync(join(elsewhere, "gone.md"), join(home, ".pi", "agent", "prompts", "broken.md"));
    // named .md so the name test alone cannot pass it: only the stat knows it is a folder
    symlinkSync(elsewhere, join(home, ".pi", "agent", "prompts", "folder.md"));
    symlinkSync(join(elsewhere, "deep.md"), join(home, ".pi", "agent", "prompts", "ok.md"));
    const names = paneCommands("pi", null, home).filter((command) => command.source === "user").map((command) => command.name);
    expect(names).toEqual(["ok"]);
  });

  it("reads no deeper than pi does in a prompt directory", () => {
    const home = temp("pi-home-");
    put(join(home, ".pi", "agent", "prompts", "top.md"), "---\ndescription: a direct child\n---\n");
    // pi loads direct .md children of a conventional prompt directory and nothing below one
    put(join(home, ".pi", "agent", "prompts", "sub", "deep.md"), "---\ndescription: a nested one\n---\n");
    const names = paneCommands("pi", null, home).filter((command) => command.source === "user").map((command) => command.name);
    expect(names).toEqual(["top"]);
  });

  it("holds a project's own commands back, since pi gates them behind trust", () => {
    const home = temp("pi-home-");
    const cwd = temp("pi-project-");
    put(join(cwd, ".pi", "prompts", "proj-template.md"), "---\ndescription: a project template\n---\n");
    skill(join(cwd, ".pi", "skills"), "proj-skill", "A project skill");
    // offered only where pi would run them, and which folder pi calls the project is its own
    // decision behind ~/.pi/agent/trust.json: a listed command the agent refuses is worse than
    // one missing from the menu, so a project's resources stay in the terminal's menu
    const commands = paneCommands("pi", cwd, home);
    expect(commands.some((command) => command.source === "project")).toBeFalse();
    expect(commands.map((command) => command.name)).not.toContain("proj-template");
    expect(commands.map((command) => command.name)).not.toContain("skill:proj-skill");
  });

  it("leaves a folder with no pi resources at its built-ins", () => {
    expect(paneCommands("pi", temp("pi-cwd-"), temp("pi-home-")).every((command) => command.source === "builtin")).toBeTrue();
  });
});
