import { describe, expect, it } from "bun:test";

import { agentDisplayLabel, composerMessage, terminalOnlyCommand, composerPayload, composerStatusWord, contextLeftPercent, formatTokens, imageMention, insertMention, MAX_COMPOSER_CHARS, QUEUE_READY_STATUS, rankSlashCommands, submitNote } from "./compose.ts";

describe("composerMessage and submitNote", () => {
  it("keeps the message as written for agent.prompt: inner newlines stay, the composer's own trailing ones go", () => {
    expect(composerMessage("line one\r\nline two\n\n")).toBe("line one\nline two");
  });

  it("says why a message did not go, and never claims a lost one was sent", () => {
    expect(submitNote("agent_blocked", "x")).toBe("Not sent: the agent is waiting for an answer in the terminal. Answer it first.");
    expect(submitNote("read_only", "x")).toBe("Not sent: this view only watches the pane.");
    expect(submitNote("submit_timeout", "x")).toMatch(/^Not sent: .*nothing was typed/);
    expect(submitNote("disconnected", "x")).toMatch(/^Not confirmed: .*Check the terminal/);
    expect(submitNote("pane_not_found", "pane w1:p9 not found")).toBe("Not sent: pane w1:p9 not found");
  });
});

describe("composerPayload", () => {
  it("bracketed mode wraps the text as one paste, without the submit", () => {
    expect(composerPayload("hello", true)).toBe("\u001b[200~hello\u001b[201~");
  });

  it("bracketed mode keeps inner newlines literal to the TUI input box", () => {
    expect(composerPayload("line one\nline two", true)).toBe("\u001b[200~line one\rline two\u001b[201~");
  });

  it("normalizes CRLF and lone CR to the pty newline CR", () => {
    expect(composerPayload("a\r\nb\rc", true)).toBe("\u001b[200~a\rb\rc\u001b[201~");
  });

  it("drops trailing newlines: the submit CR belongs to the composer, not the text", () => {
    expect(composerPayload("cmd\n\n", true)).toBe("\u001b[200~cmd\u001b[201~");
    expect(composerPayload("cmd\n\n", false)).toBe("cmd");
  });

  it("plain mode uses classic paste semantics: every newline submits its own line", () => {
    expect(composerPayload("git status\ngit diff", false)).toBe("git status\rgit diff");
  });

  it("plain mode sends a single line; the submit CR goes on its own", () => {
    expect(composerPayload("git status", false)).toBe("git status");
  });

  it("empty text types nothing; its submit still goes on its own", () => {
    expect(composerPayload("", true)).toBe("\u001b[200~\u001b[201~");
    expect(composerPayload("", false)).toBe("");
  });

  it("caps what one send can carry", () => {
    expect(MAX_COMPOSER_CHARS).toBeLessThanOrEqual(20_000);
    expect(composerPayload("x".repeat(MAX_COMPOSER_CHARS), false)).toHaveLength(MAX_COMPOSER_CHARS);
  });
});

describe("imageMention", () => {
  it("references the stored file as an editable @path with a trailing space", () => {
    expect(imageMention("/tmp/proj/.herdr-web-ui/paste-1.png")).toBe(
      "@/tmp/proj/.herdr-web-ui/paste-1.png ",
    );
  });
});

describe("insertMention", () => {
  const mention = imageMention("/tmp/p.png");

  it("separates a mention from the word before the caret (#120)", () => {
    expect(insertMention("test.", 5, 5, mention)).toEqual({ text: "test. @/tmp/p.png ", caret: 18 });
  });

  it("adds no space in an empty composer or after whitespace", () => {
    expect(insertMention("", 0, 0, mention)).toEqual({ text: "@/tmp/p.png ", caret: 12 });
    expect(insertMention("test. ", 6, 6, mention).text).toBe("test. @/tmp/p.png ");
    expect(insertMention("test.\n", 6, 6, mention).text).toBe("test.\n@/tmp/p.png ");
  });

  it("looks at the text before the selection, and replaces the selection", () => {
    expect(insertMention("see this here", 4, 8, mention)).toEqual({ text: "see @/tmp/p.png  here", caret: 16 });
    expect(insertMention("ab", 1, 1, mention)).toEqual({ text: "a @/tmp/p.png b", caret: 14 });
  });

  it("cuts the insertion to what still fits", () => {
    const full = "x".repeat(MAX_COMPOSER_CHARS - 3);
    expect(insertMention(full, full.length, full.length, mention)).toEqual({
      text: `${full} @/`,
      caret: MAX_COMPOSER_CHARS,
    });
  });
});

