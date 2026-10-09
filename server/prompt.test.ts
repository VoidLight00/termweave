import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../shared/protocol.ts";

import { answerKeys, codexQuestionsCollapsed, codexQueuedPrompt, handlePromptRequest, parseClaudeSuggestion, parseFallbackPrompt, parseInteractivePrompt, pendingOmoAsk } from "./prompt.ts";

const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);

describe("interactive prompt parsing", () => {
  test("invalidates approvals when their command changes, including text beyond the display cap", () => {
    const screen = (command: string, secondSelected = false) => `
Would you like to run the following command?
${command}
${secondSelected ? " " : "›"} 1. Yes, proceed
${secondSelected ? "›" : " "} 2. No, cancel
Press enter to confirm or esc to cancel
`;
    const first = parseInteractivePrompt("codex", screen("echo first"))!;
    expect(first).not.toBeNull();
    expect(parseInteractivePrompt("codex", screen("echo second"))!.id).not.toBe(first.id);
    expect(parseInteractivePrompt("codex", screen("echo first", true))!.id).toBe(first.id);
    const prefix = "x".repeat(12_010);
    expect(parseInteractivePrompt("codex", screen(prefix + "a"))!.id)
      .not.toBe(parseInteractivePrompt("codex", screen(prefix + "b"))!.id);
  });

  test("parses Claude questions, approvals, and plans", () => {
    const questionScreen = `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. T-LESS
     Texture-less objects.
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    const question = parseInteractivePrompt("claude", questionScreen);
    expect(question).toMatchObject({
      agent: "claude",
      kind: "question",
      // a single question is titled by its header chip
      title: "Dataset",
      question: "Which evaluation dataset should we use?",
      multi_select: false,
      custom_option_index: 3,
    });
    expect(labels(question)).toEqual(["LM-O", "YCB-V", "T-LESS"]);
    expect(question?.options[0]?.description).toBe("Occlusion benchmark.");
    expect(parseInteractivePrompt("claude", questionScreen)?.id).toBe(question?.id);

    const approval = parseInteractivePrompt("claude", `
Bash command

  curl -I https://example.com
  Fetch HTTP headers.

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don’t ask again for: curl *
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain
`);
    expect(approval?.kind).toBe("approval");
    expect(approval?.title).toBe("Fetch HTTP headers.");
    expect(labels(approval)).toEqual(["Yes", "Yes, and don’t ask again for: curl *", "No"]);

    const plan = parseInteractivePrompt("claude", `
Ready to code?

Here is Claude's plan:
Add a heading to the README file.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, refine with Ultraplan on Claude Code on the web
  4. Tell Claude what to change
     shift+tab to approve with this feedback
`);
    expect(plan).toMatchObject({ kind: "plan", title: "Ready to code?", custom_option_index: 3 });
    expect(plan?.body).toContain("Add a heading");
    expect(answerKeys(plan!, { custom_text: "Keep the existing introduction" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] },
      { text: "Keep the existing introduction" },
      { keys: ["shift+tab"] },
    ]);
  });

  test("parses omp single, multi-select, and approval prompts", () => {
    const single = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────╮
│ Which target?           │
├─────────────────────────┤
│❯ ○ Jetson Orin         │
│  ○ RK3588               │
│  ○ Other (type your own)│
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`);
    expect(single).toMatchObject({ kind: "question", question: "Which target?", custom_option_index: 2 });
    expect(labels(single)).toEqual(["Jetson Orin", "RK3588"]);

    const multi = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────╮
│ Which checks?           │
├─────────────────────────┤
│❯ ☐ Lint                │
│  ☐ Tests                │
│  ☐ Build                │
│  ☐ Other (type your own)│
├─────────────────────────┤
│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel
╰─────────────────────────╯
`);
    expect(multi).toMatchObject({ kind: "question", title: "Multiple choice", multi_select: true, custom_option_index: null });
    expect(answerKeys(multi!, { option_indices: [0, 2] })).toEqual([
      { keys: ["space"] },
      { keys: ["down"] },
      { keys: ["down"] },
      { keys: ["space"] },
      { keys: ["tab"] },
      { keys: ["enter"] },
    ]);

    const approval = parseInteractivePrompt("omp", `
╭─ Permission ────────────╮
│ Allow tool: bash        │
│ curl -I example.com     │
│❯ Approve               │
│  Deny                  │
╰─────────────────────────╯
`);
    expect(approval?.kind).toBe("approval");
    expect(labels(approval)).toEqual(["Approve", "Deny"]);
  });

  test("parses Codex continue, question, async question, and approval prompts", () => {
    const menu = parseInteractivePrompt("codex", `
✨ Update available! 0.146.0 -> 0.146.1

› 1. Update now
  2. Skip
  3. Skip until next version

Press enter to continue
`);
    expect(menu).toMatchObject({ kind: "menu", title: "Codex", question: "Choose how to continue" });
    expect(answerKeys(menu!, { option_index: 2 })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);

    const question = parseInteractivePrompt("codex", `
Question 1/1 (1 unanswered)
Which export format should we use?

› 1. ONNX               Export a portable ONNX model.
  2. TensorRT           Build an NVIDIA TensorRT engine.
  3. RKNN               Build an RKNN model.
  4. None of the above  Optionally, add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`);
    expect(question).toMatchObject({ kind: "question", custom_option_index: 3 });
    expect(labels(question)).toEqual(["ONNX", "TensorRT", "RKNN"]);
    expect(question?.options[0]?.description).toBe("Export a portable ONNX model.");

    const asyncQuestion = parseInteractivePrompt("codex", `
Which accelerator?

› 1. CUDA
  2. CPU
  3. NPU
  4. Other

enter submit   ctrl + ] skip
option 1/4   shift + → main prompt
`);
    expect(asyncQuestion).toMatchObject({ kind: "question", question: "Which accelerator?", custom_option_index: 3 });
    expect(labels(asyncQuestion)).toEqual(["CUDA", "CPU", "NPU"]);

    const approval = parseInteractivePrompt("codex", `
Would you like to run the following command?

Environment: local
$ curl -I https://example.com

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with curl
  3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`);
    expect(approval?.kind).toBe("approval");
    expect(approval?.body).toContain("curl -I");
    expect(answerKeys(approval!, { option_index: 2 })).toEqual([{ keys: ["esc"] }]);
  });

  // screens captured from Claude Code 2.1.280 and Codex 0.156.0 (paths shortened)
  test("parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers", () => {
    const first = parseInteractivePrompt("claude", `
←  ☐ Route  ☐ Author  ✔ Submit  →
Which way should the PR go?
❯ 1. Log in as owner
     Authenticate as the repository owner and open the PR directly on the repo.
  2. Fork
     Push the branch to a fork and open the PR from there.
  3. Type something.
────────────────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(first).toMatchObject({ kind: "question", title: "Route · 1 of 2", question: "Which way should the PR go?", custom_option_index: 2 });
    expect(labels(first)).toEqual(["Log in as owner", "Fork"]);

    const sets = parseInteractivePrompt("claude", `
←  ☒ Route  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
         Include the LM-O dataset.
  2. [ ] YCB-V
         Include the YCB-V dataset.
  3. [ ] T-LESS
         Include the T-LESS dataset.
  4. [ ] Type something
     Next
────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(sets).toMatchObject({ title: "Sets · 2 of 2", multi_select: true });
    // → moves on to the next tab: an enter there would pick its first option
    expect(answerKeys(sets!, { option_indices: [0, 2] })).toEqual([
      { keys: ["enter"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] },
    ]);

    const review = parseInteractivePrompt("claude", `
←  ☒ Route  ☒ Author  ✔ Submit  →
Review your answers
 ● Which way should the PR go?
   → Log in as owner
 ● Who should author the commits?
   → Repo owner
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`);
    // a menu: a typed pick submits every answer at once, so the chat asks for Confirm
    expect(review).toMatchObject({ kind: "menu", title: "Review your answers", question: "Ready to submit your answers?", custom_option_index: null });
    expect(review?.body).toContain("→ Repo owner");
    expect(labels(review)).toEqual(["Submit answers", "Cancel"]);

    const bash = parseInteractivePrompt("claude", `
● Deleting the junk directory
  ⎿  $ rm -rf junk
────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/prompt-lab/junk from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
`);
    expect(bash).toMatchObject({ kind: "approval", title: "Bash command", question: "Do you want to proceed?", body: "rm -rf junk\nDelete the junk directory" });
    expect(labels(bash)).toEqual(["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    // a narrow pane wraps a long option: its label still reads whole
    const wrapped = parseInteractivePrompt("claude", `
────────────────────────────────────────
 Bash command
   rm -rf junk
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
   /tmp/prompt-lab/junk from this project
   3. No
 Esc to cancel · Tab to amend
`);
    expect(labels(wrapped)).toEqual(["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "No"]);
    // Claude's own text opens with ● as well: a rule in its table is not the approval's panel
    const underText = parseInteractivePrompt("claude", `
● Results table follows:
────────────────────────────────────────
  run   AR
────────────────────────────────────────
  a     0.66
────────────────────────────────────────
 Bash command
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(underText).toMatchObject({ kind: "approval", title: "Bash command", body: "rm -rf junk\nDelete the junk directory" });
    // an MCP call is a call too: the first rule under it opens the panel, not a rule in its preview
    const mcp = parseInteractivePrompt("claude", `
● github - create_issue (MCP)(title: "Flaky test")
────────────────────────────────────────
 Tool use
   github - create_issue(title: "Flaky test")
────────────────────────────────────────
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(mcp).toMatchObject({ kind: "approval", title: "Tool use" });
    expect(answerKeys(bash!, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);

    const write = parseInteractivePrompt("claude", `
● Write(hello.txt)
────────────────────────────────────────
 Create file
 hello.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 hi
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create hello.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)
   3. No
 Esc to cancel · Tab to amend
`);
    expect(write).toMatchObject({ kind: "approval", title: "Create file", question: "Do you want to create hello.txt?", body: "hello.txt\n1 hi" });
  });

  test("finds Claude's question tabs over a wrapped question and a cut-off bar, and never answers the next question", () => {
    // a narrow pane: the question wraps over seven lines and the bar loses its right end
    const wrapped = parseInteractivePrompt("claude", `
────────────────────────────
←  ☒ Route  ☐ Author  ✔ Su
Who should author the
commits that go into the
pull request, given that
the fork belongs to the
lab account and the
upstream repository to
its owner?
❯ 1. Keep local
     The local git identity.
  2. Repo owner
     The repository owner.
  3. Type something.
────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(wrapped).toMatchObject({
      kind: "question", title: "Author",
      question: "Who should author the commits that go into the pull request, given that the fork belongs to the lab account and the upstream repository to its owner?",
    });
    expect(answerKeys(wrapped!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);

    // a multiple choice alone: → reaches the review of the answers, which has its own card
    const alone = parseInteractivePrompt("claude", `
←  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
  2. [ ] YCB-V
  3. [ ] T-LESS
  4. [ ] Type something
     Submit
────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(alone).toMatchObject({ title: "Sets", multi_select: true });
    expect(answerKeys(alone!, { option_indices: [1] })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] }]);
  });

  test("titles a Claude approval from its panel, not from rules in a file preview, and joins labels wrapped over lines", () => {
    const edit = parseInteractivePrompt("claude", `
● Write(notes.md)
────────────────────────────────────────
 Create file
 notes.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 # Notes
  2 ────────────────────────────────────────
  3 Results below the rule
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create notes.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits
   (auto-approve file edits and common
   file commands) for this session
   3. No
 Esc to cancel · Tab to amend
`);
    expect(edit).toMatchObject({ kind: "approval", title: "Create file", question: "Do you want to create notes.md?" });
    expect(labels(edit)).toEqual([
      "Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session", "No",
    ]);
  });

  test("parses the last of several Codex 0.156 questions and its folder trust prompt", () => {
    const last = parseInteractivePrompt("codex", `
  Question 2/2 (1 unanswered)
  Which split?
  › 1. train (Recommended)  Use the training split.
    2. test                 Use the test split.
    3. None of the above    Optionally, add details in notes (tab).
  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt
`);
    expect(last).toMatchObject({ kind: "question", title: "Question 2 of 2", question: "Which split?", custom_option_index: 2 });
    expect(labels(last)).toEqual(["train (Recommended)", "test"]);

    const trust = parseInteractivePrompt("codex", `
  Folder access
  /tmp/prompt-lab-codex
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Back to Agent Command Center
  enter continue · esc back
`);
    expect(trust).toMatchObject({ kind: "approval", title: "Trust this folder?", body: "Codex can read, edit, and run files here, subject to your permission settings." });
    expect(labels(trust)).toEqual(["Trust and continue", "Back to Agent Command Center"]);
    expect(answerKeys(trust!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
  });

  test("ignores unknown agents, stale transcript menus, and ordinary output", () => {
    expect(parseInteractivePrompt("other", "Enter to select · ↑/↓ to navigate · Esc to cancel")).toBeNull();
    expect(parseInteractivePrompt("claude", "No response requested. The task is complete.")).toBeNull();
    expect(parseInteractivePrompt("codex", `
Would you like to run the following command?
› 1. Yes, proceed
  2. No, and tell Codex what to do differently
Press enter to confirm or esc to cancel

• Command completed successfully.
› Ask Codex to do something
`)).toBeNull();
  });
});

describe("Codex's queue of questions (request_user_input_async)", () => {
  const status = "  GPT-6-Sol xhigh · ~/lab · Context 97% left · weekly 56% left";

  test("reads an open question: its position, a wrapped title, wrapped options and the typed-answer row", () => {
    const prompt = parseInteractivePrompt("codex", `
• WAITING
• Queued follow-up inputs
  1 of 2
  정리 범위를 현재 Q255 학습 출력과 연결된 산출물로 한정할까요, 아니면
  output/test 전체 실험까지 포함할까요?
  › 1. 현재 Q255 관련 산출물만
    2. output/test 전체 실험까지 포함해서 모두 정리하고
       결과를 표로 남기기
    3. Other
  enter submit   ctrl+] skip   alt+↓ main prompt   alt+↑ next question
`);
    expect(prompt).toMatchObject({
      kind: "question", title: "Question 1 of 2", queued: "open",
      question: "정리 범위를 현재 Q255 학습 출력과 연결된 산출물로 한정할까요, 아니면 output/test 전체 실험까지 포함할까요?",
      custom_option_index: 2,
    });
    expect(labels(prompt)).toEqual(["현재 Q255 관련 산출물만", "output/test 전체 실험까지 포함해서 모두 정리하고 결과를 표로 남기기"]);
    // an answer of its own is typed into the last row once it is selected, then submitted
    expect(answerKeys(prompt!, { custom_text: "Q255 only, keep logs" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { text: "Q255 only, keep logs" }, { keys: ["enter"] },
    ]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("reads an open free-form question, and a last row already typed over", () => {
    const freeForm = parseInteractivePrompt("codex", `
• Queued follow-up inputs
  Any notes?
  Type your answer
  enter submit   ctrl+] skip   alt+↓ main prompt
`);
    expect(freeForm).toMatchObject({ title: "Question", question: "Any notes?", options: [], custom_option_index: 0 });
    expect(answerKeys(freeForm!, { custom_text: "none" })).toEqual([{ text: "none" }, { keys: ["enter"] }]);

    const typed = parseInteractivePrompt("codex", `
• Queued follow-up inputs
  Which split?
    1. train
    2. test
  › 3. val spl
  enter submit   ctrl+] skip   alt+↓ main prompt
`);
    expect(labels(typed)).toEqual(["train", "test"]);
    expect(answerKeys(typed!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("a collapsed queue shows its first question, taken from the rollout's newest unanswered ones", () => {
    const collapsed = `
• WAITING
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
${status}
`;
    expect(parseInteractivePrompt("codex", collapsed)).toBeNull();
    // only the card answers it: Codex keeps working, and the chat's messages still go to Codex
    expect(codexQueuedPrompt(collapsed, [{ key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] }])?.queued).toBe("collapsed");
    // a message of the user's own waiting to go replaces the questions' block: nothing to open
    expect(codexQueuedPrompt(collapsed.replace("    alt+↑ to answer", "    alt+↑ to answer\n• Messages to be submitted after next tool call\n  ↳ stop, don't touch prod"), [
      { key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] },
    ])).toBeNull();
    const asked = [
      // skipped in the TUI: no record says so, but only the newest two are waiting
      { key: "call_a:0", title: "Old question?", options: ["x", "y"] },
      { key: "call_b:0", title: "Which dataset?", options: ["LM-O", "YCB-V"] },
      { key: "call_b:1", title: "Any notes?", options: [] },
    ];
    const prompt = codexQueuedPrompt(collapsed, asked);
    expect(prompt).toMatchObject({ kind: "question", title: "Question 1 of 2", question: "Which dataset?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["LM-O", "YCB-V"]);
    expect(codexQueuedPrompt(collapsed.replace("? 2 questions", "? 1 question"), asked)).toMatchObject({ title: "Question", question: "Any notes?", options: [], custom_option_index: 0 });
    // the queue opened on another question last time (one was skipped): the card shows that one
    expect(codexQueuedPrompt(collapsed, asked, { question: "Old question?", options: ["x", "y"] })).toMatchObject({ question: "Old question?", title: "Question 1 of 2" });
    // by title and options: an older skipped question with the same title is not the one it opened on
    const twins = [
      { key: "call_t:0", title: "Which dataset?", options: ["COCO"] },
      ...asked,
    ];
    expect(labels(codexQueuedPrompt(collapsed, twins, { question: "Which dataset?", options: ["LM-O", "YCB-V"] }))).toEqual(["LM-O", "YCB-V"]);
    expect(labels(codexQueuedPrompt(collapsed, twins, { question: "Which dataset?", options: ["COCO"] }))).toEqual(["COCO"]);
    // fewer on record than the queue holds: the card cannot say which is first
    expect(codexQueuedPrompt(collapsed, asked.slice(2))).toBeNull();
    // the count must be the queue above the main prompt, not an old line higher up
    expect(codexQueuedPrompt(collapsed.replace("› Ask Codex to do anything", `${"output line\n".repeat(20)}› Ask Codex`), asked)).toBeNull();
  });
});

describe("Codex's collapsed question queue", () => {
  test("is told apart from an open question, which holds the input", () => {
    const collapsed = `
• WAITING
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
  GPT-6-Sol xhigh · ~/lab · Context 97% left
`;
    expect(codexQuestionsCollapsed(collapsed)).toBe(true);
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  Which split?
  › 1. train
    2. test
    3. Other
  enter submit   ctrl+] skip   alt+↓ main prompt
`)).toBe(false);
    expect(codexQuestionsCollapsed("› Ask Codex to do anything\n")).toBe(false);
    // a numbered menu the parser does not know, right under the queue: not the main prompt
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  ? 1 question
    alt+↑ to answer
