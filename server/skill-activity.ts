import { basename, dirname } from "node:path";
import type { SkillActivity } from "../shared/protocol.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n<>]/.test(value) ? value : null;

/** No filesystem lookup: evidence belongs to the bound transcript, including remote PCs. */
export function skillDocument(path: unknown): SkillActivity | null {
  if (typeof path !== "string" || path.length > 4096 || /[\r\n]/.test(path)) return null;
  const normalized = path.replaceAll("\\", "/");
  if (!normalized.endsWith("/SKILL.md")) return null;
  const name = label(basename(dirname(normalized)));
  return name && name !== "." ? { name, path, evidence: "instructions", status: "loaded" } : null;
}

/** Codex's explicitly selected skill is injected as one complete user-context envelope. */
export function selectedSkill(text: string): SkillActivity | null {
  const match = /^<skill>\s*<name>([^<>\r\n]+)<\/name>\s*<path>([^<>\r\n]+)<\/path>[\s\S]*<\/skill>$/.exec(text.trim());
  if (!match) return null;
  const name = label(match[1]);
  const document = skillDocument(match[2]);
  return name && document ? { ...document, name } : null;
}

const SKILL_INSTRUCTION = /^The user explicitly invoked the "([^"]+)" skill\. Follow the instructions in <skill-instruction> as binding for this request, while respecting higher-priority instructions\.\n\n<skill-instruction name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill-instruction>/;
const LEGACY_SKILL = /^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** pi names the skill file it loaded: a SKILL.md, or a standalone `.md` skill (`--skill review.md`). */
function loadedSkill(name: string | undefined, location: string | undefined): SkillActivity | null {
  const skill = label(name);
  if (skill === null || typeof location !== "string" || location.length === 0 || location.length > 4096 || /[\r\n]/.test(location)) return null;
  return { name: skill, path: location, evidence: "instructions", status: "loaded" };
}

/**
 * The prompt omp/omo record when the user invokes a skill (`/skill:name`, `$name`, a keyword): the
 * whole SKILL.md before the request, tens of KB the user never typed. Mirrors pi's own
 * `parseSkillBlock` (core/skill-invocation.ts): chained invocations, then `<user-request>`, or the
 * legacy `<skill name location>` form. Anything else is left as the user's text.
 */
export function skillInvocationPrompt(text: string): { skills: SkillActivity[]; request: string } | null {
  const skills: SkillActivity[] = [];
  let remainder = text;
  let match = SKILL_INSTRUCTION.exec(remainder);
  while (match !== null) {
    const skill = match[1] === match[2] ? loadedSkill(match[1], match[3]) : null;
    if (skill === null) return null;
    skills.push(skill);
    remainder = remainder.slice(match[0].length);
    if (!remainder.startsWith("\n\nThe user explicitly invoked the ")) break;
    remainder = remainder.slice(2);
    match = SKILL_INSTRUCTION.exec(remainder);
    if (match === null) return null;
  }
  if (skills.length > 0) {
    if (remainder.length === 0) return { skills, request: "" };
    const request = /^\n\n<user-request>\n([\s\S]*?)\n<\/user-request>$/.exec(remainder);
    return request ? { skills, request: request[1]!.trim() } : null;
  }
  const legacy = LEGACY_SKILL.exec(text);
  const skill = legacy ? loadedSkill(legacy[1], legacy[2]) : null;
  return skill ? { skills: [skill], request: legacy![3]?.trim() ?? "" } : null;
}

export function invokedSkill(name: string, input: Record<string, unknown>): SkillActivity | null {
  if (name !== "Skill") return null;
  const skill = label(input.skill);
  return skill ? { name: skill, evidence: "invocation", status: "requested" } : null;
}

/** Codex records parsed read paths even for commands executed inside code-mode tools.
 * Unknown shell scripts stay unknown: a mention/search of SKILL.md is not a read. */
export function codexReadSkills(value: unknown): SkillActivity[] {
  const item = record(value);
  if (item.type !== "CommandExecution" || !Array.isArray(item.parsed_cmd)) return [];
  if (item.status !== "completed" && item.status !== "failed") return [];
  const status = item.exit_code === 0 ? "loaded" : typeof item.exit_code === "number" ? "failed" : null;
  if (!status) return [];
  return item.parsed_cmd.flatMap((value) => {
    const command = record(value);
    const skill = command.type === "read" ? skillDocument(command.path) : null;
    return skill ? [{ ...skill, status }] : [];
  });
}

/** Older Codex rollouts only record tool calls. Recognize a literal, single file
 * read; shell scripts, searches, writes, interpolated paths and mentions stay out. */
export function codexReadCall(name: string, args: Record<string, unknown>): SkillActivity | null {
  if (name === "read_file" || name === "Read") {
    const skill = skillDocument(args.file_path ?? args.path);
    return skill ? { ...skill, status: "requested" } : null;
  }
  if (name !== "exec_command" && name !== "shell_command" && name !== "shell") return null;
  const cmd = args.cmd ?? args.command;
  if (typeof cmd !== "string" || /[\n;&|<>`$]/.test(cmd)) return null;
  const match = /^(?:cat|head(?:\s+-n\s+\d+)?|sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?)\s+(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))\s*$/.exec(cmd.trim());
  const skill = match ? skillDocument(match[1] ?? match[2] ?? match[3]) : null;
  return skill ? { ...skill, status: "requested" } : null;
}
