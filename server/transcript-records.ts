/** Shared native-record rules keep paging, rendering and on-demand results consistent. */
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { skillInvocationPrompt } from "./skill-activity.ts";
import { trimOutput } from "./tool-output.ts";

type Row = Record<string, unknown>;
export const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const string = (...values: unknown[]): string | undefined => values.find((value) => typeof value === "string") as string | undefined;
export const resultText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.map((part) => typeof record(part).text === "string" ? record(part).text : "").join("") : "";

export function isContextClear(value: unknown, source: string): boolean {
  const entry = record(value);
  if (source === "codex-transcript" || source === "scrollback") return false;
  if (source !== "claude-transcript") return entry.type === "custom" && entry.customType === "context_clear";
  const message = record(entry.message);
  if (entry.type !== "user" || entry.isMeta || entry.isCompactSummary || message.role !== "user" || typeof message.content !== "string") return false;
  // Require a whole local-command envelope; quoting /clear in prose is not a reset.
  return /^\s*<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/.test(message.content);
}

/** Pi-family providers use several spellings for the same tool call/result fields. */
export function piMessage(value: unknown): Row | null {
  const entry = record(value);
  const message = record(entry.message);
  if (entry.type !== "message" || message.display === false || entry.display === false) return null;
  const raw = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
  const content = raw.map((value) => {
    const block = record(value);
    if (block.type === "toolCall") return { ...block, name: string(block.toolName, block.name), id: string(block.toolCallId, block.id, block.callId), arguments: block.toolInput ?? block.input ?? block.arguments };
    if (block.type === "toolResult") return { ...block, toolCallId: string(block.toolCallId, block.callId, block.id), content: block.output ?? block.content ?? block.result };
    return block;
  });
  return { ...message, toolCallId: string(message.toolCallId, message.callId), content };
}

/**
 * One entry's tool results, with the images each carries. pi reads a picture into a tool
 * result as inline base64 beside the text it returns, so only the position is carried in the
 * page: the bytes stay in the file and are fetched when the row is opened, the same way a
 * user-pasted image is. `index` counts the images of that one result, which is what the
 * page's ref quotes, so a fetch never has to agree with the parse about anything else.
 */
export function piResults(message: Row): { id: string; text: string; error: boolean; images: string[] }[] {
  const blocks = message.role === "toolResult" ? [message] : Array.isArray(message.content) ? message.content.filter((block) => record(block).type === "toolResult") : [];
  return blocks.flatMap((value) => {
    const block = record(value);
    if (typeof block.toolCallId !== "string") return [];
    const images = (Array.isArray(block.content) ? block.content : []).map(piImageOf).filter((image): image is { media_type: string; data: string } => image !== null).map((image) => image.media_type);
    return [{ id: block.toolCallId, text: resultText(block.content), error: block.isError === true, images }];
  });
}

/** The image types a chat shows; pi names the type `mimeType` where Claude names it `media_type`. */
const PI_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function piImageOf(value: unknown): { media_type: string; data: string } | null {
  const image = record(value);
  if (image.type !== "image") return null;
  const type = typeof image.mimeType === "string" ? image.mimeType : typeof image.media_type === "string" ? image.media_type : null;
  if (type === null || !PI_IMAGE_TYPES.has(type) || typeof image.data !== "string") return null;
  return { media_type: type, data: image.data };
}

/**
 * The `index`th image of the tool result answering `toolCallId`, decoded. `message` must
 * come from piMessage: pi-family providers spell the content field differently, and the
 * page's ref was built from the normalised one, so reading a raw entry could answer with
 * the wrong block.
 */
export function piImageBlock(message: Row, toolCallId: string, index: number): { media_type: string; data: string } | null {
  if (piResults(message).every((result) => result.id !== toolCallId)) return null;
  const blocks = message.role === "toolResult" ? [message] : (Array.isArray(message.content) ? message.content : []).filter((block) => record(block).type === "toolResult" && record(block).toolCallId === toolCallId);
  const images = blocks.flatMap((value) => { const block = record(value); return (Array.isArray(block.content) ? block.content : []).map(piImageOf); }).filter((image): image is { media_type: string; data: string } => image !== null);
  return index >= 0 ? images[index] ?? null : null;
}

/** Enough turns for a conversation. */
export const MAX_TURNS = 100;

/**
 * gjc wakes the agent with a `custom_message` (a background job's result, `display: true`)
 * in the user's seat: the answer before it is final and the work after it is a new turn.
 * Merging across it buried that answer in the work block. The envelope is chrome.
 */
