import type { ConversationPart, SkillActivity } from "../../shared/protocol.ts";

/** Keep the latest recorded attempt per document/name within this assistant turn. */
export function turnSkills(parts: readonly ConversationPart[]): SkillActivity[] {
  const skills = new Map<string, SkillActivity>();
  for (const part of parts) {
    if (part.kind !== "tool" && part.kind !== "skill") continue;
    if (!part.skill) continue;
    const skill = part.skill;
    skills.set(`${skill.evidence}:${skill.path ?? skill.name}`, skill);
  }
  return [...skills.values()];
}
