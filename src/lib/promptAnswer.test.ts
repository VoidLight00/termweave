import { describe, expect, it } from "bun:test";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { answerFromText, answerHint, answerRefusal, needsConfirmation } from "./promptAnswer.ts";

const prompt = (options: string[], custom: number | null, multi = false): InteractivePrompt => ({
  id: "p", agent: "claude", kind: "question", title: "Question", question: "?", body: null,
  options: options.map((label) => ({ label, description: null })), multi_select: multi, custom_option_index: custom,
});

describe("answering a prompt from the chat", () => {
  it("reads the agent's option numbers, labels and bound letters, else the typed reply", () => {
    const question = prompt(["LM-O (Recommended)", "YCB-V"], 2);
    expect(answerFromText(question, "2")).toEqual({ option_index: 1 });
    expect(answerFromText(question, " lm-o ")).toEqual({ option_index: 0 });
    expect(answerFromText(question, "LM-O (Recommended)")).toEqual({ option_index: 0 });
    // the "type something" row is answered with text, not picked by its number
    expect(answerFromText(question, "3")).toEqual({ custom_text: "3" });
    expect(answerFromText(question, "use T-LESS instead")).toEqual({ custom_text: "use T-LESS instead" });
    expect(answerHint(question)).toBe("Answer above: type 1–2 or your own reply…");
  });

  it("answers a free-form question (Codex's queue) with the text itself, numbers included", () => {
    const freeForm = prompt([], 0);
    expect(answerFromText(freeForm, "1")).toEqual({ custom_text: "1" });
    expect(answerFromText(freeForm, "keep the logs")).toEqual({ custom_text: "keep the logs" });
    expect(answerHint(freeForm)).toBe("Answer above: type your reply…");
  });

  it("takes only an option for an approval", () => {
    const approval = { ...prompt(["Yes, proceed (y)", "Yes, and don't ask again (p)", "No, and tell Codex what to do differently (esc)"], null), kind: "approval" as const };
    expect(answerFromText(approval, "y")).toEqual({ option_index: 0 });
    expect(answerFromText(approval, "P")).toEqual({ option_index: 1 });
    expect(answerFromText(approval, "no, and tell codex what to do differently")).toEqual({ option_index: 2 });
    expect(answerFromText(approval, "4")).toBeNull();
    expect(answerFromText(approval, "maybe later")).toBeNull();
    expect(answerHint(approval)).toBe("Answer above: type 1–3 to choose…");
    expect(answerRefusal(approval)).toBe("Choose one of the options above: type 1–3.");
    // typed, an approval's pick waits for Confirm; a question's does not
    expect(needsConfirmation(approval, { option_index: 0 })).toBe(true);
    expect(needsConfirmation(prompt(["LM-O"], 1), { option_index: 0 })).toBe(false);
    expect(needsConfirmation({ ...prompt(["Yes", "No", "Tell Claude what to change"], 2), kind: "plan" }, { custom_text: "shorter" })).toBe(false);
    // Claude's review submits every answer, a Codex menu continues or stops: a typed pick waits too
    expect(needsConfirmation({ ...prompt(["Submit answers", "Cancel"], null), kind: "menu" }, { option_index: 0 })).toBe(true);
  });

  it("skips a plan's custom row inside the options and reads several numbers for a multiple choice", () => {
    const plan = prompt(["Yes, auto-accept edits", "Yes, manually approve edits", "No", "Tell Claude what to change"], 3);
    expect(answerFromText(plan, "4")).toEqual({ custom_text: "4" });
    expect(answerFromText(plan, "keep the intro")).toEqual({ custom_text: "keep the intro" });
    const multi = prompt(["LM-O", "YCB-V", "T-LESS"], null, true);
    expect(answerFromText(multi, "1, 3")).toEqual({ option_indices: [0, 2] });
    expect(answerFromText(multi, "1 1 2")).toEqual({ option_indices: [0, 1] });
    expect(answerFromText(multi, "1 and 3")).toBeNull();
  });
});