export function piNotice(value: unknown): string | null {
  const entry = record(value);
  if (entry.type !== "custom_message" || entry.display === false || typeof entry.content !== "string") return null;
  const text = entry.content.trim().replace(/^<system-notice>\s*/, "").replace(/\s*<\/system-notice>$/, "").trim();
  return text.length > 0 ? text : null;
}

/** The one-line summary a collapsed tool chip shows. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  // pi names a file `path` where Claude names it `file_path`; both are worth showing.
  const first = input["command"] ?? input["file_path"] ?? input["path"] ?? input["pattern"] ?? input["description"] ?? input["url"];
  return typeof first === "string" ? first.slice(0, 120) : name;
}

/**
 * Splits one omp session jsonl into turns. Same shape of result as the Claude
 * parser: adjacent assistant messages merge, toolCall parts adopt the output
 * of the toolResult entry that answers them (matched by toolCallId), thinking
 * stays private to the agent.
 */
export function parseOmpTranscript(text: string, maxTurns = MAX_TURNS, options: { toolImages?: boolean } = {}): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  /** tool parts still waiting for their result, by toolCall id */
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant") return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  const contentParts = (content: unknown): { type?: string; text?: unknown }[] =>
    Array.isArray(content) ? content.filter((part) => typeof part === "object" && part !== null) : [];

  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn tail line while omp is mid-append
    }
    if (entry === null || typeof entry !== "object") continue;
    if (isContextClear(entry, "omp-transcript")) { turns.length = 0; pending.clear(); continue; }
    const timestamp = (entry as { timestamp?: string }).timestamp;
    const notice = piNotice(entry);
    if (notice !== null) {
      turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "notice", text: notice }] });
      continue;
    }
    // pi folds old context into a summary of its own accord and on /compact. The entry is a
    // tree entry, not a message, so it reaches the chat only through this branch: the card
    // says where the conversation was cut, and pi keeps answering from the summary onward.
    // piNotice above only claims `custom_message`, so a compaction entry always reaches here.
    if ((entry as { type?: unknown }).type === "compaction") {
      const summary = (entry as { summary?: unknown }).summary;
      if (typeof summary === "string" && summary.trim().length > 0) {
        turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "compact", text: summary }] });
      }
      continue;
    }
    const message = piMessage(entry);
    if (message === null) continue;
    const applyResults = () => {
      for (const result of piResults(message)) {
        const tool = pending.get(result.id);
        if (!tool) continue;
        pending.delete(result.id);
        trimOutput(tool, result.text, result.id);
        if (result.error) tool.error = true;
        if (options.toolImages === true && result.images.length > 0) {
          // addressed by the call it answers: a nested result shares its entry with other
          // blocks, so the entry id alone could not say which one an image came from
          tool.images = result.images.map((media_type, index) => ({ media_type, ref: `pi:${result.id}:${index}` }));
        }
      }
    };
    if (message.role !== "assistant") applyResults();

    if (message.role === "user") {
      const prompt =
        typeof message.content === "string"
          ? message.content
          : contentParts(message.content)
              .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
              .filter((part) => part.length > 0)
              .join("\n");
      if (prompt.length === 0) continue; // image-only user parts have no text to show
      // a skill invocation reads as what the user asked, the skill as a chip on it: not as the
      // SKILL.md the runtime put before it. Kept on this record, so no page boundary can part them
      const invocation = skillInvocationPrompt(prompt);
      const asked = invocation === null ? prompt : invocation.request || invocation.skills.map((skill) => `/skill:${skill.name}`).join(" ");
      turns.push({ role: "user", ts: timestamp ?? null, parts: [{ kind: "text", text: asked }, ...(invocation?.skills ?? []).map((skill) => ({ kind: "skill" as const, skill }))] });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const turn = assistantTurn(timestamp);
      if (timestamp) turn.end_ts = timestamp;
      for (const block of message.content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; id?: unknown; arguments?: unknown; intent?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "toolCall" && typeof b.name === "string") {
          const input = (typeof b.arguments === "object" && b.arguments !== null ? b.arguments : {}) as Record<string, unknown>;
          const summary = typeof b.intent === "string" && b.intent.length > 0 ? b.intent : toolSummary(b.name, input);
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: summary.slice(0, 120),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          turn.parts.push(part);
          if (typeof b.id === "string") pending.set(b.id, part);
        }
        // unsupported transcript parts are intentionally ignored
      }
      // A provider can place a result beside its call in the same assistant record.
      applyResults();
      // a failed request (a 401, an overloaded provider) leaves an empty message: without its
      // error the chat showed the prompt with no answer at all
      if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
        turn.parts.push({ kind: "text", text: `Error: ${message.errorMessage}` });
      }
    }
  }

  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}
