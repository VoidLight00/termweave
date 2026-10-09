import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { piAbandonedTurns, piBranchSegments, piEntryIndex } from "./pi-tree.ts";
import { transcriptPage, transcriptToolOutput } from "./conversation.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-pi-tree-"));
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** pi writes one entry per line: an id, a parentId, and whatever the type carries. */
const entry = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) => ({ id, parentId, timestamp: "2026-09-30T00:00:00.000Z", ...extra });
const user = (id: string, parentId: string | null, text: string) => entry(id, parentId, { type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string | null, text: string) => entry(id, parentId, { type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });

let counter = 0;
const file = (entries: unknown[]) => {
  const path = join(root, `session-${++counter}.jsonl`);
  writeFileSync(path, entries.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
};
/** What the chat shows, across every page: the conversation is what a reader can reach. */
const shown = (path: string) => {
  const turns: string[] = [];
  let page = transcriptPage("pi-transcript" as never, path);
  let guard = 0;
  for (;;) {
    for (const turn of page.turns) {
      const text = turn.parts.find((part) => part.kind === "text");
      if (text?.kind === "text") turns.push(`${turn.role}:${text.text}`);
    }
    if (typeof page.cursor !== "string" || guard++ > 40) break;
    page = transcriptPage("pi-transcript" as never, path, { before: page.cursor });
  }
  return turns;
};
const branchOf = (path: string) => piBranchSegments(path, statSync(path).size);

describe("pi's entry tree", () => {
  it("reads a straight line as the whole file", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "first"),
      assistant("a1", "u1", "answer one"),
      user("u2", "a1", "second"),
      assistant("a2", "u2", "answer two"),
    ]);
    expect(branchOf(path)).toEqual([{ start: 0, end: statSync(path).size }]);
    expect(shown(path)).toEqual(["user:first", "assistant:answer one", "user:second", "assistant:answer two"]);
  });

  it("shows only the branch the leaf stands on after /tree", () => {
    // two answers branched from one prompt: pi keeps both in the file, runs the last one
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", "s", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    const branch = branchOf(path)!;
    // ranges merge when consecutive, so this is [session] then [u2, a-live]: u1 and
    // a-gone sit between the session and the branch and are read by neither
    expect(branch).toHaveLength(2);
    expect(shown(path)).toEqual(["user:the retried question", "assistant:the answer in play"]);
    expect(shown(path).join(" ")).not.toContain("abandoned");
    expect(shown(path).join(" ")).not.toContain("the question");
  });

  it("moves the conversation when a /tree branch is appended, and invalidates the page", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "question"),
      assistant("a1", "u1", "first answer"),
    ]);
    const before = transcriptPage("pi-transcript" as never, path);
    expect(shown(path)).toEqual(["user:question", "assistant:first answer"]);
    // the leaf moves back to the prompt and a new answer is written beside the old one
    appendFileSync(path, JSON.stringify(assistant("a2", "u1", "second answer")) + "\n");
    const after = transcriptPage("pi-transcript" as never, path);
    expect(after.history_id).not.toBe(before.history_id); // same file, same inode: only the tree knows
    expect(shown(path)).toEqual(["user:question", "assistant:second answer"]);
    // a cursor held from the branch that was navigated away from cannot page the new one
    expect(() => transcriptPage("pi-transcript" as never, path, { before: before.cursor! })).toThrow();
  });

  it("keeps history_id stable while a branch only grows", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "question"),
    ]);
    const first = transcriptPage("pi-transcript" as never, path);
    appendFileSync(path, JSON.stringify(assistant("a1", "u1", "answer")) + "\n");
    expect(transcriptPage("pi-transcript" as never, path).history_id).toBe(first.history_id);
  });

  it("tells two /tree moves apart when their branches share every range but the last", () => {
    // one file, the leaf moved twice. Both states read the merged head plus one tail that
    // starts at a different byte; only that start separates them, and the tail's end is
    // what grows with appends, so the layout counts starts and non-final ends.
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "question"),
      assistant("a1", "u1", "the answer first written"),
    ]);
    appendFileSync(path, JSON.stringify(assistant("a2", "u1", "the second")) + "\n");
    const second = transcriptPage("pi-transcript" as never, path);
    expect(shown(path)).toEqual(["user:question", "assistant:the second"]);
    // /tree back to the prompt again, and a third answer beside the other two
    appendFileSync(path, JSON.stringify(assistant("a3", "u1", "the third")) + "\n");
    const third = transcriptPage("pi-transcript" as never, path);
    expect(shown(path)).toEqual(["user:question", "assistant:the third"]);
    expect(third.history_id).not.toBe(second.history_id);
    // the page held from the branch that was navigated away from no longer pages this one
    expect(() => transcriptPage("pi-transcript" as never, path, { before: second.cursor! })).toThrow();
  });

  it("indexes an append without rereading what it already scanned", () => {
    const path = file([entry("s", null, { type: "session", version: 3, id: "s", cwd: root }), user("u1", "s", "one")]);
    const first = piEntryIndex(path)!;
    const scanned = first.scanned;
    appendFileSync(path, JSON.stringify(assistant("a1", "u1", "two")) + "\n");
    const next = piEntryIndex(path)!;
    expect(next).toBe(first); // the same index, extended
    expect(next.scanned).toBeGreaterThan(scanned);
    expect(next.entries.map((e) => e.id)).toEqual(["s", "u1", "a1"]);
  });

  it("starts over when the file is rewritten or cut, so a stale tree cannot be read", () => {
    const path = file([entry("s", null, { type: "session", version: 3, id: "s", cwd: root }), user("u1", "s", "one"), assistant("a1", "u1", "two")]);
    piEntryIndex(path);
    truncateSync(path, 60);
    const index = piEntryIndex(path)!;
    expect(index.entries.length).toBeLessThan(3);
  });

  it("stops at a parent it cannot find instead of inventing the head of the branch", () => {
    const path = file([user("u2", "missing-parent", "a turn whose parent never appears"), assistant("a2", "u2", "answer")]);
    expect(branchOf(path)).toHaveLength(1); // u2 and a2, merged; nothing above the unknown id
    expect(shown(path)).toEqual(["user:a turn whose parent never appears", "assistant:answer"]);
  });

  it("ignores the header and entries without an id, and keeps the last of a repeated id", () => {
    const path = file([
      { type: "session", version: 3, id: "s", cwd: root }, // no parentId: not a node
      user("u1", null, "only prompt"),
      assistant("u1", "u1", "an id reused"),
    ]);
    const branch = branchOf(path)!;
    expect(branch).toHaveLength(1); // the repeat wins, and its parent is itself: the walk stops
    expect(piEntryIndex(path)!.entries.map((e) => e.id)).toEqual(["s", "u1", "u1"]); // indexed twice, resolved once
  });

  it("holds nothing to show for an empty file", () => {
    expect(piBranchSegments(join(root, "never-written.jsonl"), 0)).toBeNull();
    const empty = join(root, "empty.jsonl");
    writeFileSync(empty, "");
    expect(piBranchSegments(empty, 0)).toBeNull();
  });

  it("reads a tool's output along the branch, and never one a /tree left behind", () => {
    const call = (id: string, parentId: string, callId: string) => entry(id, parentId, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse" } });
    const result = (id: string, parentId: string, callId: string, text: string) => entry(id, parentId, { type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }] } });
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "list the files"),
      call("a1", "u1", "call-1"),
      result("r1", "a1", "call-1", "the first output, kept"),
      assistant("a2", "r1", "the answer in play"),
      // a question, then a /tree back to a2 that drops it and its tool call
      user("u2", "a2", "the question a /tree dropped"),
      call("a3", "u2", "call-2"),
      result("r2", "a3", "call-2", "the output a /tree dropped"),
      user("u3", "a2", "what about the other folder"),
      call("a4", "u3", "call-3"),
      result("r3", "a4", "call-3", "the newest output"),
    ]);
    // the leaf is r3: s, u1, a1, r1, a2, u3, a4, r3. u2 and its call never appear.
    expect(shown(path)).toEqual(["user:list the files", "assistant:the answer in play", "user:what about the other folder"]);
    expect(transcriptToolOutput("pi-transcript" as never, path, "call-1")).toBe("the first output, kept");
    expect(transcriptToolOutput("pi-transcript" as never, path, "call-3")).toBe("the newest output");
    // the dropped call's output stays unreachable: the chat never showed that call
    expect(transcriptToolOutput("pi-transcript" as never, path, "call-2")).toBeNull();
  });
});

