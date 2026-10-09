import { expect, test } from "bun:test";
import { seatAttention } from "./seat-attention.ts";

test("strongest signal wins and unknown activity alone is rest", () => {
  expect(seatAttention({ latestError: { message: "boom" }, heldReason: "x" })).toEqual({ needed: true, reason: "error", detail: "boom" });
  expect(seatAttention({ heldReason: "waiting for review" })).toEqual({ needed: true, reason: "held", detail: "waiting for review" });
  expect(seatAttention({ agentActivity: { state: "needs_input", reason: "permission_prompt" } })).toEqual({ needed: true, reason: "needs_input", detail: "permission_prompt" });
  expect(seatAttention({ startupStatus: "failed" }).reason).toBe("failed");
  expect(seatAttention({ lifecycleState: "attention_required" }).reason).toBe("attention_required");
  // live 0.6.7 sample: stale hook, unknown activity, recoverable seat -> not asking for help
  expect(seatAttention({ agentActivity: { state: "unknown", reason: "stale_runtime_hook" }, lifecycleState: "recoverable", startupStatus: "ready", heldReason: null, latestError: null }).needed).toBe(false);
  expect(seatAttention({ latestError: "   " }).needed).toBe(false);
  expect(seatAttention({ latestError: "x".repeat(500) }).detail).toHaveLength(200);
});
