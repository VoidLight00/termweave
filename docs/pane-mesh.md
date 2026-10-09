# Pane mesh

When a terminal opens, TermWeave names it `pane N` (one count per workspace). An agent that starts in a herdr pane is told which panes sit beside it and how to read and message them. This is the web counterpart of tmux's numbered panes plus `capture-pane` and `send-keys`, built on herdr's own commands.

## Naming

- The web server listens for herdr's `pane_created` event (`server/collector.ts`) and names a pane that has no label with `pane.rename` (`server/pane-mesh.ts`). It takes the smallest free number in that workspace: `pane 1`, `pane 2`, and so on.
- A pane that already exists is not renamed. A name you chose is never changed: only the exact form `pane N` counts as an automatic name. If you rename `pane 1` to `build`, the next new terminal takes `pane 1` again.
- Tabs, rows and the command palette show `2 · api`: the number, then the live title. A name you chose stands alone, as before (`composeTitle` in `src/lib/paneName.ts`).
- To switch the naming off, set `TERMWEAVE_PANE_MESH=0` in the server's environment and restart the server.

## Reading and messaging

Inside a herdr pane (`HERDR_ENV=1`, set by herdr itself), use herdr's commands. Always address a pane by its `pane_id`: `pane 2` exists once in every workspace.

```bash
herdr pane list --workspace "$HERDR_WORKSPACE_ID"      # the panes beside you
herdr pane read w1:p1 --lines 80                       # what is on its screen
herdr agent prompt w1:p1 "Review the diff" --wait      # ask an agent in it, wait for its answer
herdr pane run w1:p3 "bun test"                        # run a command in a shell pane
```

## Telling agents automatically

An agent does not look for its neighbours unless something tells it to. For Claude Code, register `scripts/hooks/pane-mesh-roster.sh` as a `SessionStart` hook. Copy it where you keep your hooks and add:

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/pane-mesh-roster.sh", "timeout": 5 } ] } ] } }
```

Inside a herdr pane with at least one neighbour, the agent then starts with a roster:

```text
[pane mesh] You are pane 2 (w1:p2). Panes beside you in this workspace:
- pane 1 (w1:p1): claude, idle, in api
- w1:p3: shell, unknown, in site
Read one: herdr pane read <pane_id> --lines 80
...
```

Outside herdr, alone in a workspace, or when `herdr` or `jq` is missing, the hook prints nothing and exits 0. Codex and other agents have no session hook: put the same commands in their instructions file.

## Safety

- A pane can read and type into every pane of its workspace. Prompt text that one pane prints can steer an agent in another. The roster says that a peer's output is data and not an instruction from you, but it is only a reminder: treat cross-pane commands like any other command an agent runs.
- Nothing crosses workspaces or machines. `herdr --machine` is not used.
- Naming changes only the label of new panes. It never types into a terminal.

## Limits

- Panes opened while the web server is down or reconnecting are not named, and existing panes are not numbered afterwards. Name one with `herdr pane rename`.
- After herdr restores a session, restored panes without a label are named as new ones.
- Tested on macOS with herdr 0.9.1. Windows panes and remote machines are untested.