// pi keeps the leaf pointer in memory only: `branch()` moves it and writes nothing, and no entry
// type names the leaf. So the branch a reader can rebuild is the one ending at the last entry
// written, and everything else in the file is a path pi walked away from. Those turns are hidden
// from the chat and vanish without a trace, which is what the count below is for.
describe("pi's abandoned paths", () => {
  it("finds nothing abandoned in a straight line, and says so rather than staying silent", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "first"),
      assistant("a1", "u1", "answer one"),
    ]);
    // zero and unreadable are different answers: one is every session no /tree touched, the other
    // is a tree this reader cannot vouch for, and only the second is worth warning about
    expect(piAbandonedTurns(path, statSync(path).size)).toEqual({ count: 0, branches: 0, summary: null });
  });

  it("names the branch a turn was abandoned into", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", "s", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    // one place you navigated away from, holding two turns: the label has to say "a branch" and
    // not "branches", which a count of turns alone cannot tell it
    expect(piAbandonedTurns(path, statSync(path).size)).toEqual({ count: 2, branches: 1, summary: null });
  });

  it("counts the branches separately from the turns they hold", () => {
    // two abandoned paths of different lengths: 1281 turns somewhere and a 2-turn dead end read
    // nothing alike, and a label that only knows the turn count calls both "a branch"
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "asked"),
      assistant("a1", "u1", "answer one"),
      user("u2", "s", "asked again"),
      assistant("a2", "u2", "answer two"),
      user("u3", "s", "third try"),
      assistant("a3", "u3", "answer three"),
    ]);
    const abandoned = piAbandonedTurns(path, statSync(path).size);
    expect(abandoned?.branches).toBe(2); // u1's path and u2's path, both left behind by u3's
    expect(abandoned?.count).toBe(4); // and the head they share is still counted once
  });

  it("counts the turns a branch left behind, on both sides of the live path", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", "s", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    // u1 and a-gone are not ancestors of a-live; pi keeps them, the chat shows only the branch
    expect(piAbandonedTurns(path, statSync(path).size)).toEqual({ count: 2, branches: 1, summary: null });
  });

  it("does not mistake pi's session header for a branch you navigated away from", () => {
    // every real pi file opens with a session entry no other entry names as its parent, and an entry
    // that has never had a child is nowhere the pointer was moved away from. Counting heads of
    // abandoned paths, rather than live entries with abandoned children, reports it as a branch in
    // every session there has ever been, and the label then says that to the reader
    const path = file([
      entry("session", null, { type: "session", version: 3, cwd: root }), // orphan: nothing links to it
      entry("m1", null, { type: "model_change", provider: "p", modelId: "m" }),
      user("u1", "m1", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", "m1", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    expect(piAbandonedTurns(path, statSync(path).size)).toEqual({ count: 2, branches: 1, summary: null });
  });

  it("never counts turns without a branch to count them on", () => {
    // the label names a branch whenever it holds turns, so a count with no branch behind it would
    // say "a branch" while the reader counted none. A path whose parent id never appears is damaged
    // rather than branched: piBranchSegments calls a walk it cannot complete "not invented", and
    // the same reader stays quiet about turns it cannot place on a path instead of naming one
    const orphaned = file([
      entry("s", null, { type: "session", version: 3, cwd: root }),
      user("u1", "MISSING", "the question"), // its parent never appears in the file
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", "s", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    expect(piAbandonedTurns(orphaned, statSync(orphaned).size)).toEqual({ count: 0, branches: 0, summary: null });
    // a real branch beside a detached one is still reported, and only its own turns are counted
    const both = file([
      entry("s", null, { type: "session", version: 3, cwd: root }),
      user("u1", "MISSING", "detached question"),
      assistant("a-detached", "u1", "detached answer"),
      user("u2", "s", "the question"),
      assistant("a-gone", "u2", "the abandoned answer"),
      user("u3", "s", "the retried question"),
      assistant("a-live", "u3", "the answer in play"),
    ]);
    expect(piAbandonedTurns(both, statSync(both).size)).toEqual({ count: 2, branches: 1, summary: null });
  });

  it("counts no branch in a file with no links to walk", () => {
    // an append-only journal of the same record shape — every entry parentless — has no branch in it
    // to have navigated away from. Treating its last line as the leaf would call every earlier turn
    // abandoned: three turns on a branch the file never had, the exact false sentence this reader
    // exists not to say. Zeros, not null: the tree walked fine, it simply holds no branches
    const journal = file([
      entry("s", null, { type: "session", version: 3, cwd: root }),
      user("u1", null, "one"),
      assistant("a1", null, "two"),
      user("u2", null, "three"),
      assistant("a2", null, "four"),
    ]);
    expect(piAbandonedTurns(journal, statSync(journal).size)).toEqual({ count: 0, branches: 0, summary: null });
  });

  it("counts a path abandoned at the root itself", () => {
    // pi keeps its leaf id separate from the file's start, and navigating the tree to the very
    // first entry clears it (resetLeaf), so the next entry is written with no parent and starts a
    // second path beside the first. Excluding every parentless entry, to keep pi's session header
    // out, threw this case away with it: the abandoned path and its turns both vanished, and a
    // reader who had navigated to the root was told nothing about what they left behind
    const atRoot = file([
      entry("s", null, { type: "session", version: 3, cwd: root }),
      user("u1", null, "the first question"), // a path that begins at the root
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", null, "the question asked from the root"), // pi's leaf was cleared to null
      assistant("a-live", "u2", "the answer in play"),
    ]);
    expect(piAbandonedTurns(atRoot, statSync(atRoot).size)).toEqual({ count: 2, branches: 1, summary: null });
  });

  it("counts a turn once however many branches it was abandoned into", () => {
    // three moves away from the same prompt: the head they share is not counted three times
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "asked"),
      assistant("a1", "u1", "answer one"),
      user("u2", "s", "asked again"),
      assistant("a2", "u2", "answer two"),
      user("u3", "s", "third try"),
      assistant("a3", "u3", "answer three"),
    ]);
    expect(piAbandonedTurns(path, statSync(path).size)).toEqual({ count: 4, branches: 2, summary: null });
  });

  it("carries pi's own summary of the abandoned path when the user asked for one", () => {
    // /tree asks "Summarize branch?"; answering Summarize writes a branch_summary on the new branch
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      entry("bs", "s", { type: "branch_summary", fromId: "a-gone", summary: "We tried the first question and it failed." }),
      user("u2", "bs", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    const result = piAbandonedTurns(path, statSync(path).size);
    expect(result?.count).toBe(2);
    expect(result?.branches).toBe(1); // the summary sits on the live branch, so it is not one itself
    expect(result?.summary).toBe("We tried the first question and it failed.");
  });

  it("says nothing rather than guess at a tree it cannot walk", () => {
    // a torn tail and a file shorter than the index both answer through the same guard
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "first"),
    ]);
    expect(piAbandonedTurns(path, 0)).toBeNull();
    expect(piAbandonedTurns("/nonexistent/session.jsonl", 10)).toBeNull();
  });

  it("leaves entries that are not turns out of the count", () => {
    // model changes and usage sit among the rows and are never turns the chat showed
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      entry("m1", "u1", { type: "model_change", provider: "p", modelId: "m" }),
      assistant("a-gone", "m1", "the abandoned answer"),
      user("u2", "s", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    expect(piAbandonedTurns(path, statSync(path).size)).toEqual({ count: 2, branches: 1, summary: null });
  });
});

