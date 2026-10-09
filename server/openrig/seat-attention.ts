/**
 * Whether an OpenRig seat (team node) needs a person, and why, from the fields OpenRig 0.6.7
 * reports on /api/rigs/:id/nodes. Strongest signal first: a recorded error, a held seat, an agent
 * waiting for input, then a failed or attention-required startup/lifecycle. An agent whose activity
 * is unknown is resting, not stuck: unknown alone never asks for help.
 */
export type SeatAttentionReason = "error" | "held" | "needs_input" | "failed" | "attention_required";
export interface SeatAttention { needed: boolean; reason: SeatAttentionReason | null; detail: string | null }

const DETAIL_MAX = 200;
const text = (value: unknown): string | null => {
  if (typeof value === "string") return value.trim() ? value.trim().slice(0, DETAIL_MAX) : null;
  if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") return text((value as { message: string }).message);
  return null;
};

export function seatAttention(node: Record<string, unknown>): SeatAttention {
  const error = text(node["latestError"]);
  if (error) return { needed: true, reason: "error", detail: error };
  const held = text(node["heldReason"]);
  if (held) return { needed: true, reason: "held", detail: held };
  const activity = node["agentActivity"] && typeof node["agentActivity"] === "object" ? node["agentActivity"] as Record<string, unknown> : {};
  if (activity["state"] === "needs_input") return { needed: true, reason: "needs_input", detail: text(activity["reason"]) };
  const states = [node["lifecycleState"], node["startupStatus"]];
  if (states.includes("failed")) return { needed: true, reason: "failed", detail: null };
  if (states.includes("attention_required")) return { needed: true, reason: "attention_required", detail: null };
  return { needed: false, reason: null, detail: null };
}
