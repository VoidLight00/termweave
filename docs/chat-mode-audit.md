# Chat mode audit — 2026-09-22

Target: `herdr-web-ui`. Reference: local
`devswha/chatmux`, `main` at `3b1f3b49216157399e3fb9666a49c942908c3e32`.
Inspected its Codex session provider and native-session discovery. Chatmux is
AGPL-3.0 and this project is MIT: only behavior and native record shapes informed
the implementation; no source implementation was copied and no dependency added.

## Findings and changes

| Priority | Finding | Change | Effort / risk |
| --- | --- | --- | --- |
| 1 | Codex had no native transcript parser; terminal menus, tool displays and status lines became assistant messages. | Added `server/codex.ts`, connected through `server/conversation.ts`; ignore internal context, pair duplicate user/event records, attach tool outputs by call ID, preserve commentary/final phases. | Medium / session identity requires evidence. |
| 2 | Claude user messages stored as text-block arrays disappeared. | Preserve text alongside tool-result blocks; omit explicit metadata/compaction entries. | Small / parser regression tests. |
| 3 | Progress prose after the last tool appeared as a final answer. | `src/lib/workBlocks.ts` honors Codex commentary and final-answer phases. | Small / backward-compatible optional fields. |
| 4 | Old work blocks remained open after a new turn arrived. | Automatic folding follows the newest turn while explicit user toggles persist. | Small / browser verified. |
| 5 | Sending reset chat history and scroll state; slow interval polls could return out of order. | Reset only on pane changes and schedule the next conversation poll after completion. | Small / delayed real-request browser check. |
| 6 | Work duration included time waiting for the next user message. | Optional `end_ts` records the assistant's last activity; use task-completion timestamps when available. | Small / parser and browser checks. |
| 7 | Transcript cache missed same-size replacements and could cache an append under the wrong size. | Signature includes inode, size and mtime captured before reading; bound cache to 32 files. | Small / native-file HTTP regression. |

`src/components/ChatView.tsx` also renders Codex `cmd` inputs as commands, omits
fallback status rows, and keeps unresolved Codex terminal output in an explicitly
labelled, collapsed fallback. `ChatView.css` adds token-based fallback styling.
The HTTP source union and optional text phase/end timestamp are documented in
`shared/protocol.ts`. `createServer({ codexHome })` permits an isolated native
store in tests; production defaults to `CODEX_HOME` or `~/.codex`.

## Model and reasoning display

The conversation API now includes the latest recorded `metadata.model` and
`metadata.reasoning_effort`. `server/conversation-metadata.ts` reads Codex turn
contexts (including collaboration-mode settings), omp/omo model and thinking
changes, and Claude assistant-message models. Missing effort stays `null`; it is
never inferred from reasoning text. Model and effort are cached with the turns.

The composer status line displays the model and `Reasoning <level>` on desktop
and mobile, or `Reasoning —` when unavailable. Existing conversation polling
refreshes these labels even without a new message. Metadata is tagged with its
pane so a pane switch cannot display another conversation's settings; scrollback
fallback clears it. The live Codex API returned the configured model and `xhigh`
effort after the change. Refresh the page to load the rebuilt client.

## Session selection and limits

Resolution first checks herdr's native session path or open rollout descriptors
in this pane's Codex processes. Native session IDs can resolve through the local
read-only state database. Canonical paths must remain inside the Codex session
store; non-session files and subagent metadata are rejected.

The installed shared app-server TUI does not keep a rollout descriptor open, and
herdr did not return `agent_session` for the inspected live Codex pane. For this
case, read at most 32 cwd-matched state records and a 1 MiB tail per file; require
a substantial assistant-text match unique to one candidate in the pane's recent
output. This is a display-only inference, never an input/session binding. Never
choose a session solely because it is newest or shares the cwd. Ambiguous or
short-only output remains in the collapsed fallback. A new welcome card excludes
the preceding terminal output from matching.

At the time of the September 22 audit, native image-only turns and omo's same-cwd session ambiguity remained. The follow-up below addresses both. A full
chatmux provider/database architecture migration was rejected as unnecessary for
this terminal bridge. Copying its provider implementation was rejected because
of the different licenses. Input transport, approval navigation, agent launching
and terminal flow control were not part of this change.

