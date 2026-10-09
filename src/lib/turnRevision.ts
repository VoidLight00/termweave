import type { ConversationTurn } from "../../shared/protocol.ts";

/**
 * What changes when a turn's content does. Each poll parses the page anew, so a turn that did not
 * change is still a new object: keyed on the object, a message the chat could not draw was drawn
 * (and failed, and logged) again on every poll that changed some other turn. A 32-bit FNV-1a hash
 * of the parts, so a rewrite of the same length tells too (two contents can still collide).
 */
export function turnRevision(turn: ConversationTurn): string {
  let hash = 0x811c9dc5;
  const add = (value: string): void => {
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
    hash = Math.imul(hash ^ 0x1f, 0x01000193);
  };
  for (const part of turn.parts) {
    add(part.kind);
    if (part.kind === "text" || part.kind === "thinking" || part.kind === "compact" || part.kind === "notice") add(part.text);
    // a tool row draws its name, summary, input, output, error, images and skill: all of it counts
    else add(JSON.stringify(part));
  }
  return `${turn.role}|${turn.ts ?? ""}|${turn.end_ts ?? ""}|${turn.parts.length}|${(hash >>> 0).toString(36)}`;
}