› 1. Continue with the new plan
  2. Stop here
`)).toBe(false);
    // an approval under the queue holds the input: a message would answer it
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  ? 1 question
    alt+↑ to answer

Would you like to run the following command?

$ rm -rf junk

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`)).toBe(false);
  });

  test("the card and the send path read the same count, so they never tell different stories", () => {
    const asked = [{ key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] }];
    const collapsed = `
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
  GPT-6-Sol xhigh · ~/lab · Context 97% left
`;
    const screens = {
      collapsed,
      // a message of the user's own waiting to be submitted
      queuedMessage: collapsed.replace("    alt+↑ to answer", "    alt+↑ to answer\n• Messages to be submitted after next tool call\n  ↳ stop, don't touch prod"),
      // something the parser does not know sits between the queue and the main prompt
      somethingBelow: collapsed.replace("› Ask Codex to do anything", "  Allow network access?\n› Ask Codex to do anything"),
      noHint: collapsed.replace("    alt+↑ to answer\n", ""),
      // a menu row the parser does not know, right under the hint, is not the main prompt
      numberedRow: collapsed.replace("› Ask Codex to do anything", "› 1. Allow once\n  2. Deny"),
      none: "› Ask Codex to do anything\n",
    };
    const shown = Object.fromEntries(Object.entries(screens).map(([name, screen]) => [name, [codexQueuedPrompt(screen, asked) !== null, codexQuestionsCollapsed(screen)]]));
    expect(shown).toEqual({ collapsed: [true, true], queuedMessage: [false, false], somethingBelow: [false, false], noHint: [false, false], numberedRow: [false, false], none: [false, false] });
  });
});