## Verification

- `server/codex.test.ts`: injected context, duplicated messages, repeated real
  prompts, commentary/final separation, tool results, reasoning, durations,
  truncated records, output/history bounds, path containment, subagent rejection,
  ambiguous sessions and welcome-card boundaries.
- `server/conversation.test.ts` and `src/lib/workBlocks.test.ts`: Claude array
  user messages, metadata exclusion and explicit phase boundaries.
- `server/codex.contract.test.ts`: real herdr workspace + native files + HTTP;
  session resolution, same-size file replacement and missing-file fallback.
- `bun run typecheck` and `bun run build` passed. Full `bun test`: 226 passed,
  0 failed across 30 files (24.39s), including native metadata extraction and
  cached HTTP metadata responses.
- `bun scripts/chat-browser-qa.ts`: real backend and owned pane; final answer,
  hidden context, tool expansion, duration, automatic/manual folding, send-time
  history preservation, non-overlapping polls and collapsed fallback. Desktop
  and 390px mobile screenshots are in `evidence/chat-mode/` (gitignored). Model /
  reasoning updates without new messages and mobile label visibility also passed.
- Existing `bun scripts/ui-regression.ts` also passed: settings/theme, approval
  queue behavior, pane-owned drafts/uploads, session creation and mobile input.
- Read-only inspection of the existing Codex pane returned `codex-transcript`
  and excluded the injected project instructions. No input was sent to it.

The backend was restarted at the user's request on 2026-09-22, preserving its
watch mode, environment, token authentication and existing listen address.
The authenticated health check passed and the live Codex conversation endpoint
returned `codex-transcript`. The working tree's pre-existing terminal flow-control
changes were preserved and are included in the running tree.


## September 27 transcript fidelity follow-up

