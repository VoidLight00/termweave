import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, claudeTranscriptFile, forgetClaudeSessions } from "./claude-store.ts";

const SESSION = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";

describe("claudeProjectDir", () => {
  it("encodes a cwd the way Claude Code names its project", () => {
    expect(claudeProjectDir("/home/u/project")).toBe("-home-u-project"); // leakscan:allow: test fixture
    expect(claudeProjectDir("/home/u/Development/test.com")).toBe("-home-u-Development-test-com"); // leakscan:allow: test fixture
    expect(claudeProjectDir("/home/u/my_project")).toBe("-home-u-my-project"); // leakscan:allow: test fixture
    expect(claudeProjectDir("/home/u/.dotfiles")).toBe("-home-u--dotfiles"); // leakscan:allow: test fixture
    expect(claudeProjectDir("/home/u/문서/app")).toBe("-home-u----app"); // leakscan:allow: test fixture
    expect(claudeProjectDir("/home/u/My Project")).toBe("-home-u-My-Project"); // leakscan:allow: test fixture
  });

  it("cuts a name past 200 characters and adds the hash of the whole path", () => {
    const cwd = `/home/u/${"deep/".repeat(45)}project`; // leakscan:allow: test fixture
    expect(claudeProjectDir(cwd)).toBe(`${"-home-u-" + "deep-".repeat(38)}de-5cuwtt`);
    expect(claudeProjectDir(cwd).length).toBe(207);
  });
});

describe("claudeTranscriptFile", () => {
  const roots: string[] = [];
  afterEach(() => { forgetClaudeSessions(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function home(): { home: string; projects: string } {
    const home = mkdtempSync(join(tmpdir(), "herdr-claude-store-"));
    roots.push(home);
    const projects = join(home, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    return { home, projects };
  }
  function transcript(projects: string, project: string): string {
    mkdirSync(join(projects, project), { recursive: true });
    const path = join(projects, project, `${SESSION}.jsonl`);
    writeFileSync(path, "{}\n");
    return path;
  }

  it("finds a session under a cwd with a dot, an underscore, a space or Korean", async () => {
    for (const cwd of ["/w/example.com", "/w/my_project", "/w/My Project", "/w/문서/app", "/w/.dotfiles"]) {
      const { home: dir, projects } = home();
      const path = transcript(projects, claudeProjectDir(cwd));
      expect(await claudeTranscriptFile(dir, SESSION, [cwd])).toBe(path);
    }
  });

  it("tries each cwd in turn, then finds the session in whichever project holds it", async () => {
    const { home: dir, projects } = home();
    const started = transcript(projects, claudeProjectDir("/w/started-here"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on", null, "/w/started-here"])).toBe(started);
    // neither cwd names the project (Claude started elsewhere, or named it another way)
    renameSync(join(projects, claudeProjectDir("/w/started-here")), join(projects, "-some-other-name"));
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on"])).toBe(join(projects, "-some-other-name", `${SESSION}.jsonl`));
    // a remembered file that has gone is looked up again, not answered
    rmSync(join(projects, "-some-other-name"), { recursive: true });
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/moved-on"])).toBeNull();
  });

  it("keeps a session found by a scan to the store it was found in", async () => {
    const first = home(), second = home();
    transcript(first.projects, "-elsewhere");
    expect(await claudeTranscriptFile(first.home, SESSION, ["/w/project"])).toBe(join(first.projects, "-elsewhere", `${SESSION}.jsonl`));
    expect(await claudeTranscriptFile(second.home, SESSION, ["/w/project"])).toBeNull();
  });

  it("reports a store it cannot read instead of calling the transcript missing", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const { home: dir, projects } = home();
    chmodSync(projects, 0o000);
    try { await expect(claudeTranscriptFile(dir, SESSION, [])).rejects.toThrow(); }
    finally { chmodSync(projects, 0o700); }
    // an unreadable project beside the one holding the session: the session is still found
    const hit = transcript(projects, "-readable");
    mkdirSync(join(projects, "-locked"));
    chmodSync(join(projects, "-locked"), 0o000);
    try { expect(await claudeTranscriptFile(dir, SESSION, [])).toBe(hit); }
    finally { chmodSync(join(projects, "-locked"), 0o700); }
    // and without a hit, the unreadable project is reported, not called missing
    forgetClaudeSessions();
    rmSync(hit);
    chmodSync(join(projects, "-locked"), 0o000);
    try { await expect(claudeTranscriptFile(dir, SESSION, [])).rejects.toThrow(); }
    finally { chmodSync(join(projects, "-locked"), 0o700); }
  });

  it("answers null without a projects store or a file for the session", async () => {
    const { home: dir } = home();
    expect(await claudeTranscriptFile(dir, SESSION, ["/w/project"])).toBeNull();
    expect(await claudeTranscriptFile(join(dir, "missing"), SESSION, ["/w/project"])).toBeNull();
  });
});