describe("interactive prompt answers", () => {
  const claudeQuestion = () => parseInteractivePrompt("claude", `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
  2. YCB-V
  3. T-LESS
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)!;

  test("selects the first and third options relative to the native cursor", () => {
    expect(answerKeys(claudeQuestion(), { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(claudeQuestion(), { option_index: 2 })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);
  });

  test("enters custom text through the provider's direct-input row", () => {
    expect(answerKeys(claudeQuestion(), { custom_text: "Use the internal benchmark" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] },
      { text: "Use the internal benchmark" },
      { keys: ["enter"] },
    ]);

    const codex = parseInteractivePrompt("codex", `
Which backend?

› 1. CUDA
  2. CPU
  3. None of the above  Add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`)!;
    expect(answerKeys(codex, { custom_text: "ROCm" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["tab"] },
      { text: "ROCm" }, { keys: ["enter"] },
    ]);
  });

  test("rejects invalid answer shapes", () => {
    expect(() => answerKeys(claudeQuestion(), { option_index: 0, custom_text: "also" })).toThrow("Exactly one answer");
    expect(() => answerKeys(claudeQuestion(), { option_indices: [0] })).toThrow("requires one or more selections");
    expect(() => answerKeys(claudeQuestion(), { option_index: 99 })).toThrow("valid option index");
    expect(() => answerKeys(claudeQuestion(), { custom_text: 42 } as never)).toThrow("must be a string");
    expect(() => answerKeys(claudeQuestion(), { option_indices: null } as never)).toThrow("must be an array");
  });
});

describe("Claude's question in a narrow pane", () => {
  // live-captured from Claude Code 2.1.283 in a 44-column herdr pane: the hint wraps
  const narrow = `────────────────────────────────────────────
 ☐ 재현 테스트

│ 재현용 테스트 질문입니다. 지금 이 질문
│ 화면을 백그라운드에서 캡처하고 있으니,
│ 15초쯤 기다렸다가 아무거나 골라 주세요.
│ 기다리는 동안 채팅 모드에 이 질문 카드가
│ 뜨는지도 봐 주시면 좋습니다.

❯ 1. 채팅에 카드가 안 떠요
     채팅 모드에 이 질문이 보이지 않음
  2. 채팅에 카드가 떠요
     채팅 모드에 이 질문이 카드로 보임
  3. Type something.
────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to
cancel
`;

  test("reads the question though its hint wrapped, and knows it is still open", () => {
    const prompt = parseInteractivePrompt("claude", narrow);
    expect(prompt).toMatchObject({
      kind: "question",
      title: "재현 테스트",
      options: [{ label: "채팅에 카드가 안 떠요" }, { label: "채팅에 카드가 떠요" }],
      custom_option_index: 2,
    });
    expect(prompt?.question).toStartWith("재현용 테스트 질문입니다.");
  });

  test("does not take an answered menu above later output for an open one", () => {
    expect(parseInteractivePrompt("claude", narrow + "\n● Done.\n\n> ")).toBeNull();
  });
});

describe("Claude's unnumbered menus", () => {
  // Claude Code 2.1.285 on a folder it has not seen, as herdr's pane read shows it (live)
  const trust = (selected: 0 | 1 = 0, after = "") => `
❯ claude --model claude-haiku-4-5-20251001

────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/user/projects/new-app // leakscan:allow: test fixture

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this folder

 Enter to confirm · Esc to cancel
${after}`;

  test("reads the folder-trust check as a menu with its question and both rows", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(prompt).not.toBeNull();
    expect(prompt.kind).toBe("menu");
    expect(prompt.title).toBe("Accessing workspace");
    expect(prompt.question).toBe("Is this a project you created or one you trust?");
    expect(labels(prompt)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(prompt.body).toContain("Claude Code'll be able to read, edit, and execute files here.");
  });

  test("answers from the native cursor, and keeps its id when only the cursor moves", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    const moved = parseInteractivePrompt("claude", trust(1))!;
    expect(moved.id).toBe(prompt.id);
    expect(answerKeys(moved, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { custom_text: "maybe" })).toThrow();
  });

  test("is gone once the menu is answered and Claude draws under it", () => {
    expect(parseInteractivePrompt("claude", trust(1, " ▐▛███▛█   Claude Code v2.1.285\n❯ Try \"fix typecheck errors\"\n"))).toBeNull();
  });

  test("keeps a label a narrow pane wrapped as one row", () => {
    // 24 columns: the panel's sentences and the second row both reach the edge and wrap
    const narrow = (selected: 0 | 1) => `
 Accessing workspace:

 Quick safety check: Is
 this a project you
 created or one you
 trust?

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this
   folder

 Enter to confirm · Esc
 to cancel
`;
    const prompt = parseInteractivePrompt("claude", narrow(0))!;
    expect(labels(prompt)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(labels(parseInteractivePrompt("claude", narrow(1)))).toEqual(["No, exit", "Yes, I trust this folder"]);
  });

  test("never takes the next row for a wrapped label when a row is the widest line", () => {
    // nothing else on screen reaches as far as the first row, so it says nothing of the pane's
    // width: the line under it may be its tail or the next row, and a guess answers the wrong row
    const two = (selected: 0 | 1) => `
 Trust?

 ${selected === 0 ? "❯" : " "} Yes, trust this folder and continue
 ${selected === 1 ? "❯" : " "} No, exit

 Enter to confirm · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", two(0))).toBeNull();
    // with the cursor on it, the second line is a row for certain
    expect(labels(parseInteractivePrompt("claude", two(1)))).toEqual(["Yes, trust this folder and continue", "No, exit"]);
    // merged, this would show two options and answer the second with one Down, the real `Yes`
    const three = `
 Trust?

 ❯ No, exit and keep this folder untrusted
   Yes
   Yes, and allow hooks too

 Enter to confirm · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", three)).toBeNull();
    const panel = ` Trust? The first row is not the widest line here, so this one tells the width.\n${three.slice(" Trust?\n".length + 1)}`;
    const prompt = parseInteractivePrompt("claude", panel);
    expect(labels(prompt)).toEqual(["No, exit and keep this folder untrusted", "Yes", "Yes, and allow hooks too"]);
    expect(answerKeys(prompt!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("leaves numbered rows and a menu without one selected row to the other readers", () => {
    expect(parseInteractivePrompt("claude", "Pick one\n\n❯ 1. First\n  2. Second\n\nEnter to confirm · Esc to cancel\n")).toBeNull();
    expect(parseInteractivePrompt("claude", "Pick one\n\n  First\n  Second\n\nEnter to confirm · Esc to cancel\n")).toBeNull();
  });
});

describe("OmO's ask_user_question form", () => {
  // omo 5.1.7 in a 120-column herdr pane, as herdr reads it: the overlay between two rules, then
  // omo's footer. herdr labels the pane `pi` while omo waits on it.
  const rule = "─".repeat(120);
  const footer = `${rule}\n/private/tmp/omo-ask${" ".repeat(74)}[----------] 42K/1M (4.2%)\n${" ".repeat(86)}claude-opus-5-5 · high · OmO 5.1.7\n`;
  const form = (body: string) => `\n [표시 위치] [월 한도] wait for answer\n\n${rule}\n\n Ask user · 30m\n${body}\n${footer}`;
  const first = form(` → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여줄까요?
 → 1. 설정 > 음성 입력 (추천)
      오늘, 이번 달, 누적의 분·횟수·추정 비용을 보여주고 OpenAI 사용량 페이지 링크를 붙입니다. 변경 범위가 가장 작습니
 다.
   2. 설정 + 사이드바 미터
      사이드바의 구독 사용량 미터 옆에 음성 항목도 넣습니다. 한눈에 보이지만 UI 변경이 커집니다.
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
`);

  test("reads the question asked now, its options and the form's steps", () => {
    const prompt = parseInteractivePrompt("pi", first);
    expect(prompt).toMatchObject({
      agent: "omo", kind: "question", title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?",
      multi_select: false, custom_option_index: 2,
      steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }],
    });
    expect(labels(prompt)).toEqual(["설정 > 음성 입력 (추천)", "설정 + 사이드바 미터"]);
    // a word the pane wrapped at its edge is one word again
    expect(prompt?.options[0]?.description).toEndWith("변경 범위가 가장 작습니다.");
    // a number picks the option and moves on; a typed answer replaces one typed before
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ text: "2" }]);
    expect(answerKeys(prompt!, { custom_text: "둘 다" })).toEqual([
      { keys: ["backspace"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { text: "둘 다" }, { keys: ["enter"] },
    ]);
    expect(() => answerKeys(prompt!, { option_index: 2 })).toThrow("valid option index");
    // herdr may name the pane omo, or claude while omo's SDK child runs
    expect(parseInteractivePrompt("omo", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("claude", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("codex", first)).toBeNull();
  });

  test("marks answered questions and chosen options, and a new step is another card", () => {
    const second = form(`   표시 위치 ✓  → 월 한도 ✓    Submit
 월 사용 한도를 둘까요?
   1. 한도 없음
      경고만 표시합니다.
   2. 월 $5 한도 ✓
      넘으면 음성 입력을 막습니다.
 → Type your own answer...
 Submit (2/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
`);
    const prompt = parseInteractivePrompt("pi", second);
    expect(prompt).toMatchObject({ title: "Question 2 of 2", question: "월 사용 한도를 둘까요?" });
    expect(labels(prompt)).toEqual(["한도 없음", "월 $5 한도"]);
    expect(prompt?.steps?.map((step) => [step.answered, step.current])).toEqual([[true, false], [true, true]]);
    expect(prompt?.id).not.toBe(parseInteractivePrompt("pi", first)?.id);
    // the cursor is on the typed answer's row already
    expect(answerKeys(prompt!, { custom_text: "없음" })).toEqual([{ keys: ["backspace"] }, { keys: ["enter"] }, { text: "없음" }, { keys: ["enter"] }]);
  });

  test("answers a multiple choice afresh by number, then moves on with Tab", () => {
    const prompt = parseInteractivePrompt("pi", form(` → 검사    보고    Submit
 어떤 검사를 돌릴까요?
 → 1. Lint ✓
      빠른 정적 검사
   2. Tests
      단위 테스트
   3. Build
   Type your own answer...
 Submit (1/2 answered) — Enter toggles; Tab to Submit
 ↑↓ move  1-9 select  space toggle  enter toggle  tab next / Submit  c comment  esc cancel
`));
    expect(prompt).toMatchObject({ title: "Question 1 of 2", multi_select: true, custom_option_index: null });
    expect(labels(prompt)).toEqual(["Lint", "Tests", "Build"]);
    expect(prompt?.options[2]?.description).toBeNull();
    // Backspace clears what was chosen before (Lint here, or rows out of view), then each number toggles one
    expect(answerKeys(prompt!, { option_indices: [2, 0] })).toEqual([{ keys: ["backspace"] }, { text: "1" }, { text: "3" }, { keys: ["tab"] }]);
    expect(answerKeys(prompt!, { option_indices: [1] })).toEqual([{ keys: ["backspace"] }, { text: "2" }, { keys: ["tab"] }]);
  });

  test("reviews the answers: Submit, a row to change, or a comment", () => {
    const review = (rows: string, hint: string) => form(`   표시 위치 ✓    월 한도 ✓  → Submit
 Review your answers
${rows}

 Comment (optional; unanswered questions are reported)
>
 Submit (2/2 answered)
 ${hint}
`);
    const onComment = parseInteractivePrompt("pi", review("   표시 위치: 설정 > 음성 입력 (추천)\n   월 한도: 월 $5 한도", "enter submit  ↑ review answers  shift+tab back  tab next question  esc back"));
    expect(onComment).toMatchObject({
      kind: "menu", title: "Review your answers", question: "Submit (2/2 answered)", body: null, custom_option_index: 3,
      steps: [{ label: "표시 위치", answered: true, current: false }, { label: "월 한도", answered: true, current: false }],
    });
    expect(labels(onComment)).toEqual(["Submit", "표시 위치: 설정 > 음성 입력 (추천)", "월 한도: 월 $5 한도", "Comment (optional; unanswered questions are reported)"]);
    expect(answerKeys(onComment!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(onComment!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(onComment!, { custom_text: "급해요" })).toEqual([{ text: "급해요" }, { keys: ["enter"] }]);
    expect(() => answerKeys(onComment!, { option_index: 3 })).toThrow("valid option index");

    const onRow = parseInteractivePrompt("pi", review("   표시 위치: 설정 > 음성 입력 (추천)\n → 월 한도: 월 $5 한도", "enter edit answer  ↑↓ move  tab next question  esc back"));
    expect(onRow?.id).toBe(onComment?.id);
    expect(answerKeys(onRow!, { option_index: 0 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(onRow!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(onRow!, { custom_text: "급해요" })).toEqual([{ keys: ["down"] }, { text: "급해요" }, { keys: ["enter"] }]);
  });

  test("joins what a narrow pane wraps, the tab bar, the hint and words cut at the edge", () => {
    // omo's own renderer at 40 columns
    const narrow = `${"─".repeat(40)}

 Ask user
 → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여
 줄까요?
 → 1. 설정 > 음성 입력 (추천)
      오늘, 이번 달, 누적의 분·횟수·추
 정 비용을 보여줍니다.
   2. 설정 + 사이드바 미터
      한눈에 보이지만 UI 변경이 커집니
 다.
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select
 enter next  tab next question  c
 comment  esc cancel

${"─".repeat(40)}
`;
    const prompt = parseInteractivePrompt("pi", narrow);
    expect(prompt?.question).toBe("음성 사용량과 추정 비용을 어디에 보여줄까요?");
    expect(prompt?.options.map((option) => option.description)).toEqual(["오늘, 이번 달, 누적의 분·횟수·추정 비용을 보여줍니다.", "한눈에 보이지만 UI 변경이 커집니다."]);
  });

  test("is no card once output has followed the form", () => {
    const later = first.replace(footer, `${Array.from({ length: 12 }, (_, index) => ` line ${index}`).join("\n")}\n${footer}`);
    expect(parseInteractivePrompt("pi", later)).toBeNull();
  });

  // The form's text on a screen that is not omo's live form: printed in a shell, or quoted in
  // Claude's transcript. A card there would type its answer into that program. Each is tried as
  // the form alone and with the rule and footer omo drew under it.
  const printed = [first.replace(footer, ""), first];
  const claudeBox = `\n${rule}\n❯ \n${rule}\n  ? for shortcuts\n`;
  const agents = ["", "pi", "omo", "claude"];

  test("is no card for the form's text printed in a shell, its prompt below", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text}user@host:~/project$ `)).toBeNull();
    }
  });

  test("is no card for the form's text in a shell with output after it", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text} M server/prompt.ts\n M CHANGELOG.md\n 2 files changed\n`)).toBeNull();
    }
  });

  test("is no card for the form's text in Claude's transcript, over Claude's input box", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text}${claudeBox}`)).toBeNull();
    }
  });

  test("is no card for the form's text quoted (indented) in Claude's transcript", () => {
    for (const text of printed) {
      const quoted = text.split("\n").map((line) => line ? `  ${line}` : line).join("\n");
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${quoted}${claudeBox}`)).toBeNull();
    }
  });

  test("needs the session's matching call when the pane is not known to wait on the user", () => {
    // what the server asks for a pane herdr names claude, or not at all, that is not blocked
    expect(parseInteractivePrompt("", first, null, false)).toBeNull();
    expect(parseInteractivePrompt("claude", first, null, false)).toBeNull();
    const ask = { questions: ["표시 위치", "월 한도"].map((header) => ({
      header, question: "q", multiSelect: false, options: [{ label: "a", description: null }, { label: "b", description: null }],
    })) };
    expect(parseInteractivePrompt("", first, ask, false)).toMatchObject({ title: "Question 1 of 2" });
    // another form's call is no evidence
    ask.questions[1]!.header = "다른 질문";
    expect(parseInteractivePrompt("claude", first, ask, false)).toBeNull();
  });

  // omo's session file for the form below: the ask_user_question call, then (once answered) its result
  const call = {
    questions: [
      { header: "표시 위치", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", options: [
        { label: "설정 > 음성 입력 (추천)", description: "오늘, 이번 달, 누적을 보여줍니다." },
        { label: "설정 + 사이드바 미터", description: "한눈에 보이지만 UI 변경이 커집니다." },
        { label: "상단 상태 표시줄", description: "항상 보입니다." },
        { label: "표시하지 않음" },
      ] },
      { header: "월 한도", question: "월 사용 한도를 둘까요?", options: [{ label: "한도 없음" }, { label: "월 $5 한도" }] },
    ],
    waitForAnswer: true,
  };
  const record = (message: unknown) => JSON.stringify({ type: "message", message });
  const asking = [
    record({ role: "user", content: [{ type: "text", text: "ask me" }] }),
    record({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask_user_question", arguments: call }] }),
  ].join("\n");
  // omo's own renderer at 60 columns, in a pane too short for the whole form
  const rule60 = "─".repeat(60);

  test("finds the call omo's session waits on", () => {
    const ask = pendingOmoAsk(asking);
    expect(ask?.questions.map((question) => [question.header, question.options.length, question.multiSelect])).toEqual([["표시 위치", 4, false], ["월 한도", 2, false]]);
    expect(ask?.questions[0]!.options[3]).toEqual({ label: "표시하지 않음", description: null });
    // answered, the agent moved on, or not the shape omo asks with
    expect(pendingOmoAsk(`${asking}\n${record({ role: "toolResult", toolCallId: "call-1", content: [] })}`)).toBeNull();
    expect(pendingOmoAsk(`${asking}\n${record({ role: "assistant", content: [{ type: "text", text: "done" }] })}`)).toBeNull();
    expect(pendingOmoAsk(asking.replace('"questions"', '"items"'))).toBeNull();
    // a tail read from inside a record
    expect(pendingOmoAsk(`ge":{"role":"user"}}\n${asking}`)?.questions).toHaveLength(2);
  });

  test("takes the form's text from the session's call, the screen telling where it stands", () => {
    const short = `      한눈에 보이지만 UI 변경이 커집니다.
   3. 상단 상태 표시줄
      항상 보입니다.
   4. 표시하지 않음
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next
 question  c comment  esc cancel

${rule60}
`;
    // the title, the tabs and the question are above the pane's top
    expect(parseInteractivePrompt("pi", short)).toBeNull();
    const prompt = parseInteractivePrompt("pi", short, pendingOmoAsk(asking));
    expect(prompt).toMatchObject({
      title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", custom_option_index: 4,
      steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }],
    });
    expect(labels(prompt)).toEqual(["설정 > 음성 입력 (추천)", "설정 + 사이드바 미터", "상단 상태 표시줄", "표시하지 않음"]);
    expect(prompt?.options[0]?.description).toBe("오늘, 이번 달, 누적을 보여줍니다.");
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ text: "1" }]);
    // the cursor's row is out of view: to the typed answer's row from the top, where ↑ stops
    expect(answerKeys(prompt!, { custom_text: "둘 다" })).toEqual([
      { keys: ["backspace"] }, ...Array(5).fill({ keys: ["up"] }), ...Array(4).fill({ keys: ["down"] }), { keys: ["enter"] },
      { text: "둘 다" }, { keys: ["enter"] },
    ]);
    // rows that are not the call's question's are no card
    expect(parseInteractivePrompt("pi", short, { questions: [pendingOmoAsk(asking)!.questions[1]!] })).toBeNull();

    // with the whole form in view the call's text wins over the pane's wrap; another call is ignored
    const ask = pendingOmoAsk(asking.replaceAll("상단 상태 표시줄", "x").replace("오늘, 이번 달, 누적을 보여줍니다.", "원문 설명"))!;
    ask.questions[0]!.options.splice(2);
    expect(parseInteractivePrompt("pi", first, ask)?.options[0]?.description).toBe("원문 설명");
    ask.questions[1]!.header = "다른 질문";
    expect(parseInteractivePrompt("pi", first, ask)?.options[0]?.description).toEndWith("가장 작습니다.");
  });

  test("offers to save or discard an answer typed in the terminal", () => {
    const typing = `      항상 보입니다.
   4. 표시하지 않음
   Type your own answer...
 Your answer (enter to save, ↑↓ back to options, esc to
 discard)
> 안녕
 Submit (0/2 answered) — Enter advances
 enter save and next  ↑↓ back to options  tab next question
   esc discard

${rule60}
`;
    const prompt = parseInteractivePrompt("pi", typing, pendingOmoAsk(asking));
    expect(prompt).toMatchObject({ kind: "menu", title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", custom_option_index: null });
    expect(prompt?.options).toEqual([{ label: "Save the typed answer", description: "안녕" }, { label: "Discard it", description: null }]);
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
    // the whole form in view needs no session
    const whole = form(` → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여줄까요?
   1. 설정 > 음성 입력 (추천)
   Type your own answer...
 Your answer (enter to save, ↑↓ back to options, esc to discard)
> 안녕
 Submit (0/2 answered) — Enter advances
 enter save and next  ↑↓ back to options  tab next question  esc discard
`);
    expect(parseInteractivePrompt("pi", whole)).toMatchObject({ title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?" });
  });

  test("reviews the answers of a form whose rows are out of view, by the call's headers", () => {
    const short = `
 Comment (optional; unanswered questions are reported)
>
 Submit (2/2 answered)
 enter submit  ↑ review answers  shift+tab back  tab next
 question  esc back

${rule60}
`;
    expect(parseInteractivePrompt("pi", short)).toBeNull();
    const prompt = parseInteractivePrompt("pi", short, pendingOmoAsk(asking));
    expect(labels(prompt)).toEqual(["Submit", "표시 위치", "월 한도", "Comment (optional; unanswered questions are reported)"]);
    expect(prompt?.steps?.every((step) => step.answered && !step.current)).toBeTrue();
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });
});

describe("Claude's suggested next prompt", () => {
  // Claude Code 2.1.284 as herdr reads it with ANSI: the grey suggestion in the empty input box
  const RULE = "\u001b[0m\u001b[38;2;136;136;136m" + "─".repeat(60) + "\u001b[0m";
  const screen = (input: string, below = RULE) => [
    "\u001b[0m\u001b[38;2;255;255;255m● \u001b[0m표본 수집이 끝나면 알림이 오도록 걸어 두었습니다.",
    "",
    "\u001b[0m\u001b[38;2;153;153;153m✻ Worked for 2m 14s · done 오후 4:16\u001b[0m",
    RULE,
    input,
    below,
    "  \u001b[0m\u001b[38;5;6m[Opus 5.5 (1M context)]\u001b[0m\u001b[38;2;153;153;153m │ \u001b[0m\u001b[2m\u001b[38;2;153;153;153m⏱️  25h\u001b[0m",
    "  \u001b[0m\u001b[38;2;255;107;128m⏵⏵ bypass permissions on\u001b[0m",
  ].join("\r\n");

  test("reads the grey text in the empty input box", () => {
    expect(parseClaudeSuggestion(screen("❯\u00a0\u001b[0m\u001b[2m아직 진행중이야?\u001b[0m"))).toBe("아직 진행중이야?");
    // dim set together with a color, in one sequence
    expect(parseClaudeSuggestion(screen("❯ \u001b[2;38;5;8mrun the tests again\u001b[0m"))).toBe("run the tests again");
  });

  test("nothing while text is typed, the box is empty, or it holds Claude's tip", () => {
    expect(parseClaudeSuggestion(screen("❯\u00a0아직 진행중이야?"))).toBeNull();
    // typed text right after a grey remainder is still typed
    expect(parseClaudeSuggestion(screen("❯ \u001b[2m아직\u001b[0m 진행중"))).toBeNull();
    expect(parseClaudeSuggestion(screen("❯\u00a0"))).toBeNull();
    expect(parseClaudeSuggestion(screen('❯ \u001b[2mTry "how does <filepath> work?"\u001b[0m'))).toBeNull();
  });

  test("a truecolor foreground is not dim: its 2 is the color mode", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[38;2;153;153;153mnot a suggestion\u001b[0m"))).toBeNull();
  });

  test("only the input box: not a ❯ line without its rules, nor a box of several lines", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[2mfirst line\u001b[0m", "  \u001b[2msecond line\u001b[0m"))).toBeNull();
    expect(parseClaudeSuggestion("❯ \u001b[2mloose text\u001b[0m\nmore")).toBeNull();
  });

  test("only the live input box, the bottom one: not an earlier box above a bash-mode input", () => {
    const below = RULE + "\r\n\u001b[38;2;255;255;255m● quoted output\u001b[0m\r\n" + RULE + "\r\n! ls\r\n" + RULE;
    expect(parseClaudeSuggestion(screen("❯ \u001b[2mrun deploy --prod\u001b[0m", below))).toBeNull();
  });

  test("Claude's own drawn cursor on the first grey character", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27m\u001b[2mun the tests\u001b[22m"))).toBe("run the tests");
    // a typed character under that cursor, with nothing grey after it, is typed
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27m"))).toBeNull();
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27mun"))).toBeNull();
  });
});

describe("the fallback card for a blocked pane no reader knows", () => {
  test("offers a numbered menu at the screen's end as options answered by their number", () => {
    const prompt = parseFallbackPrompt("gjc", `
 Apply these 3 file changes?
 src/a.ts, src/b.ts, src/c.ts

 › 1. Apply all
   2. Review each
   3. Discard

 ↵ choose · esc back
`);
    expect(prompt.kind).toBe("menu");
    expect(prompt.fallback).toBe(true);
    expect(prompt.question).toBe("Apply these 3 file changes?");
    expect(prompt.body).toBe("src/a.ts, src/b.ts, src/c.ts");
    expect(labels(prompt)).toEqual(["Apply all", "Review each", "Discard", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ text: "3" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "1" }]);
    expect(() => answerKeys(prompt, { custom_text: "no" })).toThrow();
  });

  test("offers Enter and Esc after the rows, for a program that reads a whole line", () => {
    const prompt = parseFallbackPrompt("gjc", "Pick a profile:\n1. Work\n2. Home\n\nEnter a number >\n");
    expect(labels(prompt)).toEqual(["Work", "Home", "Enter", "Esc"]);
    // the number goes alone; the Enter that submits it is its own tap
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["esc"] }]);
  });

  test("joins the lines the last row wraps onto into its label", () => {
    const prompt = parseFallbackPrompt("gjc", "Trust this folder?\n\n❯ 1. No, exit\n  2. Yes, trust folder and\n     allow all commands without asking\n\n Enter to confirm\n");
    expect(labels(prompt)).toEqual(["No, exit", "Yes, trust folder and allow all commands without asking", "Enter", "Esc"]);
  });

  test("reads no menu when the last row's wrapped label ends in its own letter key", () => {
    const prompt = parseFallbackPrompt("gjc", "Access?\n1. Read only\n2. Full access, every file and\n   command (f)\n\nEnter to select\n");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
    // or ends the row's first line, a description wrapped under it
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Cancel\n2. Full access (f)\n   Allows writing to every file\n\nType f, then Enter\n"))).toEqual(["Enter", "Esc"]);
  });

  test("takes the last line for a hint only when it names a way to choose", () => {
    const menu = (hint: string) => labels(parseFallbackPrompt("gjc", `Pick one:\n1. Alpha\n2. Beta\n\n${hint}\n`));
    // a plain Enter or Press asks for something else: a digit typed there is no answer
    for (const hint of ["Enter recovery code", "Enter your password", "Enter your phone number", "Press any key", "Enter to continue"]) {
      expect(menu(hint)).toEqual(["Enter", "Esc"]);
    }
    expect(labels(parseFallbackPrompt("gjc", "1. A\n2. B\nEnter recovery code\n"))).toEqual(["Enter", "Esc"]);
    for (const hint of ["Enter to select", "↵ choose · esc back", "Enter to confirm · Esc to cancel", "Enter a number", "Type 1-2", "↑/↓ to move", "Tab/arrows to navigate"]) {
      expect(menu(hint)).toEqual(["Alpha", "Beta", "Enter", "Esc"]);
    }
  });

  test("reads no menu unless its hint is the screen's last line, with only the last row's wrap above it", () => {
    // a new prompt under the hint takes what is typed now: a digit there is no menu answer
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. Read only\n2. Full access\nEnter to select\nEnter recovery code ABCD\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. Read only\n2. Full access\n\nEnter to select\nWaiting for the token\n"))).toEqual(["Enter", "Esc"]);
    // a line under the last row, not indented past its number, is not its wrap
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n  1. Read only\n  2. Full access\n  Saved.\nEnter to select\n"))).toEqual(["Enter", "Esc"]);
    // nor a hint inside the last row's wrap, with a new prompt under it
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Read settings\n2. Load profiles\n   Profiles loaded\n   Enter to continue\nEnter recovery code ABCD\n"))).toEqual(["Enter", "Esc"]);
    // nor an input field there, or more output than a wrapped label
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Load configuration\n2. Connect to account\n   Authentication required\n   Password:\nEnter password and press Enter\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Load configuration\n2. Connect to account\n   Connected to example.com\n   Authentication required\n   Waiting\nEnter to continue\n"))).toEqual(["Enter", "Esc"]);
    // a wrapped label's own words are no hint
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Cancel\n2. Allow access to the\n   selected account number only\n\nEnter to select\n"))).toEqual(["Cancel", "Allow access to the selected account number only", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Where?\n1. Here\n2. Allow the agent to\n   choose a directory\n\nEnter to select\n"))).toEqual(["Here", "Allow the agent to choose a directory", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Retry?\n1. Never\n2. Retry with a maximum\n   attempt count: 3\n\nEnter to select\n"))).toEqual(["Never", "Retry with a maximum attempt count: 3", "Enter", "Esc"]);
    // a hint right under the last row, indented like its wrap, is still the hint
    expect(labels(parseFallbackPrompt("gjc", "Pick a profile:\n1. Work\n2. Home\n   Enter a number >\n"))).toEqual(["Work", "Home", "Enter", "Esc"]);
  });

  test("keeps a wrapped label on its own row, since each row starts with its number", () => {
    const prompt = parseFallbackPrompt("gjc", "Trust this folder?\n\n❯ 1. No, exit and keep this folder\n     untrusted\n  2. Yes, trust folder\n  3. Yes, trust and allow hooks\n\n Enter to confirm\n");
    expect(labels(prompt)).toEqual(["No, exit and keep this folder untrusted", "Yes, trust folder", "Yes, trust and allow hooks", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
  });

  test("guesses no options for an unnumbered menu, offering the keys its hint names", () => {
    const prompt = parseFallbackPrompt("claude", "Continue?\n\n  Yes\n❯ No\n  Later\n\n ↑/↓ to move · Enter to choose\n");
    expect(prompt.title).toBe("Waiting for input");
    expect(prompt.question).toBe("Continue?");
    expect(labels(prompt)).toEqual(["↑", "↓", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }]);
  });

  test("reads no menu once a new prompt or input box follows it", () => {
    const done = parseFallbackPrompt("claude", "Pick one\n\n  1. Deny\n❯ 2. Allow\n\n● Done.\n❯ \n");
    expect(labels(done)).toEqual(["Enter", "Esc"]);
    const quoted = parseFallbackPrompt("claude", "> quoted example\n❯ Deny\n  Allow all\n");
    expect(labels(quoted)).toEqual(["Enter", "Esc"]);
  });

  test("reads a numbered list as no menu without a hint to choose, or before an input field", () => {
    expect(labels(parseFallbackPrompt("gjc", "My plan:\n\n1. Inspect files\n2. Remove backups\n\nPassword:\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. A\n2. B\nEnter a number\nChoice: 2\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Read only (r)\n2. Full access (f)\nType r or f, then Enter\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick\n1. One\n❯ \n2. Two\nEnter to select\n"))).toEqual(["Enter", "Esc"]);
  });

  test("offers no letters or arrows for an input box, a quote or a word", () => {
    expect(labels(parseFallbackPrompt("claude", 'The installer prints "Overwrite? (y/n)".\n❯ \n'))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("claude", "Done.\n❯ Explain why the installer asks (y/n)\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("claude", "Use arrow functions in the patch.\nArrowhead metadata loaded\n"))).toEqual(["Enter", "Esc"]);
  });

  test("without a menu, shows the screen's last lines and offers Enter and Esc", () => {
    const prompt = parseFallbackPrompt("codex", "Working on it\n\nPress any key to review the diff (q to quit)\n");
    expect(prompt.title).toBe("Waiting for input");
    expect(prompt.question).toBe("Press any key to review the diff (q to quit)");
    expect(prompt.body).toContain("Working on it");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
  });

  test("offers a (y/n) question at the screen's end as Yes and No, typing the letter alone", () => {
    const prompt = parseFallbackPrompt("gjc", " config.json already exists.\n Overwrite it? (y/n)\n Press Enter to keep it, or Esc to abort\n");
    expect(prompt.question).toBe("Overwrite it? (y/n)");
    expect(labels(prompt)).toEqual(["Yes (y)", "No (n)", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "y" }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "n" }]);
    expect(labels(parseFallbackPrompt("gjc", "Delete the branch? [Y/n] "))).toEqual(["Yes (y)", "No (n)", "Enter", "Esc"]);
  });

  test("offers no letters for a (y/n) only mentioned above the prompt", () => {
    const prompt = parseFallbackPrompt("codex", 'The installer prints "Overwrite config? (y/n)".\nIt then exits.\n\n› Ask Codex to do anything\n  100% context left\n');
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
  });

  test("takes the question from the line that asks it, not the hint below", () => {
    const prompt = parseFallbackPrompt("gjc", "Found 3 stale caches.\nClear them now?\nPress Enter to continue, Esc to skip\n");
    expect(prompt.question).toBe("Clear them now?");
    expect(prompt.body).toBe("Found 3 stale caches.\nPress Enter to continue, Esc to skip");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
  });

  test("gives the same id to the same screen, and another to a changed one", () => {
    const screen = "Pick\n\n❯ 1. One\n  2. Two\n\n Enter to select\n";
    expect(parseFallbackPrompt("omo", screen).id).toBe(parseFallbackPrompt("omo", screen).id);
    expect(parseFallbackPrompt("omo", screen.replace("Two", "Three")).id).not.toBe(parseFallbackPrompt("omo", screen).id);
    const context = (command: string) => [`$ ${command}`, ...Array.from({ length: 14 }, (_, i) => `line ${i}`), "Run it?", "", "❯ 1. Yes", "  2. No", "", " Enter to select"].join("\n");
    expect(parseFallbackPrompt("gjc", context("rm -rf important")).id).not.toBe(parseFallbackPrompt("gjc", context("rm safe.tmp")).id);
    const keys = (command: string) => [`$ ${command}`, ...Array.from({ length: 18 }, (_, i) => `line ${i}`), "Proceed? (y/n)"].join("\n");
    expect(parseFallbackPrompt("gjc", keys("rm -rf important")).id).not.toBe(parseFallbackPrompt("gjc", keys("rm safe.tmp")).id);
    const footer = (end: string) => `Pick\n\n❯ 1. One\n  2. Two\n\n ${end}\n`;
    expect(parseFallbackPrompt("gjc", footer("Enter to select")).id).not.toBe(parseFallbackPrompt("gjc", footer("Enter to select · done")).id);
  });

  /** a numbered menu under the line an agent keeps showing while it waits */
  const underWorkingLine = (working: string, cursor = 0) => [
    working, "", "Run the tests?", "",
    ...["Yes", "No"].map((label, index) => `${index === cursor ? "❯" : " "} ${index + 1}. ${label}`),
    "", "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const idOf = (screen: string) => parseFallbackPrompt("claude", screen).id;

  test("keeps its id while only Claude's working line ticks", () => {
    // the spinner, the time and the token count move on every second; the prompt does not
    const first = parseFallbackPrompt("claude", underWorkingLine("✢ Tempering… (1m 55s · ↓ 10.0k tokens)"));
    expect(idOf(underWorkingLine("✻ Tempering… (1m 58s · ↓ 10.4k tokens)"))).toBe(first.id);
    expect(idOf(underWorkingLine("· Tempering… (2h 3m 1s · ↑ 1,204 tokens)"))).toBe(first.id);
    expect(idOf(underWorkingLine("* Running the tests… (5s · ↓ 12 tokens · esc to interrupt)"))).toBe(idOf(underWorkingLine("✶ Running the tests… (9s · ↓ 3.1k tokens · esc to interrupt)")));
    // the card shows the line as the screen has it
    expect(first.body).toBe("✢ Tempering… (1m 55s · ↓ 10.0k tokens)");
    // the keys card holds the line among its last ones, and as its question when nothing asks
    const keys = (working: string) => ["Apply the migration to the staging database", working, "Proceed? (y/n)"].join("\n");
    expect(idOf(keys("✢ Tempering… (5s · ↓ 1.0k tokens)"))).toBe(idOf(keys("✶ Tempering… (9s · ↓ 1.3k tokens)")));
    const asked = (working: string) => ["Pick one", "", "❯ 1. One", "  2. Two", working, "Enter to select"].join("\n");
    expect(idOf(asked("✢ Tempering… (5s · ↓ 1.0k tokens)"))).toBe(idOf(asked("✶ Tempering… (9s · ↓ 1.3k tokens)")));
  });

  test("makes another card of anything else that changed, on a working line too", () => {
    const working = "✢ Tempering… (5s · ↓ 1.0k tokens)";
    // what the agent is doing: the words stay in the id
    expect(idOf(underWorkingLine("✢ Deleting staging… (5s · ↓ 1.0k tokens)"))).not.toBe(idOf(underWorkingLine("✢ Deleting production… (5s · ↓ 1.0k tokens)")));
    // the row the cursor is on: Enter would pick another one
    expect(idOf(underWorkingLine(working, 0))).not.toBe(idOf(underWorkingLine(working, 1)));
    // the hint coming or going is a change of the line, once
    expect(idOf(underWorkingLine(working))).not.toBe(idOf(underWorkingLine("✢ Tempering… (5s · ↓ 1.0k tokens · esc to interrupt)")));
    // what is asked about, named above the lines the keys card shows, under a line that ticks
    const keys = (target: string, time: string) => [`Delete ${target}`, ...Array.from({ length: 15 }, (_, i) => `detail ${i}`), `✢ Tempering… (${time} · ↓ 1.0k tokens)`, "Proceed? (y/n)"].join("\n");
    expect(idOf(keys("staging", "5s"))).toBe(idOf(keys("staging", "9s")));
    expect(idOf(keys("staging", "5s"))).not.toBe(idOf(keys("production", "9s")));
  });

  test("reads a line that is not known to be Claude's working line to the letter", () => {
    const differ = (one: string, other: string, agent = "claude") =>
      expect(parseFallbackPrompt(agent, underWorkingLine(one)).id).not.toBe(parseFallbackPrompt(agent, underWorkingLine(other)).id);
    // a time in a command, in parentheses of another kind, or on a line with no spinner or no ellipsis
    differ("$ sleep 30s", "$ sleep 60s");
    differ("Waiting… (30s timeout)", "Waiting… (60s timeout)");
    differ("Tests passed (12s · 3 files)", "Tests passed (13s · 3 files)");
    differ("Tempering… (5s · ↓ 1.0k tokens)", "Tempering… (9s · ↓ 1.0k tokens)");
    differ("✢ Tempering (5s · ↓ 1.0k tokens)", "✢ Tempering (9s · ↓ 1.0k tokens)");
    // a duration that is offered, not one that has passed: nothing says tokens were used
    differ("* Restart service… (5s)", "* Restart service… (300s)");
    differ("✢ Restarting… (5s · downtime)", "✢ Restarting… (300s · downtime)");
    differ("✢ Tempering… (5s · esc to interrupt)", "✢ Tempering… (9s · esc to interrupt)");
    differ("• Restart service (5s · downtime)", "• Restart service (300s · downtime)");
    // an amount of tokens that is asked about: no arrow, or not on a working line
    differ("✢ Purchasing… (5s · 10 tokens)", "✢ Purchasing… (5s · 100000 tokens)");
    differ("• Purchase credits (5s · 10 tokens)", "• Purchase credits (5s · 100000 tokens)");
    differ("Budget: 10.0k tokens", "Budget: 90.0k tokens");
    // another program's working line, and Claude's line in a pane that does not run Claude
    differ("• Working (12s • esc to interrupt)", "• Working (47s • esc to interrupt)");
    differ("⠋ Thinking... (3s)", "⠹ Thinking... (9s)");
    differ("✢ Tempering… (5s · ↓ 1.0k tokens)", "✻ Tempering… (9s · ↓ 1.3k tokens)", "gjc");
  });

  test("tells the working line from a line that holds its blanked form as text", () => {
    // a fixture or a note about this very rule, shown on the screen: its text is what is asked about
    const about = (line: string) => ["Remove this exact line from the fixture?", line, "", "1. Yes", "2. No", "", "Enter a number, or Esc to cancel"].join("\n");
    expect(idOf(about("✢ Tempering… (55s · ↓ 10.0k tokens)"))).not.toBe(idOf(about("* Tempering… (<time> · <tokens>)")));
    expect(idOf(about("✢ Tempering… (55s · ↓ 10.0k tokens · esc to interrupt)"))).not.toBe(idOf(about("* Tempering… (<time> · <tokens> · esc to interrupt)")));
    // and from the same line one row further down
    const moved = (before: string[]) => [...before, "✢ Tempering… (55s · ↓ 10.0k tokens)", "", "1. Yes", "2. No", "", "Enter a number, or Esc to cancel"].join("\n");
    expect(idOf(moved(["Run it?"]))).not.toBe(idOf(moved(["Run it?", "Run it?"])));
  });

  test("keeps the marker of the selected row in the id, whatever the rows look like", () => {
    const rows = (selected: number, on: string, off: string, tail: string) =>
      ["Choose operation", ...["Delete all", "Cancel"].map((label, index) => `${index === selected ? on : off} ${label}${tail}`), "Use ↑/↓ then Enter"].join("\n");
    for (const [on, off, tail] of [
      ["•", "◦", " (5s · irreversible)"],
      ["*", "·", "…"],
      // rows that read like working lines: a spinner's frames as markers, an ellipsis and a time
      ["*", "·", "… (5s)"],
      // and with a token count: two lines of that shape are not one working line
      ["*", "·", "… (5s · ↓ 1.0k tokens)"],
    ] as const) {
      expect(idOf(rows(0, on, off, tail))).not.toBe(idOf(rows(1, on, off, tail)));
    }
  });
});

describe("Claude's suggestion on a prompt poll", () => {
  /** a herdr with one Claude pane whose ANSI reads never answer */
  async function stalledAnsiHerdr(status: string, run: (reads: string[]) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-prompt-suggestion-"));
    const path = join(root, "herdr.sock");
    const reads: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { format?: string } };
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "session.snapshot") {
          return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: "claude", agent_status: status }], layouts: [] } });
        }
        if (request.method !== "pane.read") throw new Error(`unexpected fixture RPC: ${request.method}`);
        reads.push(request.params.format ?? "");
        if (request.params.format === "text") answer({ read: { text: "Done.\n\n────────\n❯ \n────────\n" } });
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(reads); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function poll(): Promise<{ body: unknown; ms: number }> {
    const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
    const started = Date.now();
    const response = await handlePromptRequest(new Request(url), url);
    return { body: await response!.json(), ms: Date.now() - started };
  }

  test("answers without it once its read is late, rather than waiting on herdr", async () => {
    await stalledAnsiHerdr("idle", async (reads) => {
      const { body, ms } = await poll();
      expect(body).toEqual({ prompt: null, suggestion: null });
      expect(reads).toEqual(["text", "ansi"]);
      expect(ms).toBeLessThan(2_500);
    });
  }, 4_000);

  test("is not read while Claude works", async () => {
    await stalledAnsiHerdr("working", async (reads) => {
      const { body, ms } = await poll();
      expect(body).toEqual({ prompt: null, suggestion: null });
      expect(reads).toEqual(["text"]);
      expect(ms).toBeLessThan(1_000);
    });
  }, 4_000);
});

