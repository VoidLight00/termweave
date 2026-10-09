/** Synthetic long-task benchmark, no agent/store access. Run: bun scripts/benchmark-codex-transcript.ts */
import assert from "node:assert/strict";
import { createCodexTranscriptParser, parseCodexTranscript } from "../server/codex.ts";

const jsonl = (payload: unknown) => `${JSON.stringify({ type: "response_item", payload })}\n`;
const initial = `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n` +
  Array.from({ length: 500 }, (_, i) => jsonl({ type: "function_call", name: "exec_command", call_id: `c${i}`, arguments: '{"cmd":"ls"}' }) +
    jsonl({ type: "function_call_output", call_id: `c${i}`, output: "x".repeat(24_000) })).join("");
const appends = Array.from({ length: 25 }, (_, i) => jsonl({ type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: `Step ${i}` }] }));
const parser = createCodexTranscriptParser();
parser.write(initial);
let growing = initial;
let full = parser.snapshot();
const start = performance.now();
for (const addition of appends) { growing += addition; full = parseCodexTranscript(growing); }
const fullMs = performance.now() - start;
let incremental = parser.snapshot();
const next = performance.now();
for (const addition of appends) { parser.write(addition); incremental = parser.snapshot(); }
const incrementalMs = performance.now() - next;
assert.deepEqual(incremental, full);
console.log(JSON.stringify({ sourceBytes: Buffer.byteLength(initial), polls: appends.length, fullMs: Math.round(fullMs), incrementalMs: Math.round(incrementalMs), speedup: Number((fullMs / incrementalMs).toFixed(1)), equivalent: true }, null, 2));