// The count only helps if the route carries it: the chat cannot see bytes it is not sent, and a
// branch's page is built from the live ranges alone.
describe("the abandoned count on the page", () => {
  const page = (path: string) => transcriptPage("pi-transcript" as never, path);

  it("names the turns no page of the conversation can reach", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", "s", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    // shown by the chat, and hidden but counted: the two together are the file
    expect(shown(path)).toEqual(["user:the retried question", "assistant:the answer in play"]);
    expect(page(path).abandoned).toEqual({ count: 2, branches: 1, summary: null });
  });

  it("says nothing for a session no /tree touched", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "first"),
      assistant("a1", "u1", "answer one"),
    ]);
    expect(page(path).abandoned).toEqual({ count: 0, branches: 0, summary: null });
  });

  it("carries pi's summary when the user answered /tree with one", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      entry("bs", "s", { type: "branch_summary", fromId: "a-gone", summary: "Tried the first question; it failed." }),
      user("u2", "bs", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    expect(page(path).abandoned?.summary).toBe("Tried the first question; it failed.");
  });

  it("stays out of the way for an agent with no entry tree", () => {
    const path = file([
      entry("s", null, { type: "session", version: 3, id: "s", cwd: root }),
      user("u1", "s", "the question"),
      assistant("a-gone", "u1", "the abandoned answer"),
      user("u2", "s", "the retried question"),
      assistant("a-live", "u2", "the answer in play"),
    ]);
    // omp reads the same shape of file but has no /tree: no count is offered for its transcript
    const omp = transcriptPage("omp-transcript" as never, path);
    expect(omp.abandoned).toBeUndefined();
  });
});