Reviewed [chatmux at b258b576](https://github.com/devswha/chatmux/tree/b258b5766f0b6b6c3b5db1474eed220f53524efb).
The changes adapt its attachment, session-correlation, strict paste-envelope and
incremental-log patterns to this bridge. No provider implementation was copied:
chatmux declares AGPL-3.0-or-later, while this repository remains MIT. No new
runtime dependencies or provider database were introduced.

1. **Codex attachments:** `server/codex-images.ts` recognizes native event
   `local_images`/`images` and response `input_image`/`local_image` records, including
   image-only turns. Event/response duplicates become one turn. Conversation JSON
   holds opaque references; the existing pane image endpoint reads the attachment
   on demand from that pane's retained rollout chain. Backtracked-away records
   cannot authorize a fetch. Remote URLs and non-raster images are excluded; local
   files and inline images have an 8 MiB bound. A local file may change or disappear,
   so Codex image responses are not cached. Relative image paths use the pane cwd.
2. **omo identity:** `server/omo.ts` uses canonical store-contained descriptors,
   native session metadata and `--session-id`. Without exact evidence, only a
   single omo runtime and single session created during it may be associated.
   Another same-cwd runtime, an unreadable peer, conflicting claims, missing
   timestamps or ambiguous candidates leave the terminal fallback. The process
   tree takes precedence over an SDK child's Claude label. There is no persistent
   cwd/newest-session guess, and this evidence never controls terminal input.
3. **Claude pastes:** only complete native wrappers with matching valid IDs are
   removed. Partial or mismatched tags, literal lookalikes and ordinary whitespace
   remain untouched, including CRLF input.
4. **Codex live tasks:** completed JSONL records within the last task are folded
   once. Pending calls, duplicate message pairs, metadata and an unfinished final
   line survive polling. HTTP snapshots are detached from parser state, so later
   results do not mutate prior answers. The existing page/window bounds remain;
   at most eight incremental task states and 32 MiB of retained source coverage
   are cached. Observed truncation, replacement and same-size timestamp changes
   invalidate parser state and cursor generations. Rewrites indistinguishable in
   inode, size and filesystem timestamps cannot be detected without rereading.

Validation includes attachment parser/HTTP tests, same-cwd real-herdr omo panes,
partial UTF-8/JSONL and rewrite equivalence against cold reads, and desktop/mobile
chat browser QA with a loaded image-only thumbnail. Tests own their workspaces and
transcript stores. `bun scripts/benchmark-codex-transcript.ts` compares 25 updates
to a synthetic 12.1 MB task: on the development machine, reparsing took 238 ms
versus 11 ms incremental (21.3x), with identical output. This measures parser work,
not end-to-end browser or live-session latency.

## History boundaries and late responses — 2026-09-27

Follow-up to the fidelity transfer: inspected chatmux
[`b258b57`](https://github.com/devswha/chatmux/tree/b258b5766f0b6b6c3b5db1474eed220f53524efb).
Adapted the native-record rules and request ownership idea independently for this
MIT bridge; no AGPL implementation or dependency was copied.

- `server/transcript-records.ts` normalizes omp/omo/gjc string messages, hidden
  messages (`display: false`), tool name/input/ID aliases, string results and
  embedded tool-result blocks. Rendering, page boundaries, metadata and whole
  output reads use the same visibility/result rules.
- Pi `custom/context_clear` and complete Claude `/clear` command envelopes reset
  turns and pending calls. A chunked scan finds the latest reset and keeps its
  offset between polls, scanning new bytes on append. Cold reads scan the file
  once. Paging cannot cross that offset; old cursors return `409 history_changed`.
  Compaction, quoted commands and torn records do not clear history. Reset control
  records must fit within the 64 KiB scanner carry limit.
- `ConversationResponse.history_id` stays stable across appends and changes on
  observed transcript replacement or clear. The client discards loaded history
  and late page responses at that boundary, including a clear with no next user
  prompt. Metadata starts unknown until recorded again after the reset. Old
  Claude images and tool results are excluded from subsequent asset reads.
- Whole tool-output requests belong to one machine, pane, history and tool ref.
  Target changes/unmount abort them; identity checks also reject late success or
  failure when a transport ignores abort. Repeated clicks share the active fetch.

Verification: `server/chat-history.test.ts` covers native shapes, hidden paging,
clear while appending, cached/held cursors, chunk boundaries, metadata and output
reads. `bun scripts/chat-history-browser-qa.ts` bundles the real React components
and controls response timing in Chrome; it covers stale pages, reused tool IDs,
PC switches, cancellation and both late success/failure. It touches no herdr pane.
The existing real-herdr Codex HTTP test also checks the additive history identity.

Large-output chunk APIs and a broader provider abstraction remain deferred:
whole-output reads retain their existing 2,000,000-character response cap and
still read the native file on demand. This change does not alter the input path.

### GJC pane binding (2026-09-28)

GJC resolution prefers a unique open JSONL file under the canonical
`~/.gjc/agent/sessions/` store, belonging to the requested pane's GJC process and
matching the pane cwd in its session header. When the writer does not keep that file
open, the bridge reads GJC's native `~/.gjc/agent/terminal-sessions/<terminal-id>`
breadcrumb (cwd and exact session path on separate lines). The key comes from the
running process's terminal; the breadcrumb must have been written during that process's
lifetime. Its cwd, canonical store containment, and transcript header are checked.
Linux uses `/proc`; macOS uses `ps` for the tty and process start time. macOS metadata
parsing is fixture-tested; an end-to-end macOS run is still required.

For GJC builds that publish neither signal, a bounded scan of the native store matches
substantial assistant text against the requested pane's visible output. Exactly one
same-cwd transcript must match; short/generic text and duplicate matches are rejected.
The local GJC 0.17.2 binary was verified with an isolated resumed session, no model
request, and no open transcript or breadcrumb: its native answer resolved correctly.

Directory descriptors, cwd matches alone, and transcript modification times do not establish
ownership. Missing, unreadable, stale or ambiguous evidence still returns
`no_session_path`; visible-text recovery also requires the identifying answer to remain
on screen. Custom GJC stores and terminal IDs that cannot be resolved remain
unsupported. No newest-file fallback is restored.

`server/gjc.contract.test.ts` covers distinct open files and fresh per-terminal
breadcrumbs in same-cwd panes, session switching, stale breadcrumbs and ambiguous
files against an isolated herdr session. `server/gjc-runtime.test.ts` checks macOS
metadata parsing and rejects mismatched cwd, path traversal and symlink escapes.
