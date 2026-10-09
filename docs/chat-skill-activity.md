# Skill activity in chat

The chat shows a skill's name and recorded status above the assistant's work
block. This remains visible when work is folded and when thinking is hidden.
Open the indicator to see the evidence explanation and document path, when known.
English and Korean labels are provided; paths are text, not a new file-read API.

The display distinguishes evidence from workflow completion:

| Agent / record | Display |
| --- | --- |
| Claude assistant `Skill` tool, `input.skill` | Skill requested |
| Matching successful Claude tool result | Skill invoked |
| Matching Claude error result | Skill invocation failed |
| Codex complete selected `<skill>` envelope | Skill instructions loaded; the instruction body stays out of user bubbles |
| Codex literal `exec_command` / `shell_command` / `shell` file read, or `Read` / `read_file` | Reading skill requested, then loaded/failed from the result |
| Codex native `item_completed`, `CommandExecution` with a parsed `read` of `SKILL.md` | Loaded/failed from the recorded exit code, including code-mode calls |

Codex can choose a skill implicitly by loading its instructions; see the
[official skill documentation](https://learn.chatgpt.com/docs/build-skills).
Claude exposes explicit calls through its
[Skill tool](https://code.claude.com/docs/en/skills#restrict-claudes-skill-access).
Neither a successful invocation nor a document read proves that every step of a
skill has completed. The UI therefore does not display a skill-level completion
checkmark or infer the currently active skill from the pane's overall status.

The latest recorded attempt for a document/name is summarized within each
assistant turn. Repeated native event IDs are deduplicated. Late native events
whose turn ID differs from the current Codex task are ignored. Existing history
reset and pane/PC ownership rules discard old activity with the conversation.
The original tool input/output and failures remain in the expandable work rows.

Detection is deliberately limited to recorded evidence: available-skill lists,
plain names in prose, searches, edits to SKILL.md, and unknown shell scripts do not
count. A Codex version that omits structured read events and hides reads inside a
compound code-mode script cannot expose that activity through this bridge yet.
A literal read shows the skill directory name; an explicitly selected skill uses
its recorded name. Instructions are never executed or read from disk to enrich
this display. This change does not modify skill discovery, invocation syntax,
permissions or terminal input transport.

Implementation: `server/skill-activity.ts`, the Claude/Codex transcript parsers,
optional `SkillActivity` metadata in `shared/protocol.ts`, and
`src/lib/skillActivity.ts` / `src/components/ChatView.tsx`.

Verification: `server/skill-activity.test.ts` covers request/result state,
failures, selected-instruction filtering, lookalikes, incremental snapshots,
native event deduplication and turn/history isolation. The native Codex HTTP
contract test checks that the API carries activity without the instruction body.
`bun scripts/skill-activity-browser-qa.ts` bundles the actual React components and
uses both native parsers to check folded work, status updates, provenance, pane
reset and a 390px Korean/light layout in Chrome. Screenshots go to the ignored
`evidence/skill-activity/` directory; it touches no live herdr panes.