describe("pi's entry index on awkward files", () => {
  const session = entry("s", null, { type: "session", version: 3, id: "s", cwd: root });

  it("indexes the entries around a record longer than several read chunks", () => {
    // a picture a tool read sits in its record as base64: one line of many megabytes
    const picture = entry("t1", "u1", { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] } });
    const path = file([session, user("u1", "s", "first"), picture, assistant("a1", "t1", "after the picture")]);
    const index = piEntryIndex(path)!;
    expect(index.entries.map((item) => item.id)).toEqual(["s", "u1", "t1", "a1"]);
    expect(index.entries[2]!.end - index.entries[2]!.start).toBeGreaterThan(9 * 1024 * 1024);
    expect(index.entries[3]!.start).toBe(index.entries[2]!.end);
    expect(index.entries[3]!.end).toBe(statSync(path).size);
  });

  it("starts over when another file takes the path, even one of the same size that ends the same", () => {
    const path = file([session, user("u1", "s", "one"), assistant("a1", "u1", "the same closing answer, longer than the bytes the tail check reads")]);
    expect(piEntryIndex(path)!.entries.map((item) => item.id)).toEqual(["s", "u1", "a1"]);
    // an import or a restore: other entries, the same length, the same last bytes
    const replacement = file([session, user("u2", "s", "two"), assistant("a1", "u1", "the same closing answer, longer than the bytes the tail check reads")]);
    expect(statSync(replacement).size).toBe(statSync(path).size);
    renameSync(replacement, path);
    expect(piEntryIndex(path)!.entries.map((item) => item.id)).toEqual(["s", "u2", "a1"]);
  });
});