describe("composer presentation helpers", () => {
  it("holds queued messages while the agent needs an approval or answer", () => {
    expect(QUEUE_READY_STATUS.blocked).not.toBe(true);
    expect(QUEUE_READY_STATUS.working).not.toBe(true);
    expect(QUEUE_READY_STATUS.unknown).not.toBe(true);
    expect(QUEUE_READY_STATUS.done).toBe(true);
    expect(QUEUE_READY_STATUS.idle).toBe(true);
  });
  it("maps agent states to compact status words", () => {
    expect(composerStatusWord("idle")).toBe("READY");
    expect(composerStatusWord("working")).toBe("RUN");
    expect(composerStatusWord("blocked")).toBe("INPUT");
    expect(composerStatusWord("done")).toBe("DONE");
    expect(composerStatusWord("paused")).toBe("READY");
  });

  it("turns machine agent ids into labels", () => {
    expect(agentDisplayLabel("claude")).toBe("Claude");
    expect(agentDisplayLabel("open_code")).toBe("Open Code");
    expect(agentDisplayLabel(null)).toBe("Shell");
  });

  it("filters slash commands by prefix and ranks frequent selections first", () => {
    const commands = [
      { name: "status", description: "Show status", source: "builtin" as const },
      { name: "start", description: "Start work", source: "project" as const },
      { name: "stop", description: "Stop work", source: "user" as const },
    ];
    expect(rankSlashCommands(commands, "st", { stop: 4, status: 2 })).toEqual([
      commands[2]!,
      commands[0]!,
      commands[1]!,
    ]);
  });
});

describe("context left", () => {
  it("reads tokens and what is left the short way", () => {
    expect([950, 67_723, 435_404, 1_000_000, 1_250_000].map(formatTokens)).toEqual(["950", "68k", "435k", "1M", "1.3M"]);
    expect(contextLeftPercent({ used: 67_723, window: 258_400 })).toBe(74);
    expect(contextLeftPercent({ used: 300_000, window: 258_400 })).toBe(0);
    expect(contextLeftPercent({ used: 67_723, window: null })).toBeNull();
  });
});

// /tree moves the session's branch and opens the agent's tree browser, which the chat reads as
// nothing at all: no card, and the pane still looks done while the terminal waits for arrow keys.
// The composer says so before the send, because after it the browser is already open and the reader
// is already in the state the note describes
describe("commands the chat cannot finish", () => {
  it("names /tree where the agent has it", () => {
    expect(terminalOnlyCommand("pi", "/tree")).toBe("tree");
    expect(terminalOnlyCommand("pi", "  /TREE  ")).toBe("tree");
    expect(terminalOnlyCommand("pi", "/tree w13:p2")).toBe("tree"); // takes no argument, but a stray
    // one is still the same command typed and the reader still needs telling
    // omp's own docs describe the same command, the same navigator and the same three branch-summary
    // choices, so the chat cannot show its browser either
    expect(terminalOnlyCommand("omp", "/tree")).toBe("tree");
  });

  it("stays quiet about everything else", () => {
    expect(terminalOnlyCommand("pi", "/fork")).toBeNull();
    expect(terminalOnlyCommand("pi", "/compact")).toBeNull();
    // a message that merely mentions or begins like it: /treemap is not /tree, and prose that only
    // names the command is not a command
    expect(terminalOnlyCommand("pi", "/treemap")).toBeNull();
    expect(terminalOnlyCommand("pi", "use /tree to switch branches")).toBeNull();
    expect(terminalOnlyCommand("pi", "tree")).toBeNull();
    expect(terminalOnlyCommand("pi", "//tree")).toBeNull();
    // an agent with no evidence of the command gets no note: telling a Claude reader about a tree
    // browser Claude does not have is its own kind of wrong
    expect(terminalOnlyCommand("claude", "/tree")).toBeNull();
    expect(terminalOnlyCommand("codex", "/tree")).toBeNull();
    expect(terminalOnlyCommand(null, "/tree")).toBeNull();
  });
});