// Captured from pi 0.87.1 driving its own dialogs: the pane's footer stays under the dialog,
// so the hint is near the end of the screen without being it.
describe("pi's dialogs", () => {
  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const piScreen = (body: string) => `────────────────────────────────────────\n\n${body}\n────────────────────────────────────────${FOOTER}`;
  const MENU_HINT = " ↑↓ navigate  enter select  escape/ctrl+c cancel";
  const select = piScreen(" Allow dangerous command?\n\n → Allow once\n   Always allow\n   Block\n" + MENU_HINT);

  test("reads an extension's select as its options, in pi's own order", () => {
    const prompt = parseInteractivePrompt("pi", select)!;
    expect(prompt.kind).toBe("question");
    expect(prompt.question).toBe("Allow dangerous command?");
    expect(prompt.options.map((option) => option.label)).toEqual(["Allow once", "Always allow", "Block"]);
    // the cursor sits on the first row, so one option is one key step per row above it
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("reads a confirm as an approval, and declines it by pressing No", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Clear session?\n All messages will be lost.\n\n → Yes\n   No\n" + MENU_HINT))!;
    expect(prompt.kind).toBe("approval");
    expect(prompt.title).toBe("Clear session?");
    expect(prompt.question).toBe("All messages will be lost.");
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    // measured on pi: pressing "No" answers the confirmation false, where Escape would leave
    // it unanswered, so the card's decline presses the row it shows
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("lets the chat type an answer to a dialog that wants text", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Branch name?\n\n>\n enter submit  escape/ctrl+c cancel"))!;
    expect(prompt.question).toBe("Branch name?");
    expect(prompt.custom_option_index).toBe(0);
    // the `>` line already owns the input: an Enter typed before the answer submits the dialog
    // empty, and the answer is left behind to be typed into pi's own prompt
    // the line is emptied first: text typed into it in the terminal would stay around the answer
    expect(answerKeys(prompt, { custom_text: "feat/x" })).toEqual([{ keys: ["ctrl+k"] }, { keys: ["ctrl+u"] }, { text: "feat/x" }, { keys: ["enter"] }]);
  });

  // The wrap as pi 0.87.1 draws it in a pane 46 columns wide: a row three columns in, its rest one.
  test("reads an option a narrow pane wrapped as one option, so a tap lands on the row it names", () => {
    const narrow = piScreen(" Where should this change go next?\n\n → Keep it on the staging environment for now\n and wait for review\n   Deploy to production\n   Cancel\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n");
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt.options.map((option) => option.label)).toEqual(['Keep it on the staging environment for now and wait for review', "Deploy to production", "Cancel"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    // an option that is not the cursor's wraps the same way
    const second = piScreen(" Pick one\n\n → Cancel\n   Keep it on the staging environment for now\n and wait for review\n   Deploy to production\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n");
    expect(parseInteractivePrompt("pi", second)!.options.map((option) => option.label)).toEqual(["Cancel", "Keep it on the staging environment for now and wait for review", "Deploy to production"]);
  });

  test("reads a confirm's wrapped message whole, under the dialog's own title", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Delete the branch?\n This removes the local branch and its remote\n counterpart for good.\n\n → Yes\n   No\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n"))!;
    expect(prompt.kind).toBe("approval");
    expect(prompt.title).toBe("Delete the branch?");
    expect(prompt.question).toBe("This removes the local branch and its remote counterpart for good.");
  });

  test("offers nothing once the dialog is answered, moved through, or never opened", () => {
    expect(parseInteractivePrompt("pi", select.replace("→ Allow once", "  Allow once").replace("   Always allow", " → Always allow"))).toBeNull();
    // an answered dialog leaves its hint on screen while pi carries on under it: the hint is
    // no longer near the end, so the card that was offered is withdrawn rather than reoffered
    expect(parseInteractivePrompt("pi", piScreen(" select -> Always allow\n" + MENU_HINT + "\n\n thinking\n more of the answer\n and yet more\n\n>" ))).toBeNull();
    // pi's own main prompt, and its slash palette: the palette ends in a row count rather than
    // this hint, and its rows are set out in two columns, which are commands, not answers
    expect(parseInteractivePrompt("pi", piScreen(""))).toBeNull();
    const palette = piScreen(" /model\n → settings                        Open settings menu\n   model                           Select model\n   tree                            Navigate session tree\n   (1/51)\n" + MENU_HINT);
    expect(parseInteractivePrompt("pi", palette)).toBeNull();
    // /tree navigates the session's branch, which the chat cannot undo: its hint says "↑/↓ move"
    expect(parseInteractivePrompt("pi", piScreen("   Session Tree\n  ↑/↓ move · ←/→ page · ctrl+←/→ branch · ctrl+x copy\n  Type to search:\n────────────────────────────────────────\n  an entry\n  (0/1)"))).toBeNull();
  });

  test("tells a dialog apart from another of the same shape", () => {
    const other = select.replace("Block", "Block and say why");
    expect(parseInteractivePrompt("pi", select)!.id).not.toBe(parseInteractivePrompt("pi", other)!.id);
    // the id is the card's own content: what the chat polls keeps its answer open while pi
    // redraws around the dialog, and turns stale only when the dialog itself changes
    expect(parseInteractivePrompt("pi", select.replace("0.0%/215k (auto)", "12.3%/215k (auto)"))!.id).toBe(parseInteractivePrompt("pi", select)!.id);
  });
});

// Both screens captured from pi 0.87.1 running /model in a pane of its own, at 140 columns and
// at 46, with the catalogue already settled.
describe("pi's model list", () => {
  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const MODEL_HINT = " Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel";
  const wide = `────────────────────────────────────────

Only showing models from configured providers. Use /login to add providers.
>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default
    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]
Could not refresh llama.cpp; showing cached models.
${MODEL_HINT}
────────────────────────────────────────${FOOTER}`;

  test("reads the catalogue, naming the model answering now", () => {
    const prompt = parseInteractivePrompt("pi", wide)!;
    expect(prompt.kind).toBe("question");
    expect(prompt.question).toBe("Select model (currently vllm/Qwen/Qwen3.8-27B [lwsa-platform])");
    expect(prompt.options.map((option) => option.label)).toEqual([
      "vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default",
      "vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]",
    ]);
    // pi's own notes sit among the rows — the refresh failure at column zero, `Model Name:`
    // indented — and none of them is a model pi can be switched to
    expect(prompt.options.length).toBe(2);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("navigates from where pi drew the cursor, which is the model in use", () => {
    const moved = wide.replace("→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]",
      "  ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n→ vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]");
    const prompt = parseInteractivePrompt("pi", moved)!;
    expect(prompt.question).toBe("Select model (currently vllm/Qwen/Qwen3.8-27B [lwsa-platform])");
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("voids a catalogue whose rows run out mid-name rather than offering the ones before it", () => {
    // a screen redrawn while pi is still writing it ends a row in the middle of its provider
    // bracket. Stopping there is right, but the rows before it were already collected, and
    // offering them is a catalogue pi never drew: the reader would count down into a list whose
    // rest does not exist, and the count the card shows would not be the list pi has. This is the
    // same call the wrapped-name check makes — a row that cannot be read voids the reading
    const cut = `────────────────────────────────────────

Only showing models from configured providers. Use /login to add providers.
>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default
    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]
    another-model [provider-
${MODEL_HINT}
────────────────────────────────────────${FOOTER}`;
    expect(parseInteractivePrompt("pi", cut)).toBeNull();
  });

  // Captured from pi 0.87.1 running /model in a 46-column pane, the width a phone leaves it:
  // the hint splits across two lines, and so does a model's own name, which drops the provider's
  // bracket — the one mark that tells a row from pi's notes — onto a line of its own at column
  // zero, where it looks exactly like a note. Every check here is read off that capture.
  const narrow = `──────────────────────────────

Only showing models from configured providers.
Use /login to add providers.
>

→ ✓ vllm-flash/Qwen3.8-Flash-Next
[lwsa-platform] · default
    vllm/Qwen/Qwen3.8-27B [lwsa-platform]

  Model Name: qwen-3-8-flash

  Refreshing model catalogs…

  Enter to select · Ctrl+S to set as default ·
Escape/Ctrl+C to cancel
──────────────────────────────
/tmp/pn
0.0%/215k (auto)  vllm-flash/Qwen3.8-Flash-Nex
`;

  test("reads the catalogue off a phone's pane, joining the rows pi wrapped", () => {
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt).not.toBeNull();
    expect(prompt.options.map((option) => option.label)).toEqual([
      "vllm-flash/Qwen3.8-Flash-Next [lwsa-platform] · default",
      "vllm/Qwen/Qwen3.8-27B [lwsa-platform]",
    ]);
    expect(prompt.question).toBe("Select model (currently vllm-flash/Qwen3.8-Flash-Next [lwsa-platform])");
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("stops the catalogue at pi's notes, which the narrow pane indents like a row", () => {
    // `Model Name:` and `Refreshing model catalogs…` sit two spaces in, the same indentation a
    // wrapped row's tail carries, and neither is a model pi can be switched to
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt.options.some((option) => /Model Name|Refreshing/i.test(option.label))).toBe(false);
  });

  test("goes stale on a phone's pane once the wrapped hint is buried", () => {
    expect(parseInteractivePrompt("pi", narrow)).not.toBeNull();
    expect(parseInteractivePrompt("pi", `${narrow}Some later output\nand more\n`)).toBeNull();
  });

  test("says nothing rather than offer a model that is only half a name", () => {
    // a bracket cut mid-word is not a provider: joining it back would invent `lwsa- platform`
    const cut = `────────────────────────

>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-
    vllm-flash/Qwen3.8-Flash-Next
${MODEL_HINT}
────────────────────────${FOOTER}`;
    expect(parseInteractivePrompt("pi", cut)).toBeNull();
    // filtering the list down to one model leaves nothing to choose between
    const one = wide.replace("    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]\n", "");
    expect(parseInteractivePrompt("pi", one)).toBeNull();
    // and with the cursor on no row at all, an answer would navigate from nowhere
    expect(parseInteractivePrompt("pi", wide.replace("→ ✓ vllm/Qwen", "  ✓ vllm/Qwen"))).toBeNull();
  });

  // Captured from pi 0.87.1 running /login in a 46-column pane. `↑↓ navigate` carries no `·`, so
  // pi keeps its footer under this dialog as it does everywhere else, and the hint's own wrap puts
  // it four lines from the bottom — further than a three-line window reaches. A phone leaves pi
  // exactly this wide, so every dialog it can be asked had no card at that width.
  const login = `──────────────────────────────

 Login

 Choose how to sign in.

 → Sign in with an account
   Sign in with an API key

 ↑↓ navigate  enter select  escape/ctrl+c
 cancel
──────────────────────────────
/tmp/pr
0.0%/215k (auto)  vllm-flash/Qwen3.8-Flash-Nex
`;

  test("reads a dialog whose wrapped hint sits over pi's footer", () => {
    const prompt = parseInteractivePrompt("pi", login)!;
    expect(prompt).not.toBeNull();
    expect(prompt.options.map((option) => option.label)).toEqual([
      "Sign in with an account",
      "Sign in with an API key",
    ]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("goes stale on a phone's pane once a wrapped dialog hint is buried", () => {
    expect(parseInteractivePrompt("pi", login)).not.toBeNull();
    // pi keeps the answered dialog on screen; what comes after buries the hint, and a card still
    // open then would press keys into whatever the pane shows by then
    expect(parseInteractivePrompt("pi", `${login}Some later output\nand more\n`)).toBeNull();
  });

  test("goes stale once the list is answered and buried", () => {
    expect(parseInteractivePrompt("pi", wide)).not.toBeNull();
    // pi keeps the answered list on screen; the next request's output buries the hint under it,
    // and the card must not stay open offering a switch into whatever the pane shows by then
    expect(parseInteractivePrompt("pi", `${wide}\nSome later output\nand more`)).toBeNull();
  });
});
