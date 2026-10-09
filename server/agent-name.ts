/**
 * herdr's agent.start takes a name no other agent in the session holds (it answers
 * `agent_name_taken` otherwise), and a name is a lowercase letter followed by lowercase
 * letters, digits, '-' or '_', 32 characters at most (`invalid_agent_name`). A client that
 * names no agent gets the kind while it is free, then `<kind>-2`, `<kind>-3`, ...
 */
const MAX_LENGTH = 32;

export function freeAgentName(kind: string, taken: Iterable<string | null | undefined>): string {
  const used = new Set(taken);
  if (!used.has(kind)) return kind;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const name = `${kind.slice(0, MAX_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(name)) return name;
  }
}
