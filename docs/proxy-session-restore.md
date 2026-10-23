# Resume agent sessions after a reboot (proxy users included)

You are an AI coding agent, for example Claude Code or Codex. A person asked you to make their agent sessions come back after a reboot. Follow the steps in order. Report each check with its real output. This guide is for macOS.

## What this does and does not do

- herdr restores workspaces, tabs and panes after a reboot. A reboot stops every process, so each agent pane comes back as an empty shell.
- `tools/resurrect/termweave-resurrect` records the agent session in each pane every 60 seconds. After the next boot, it resumes each session in the same pane.
- It finds Claude Code sessions in `~/.claude/sessions`. It finds Codex only when Codex runs from the npm package for Apple silicon (`codex-darwin-arm64`).
- It does not keep sessions alive while the computer is off. A Cloudflare tunnel or Tailscale only forwards traffic to this computer. When this computer is off, the tunnel has nothing to forward to.
- To keep agents running while a laptop is off, run herdr, TermWeave and the proxy on an always-on computer. Connect to it from the laptop.

## Who must do step 4

Do step 4 if the person starts Claude Code or Codex through a proxy or a wrapper script. Examples:

- claude-code-router (CCR), LiteLLM or another local router.
- A script that sets `ANTHROPIC_BASE_URL`, a model route or a context size, and then starts `claude`.
- `codex --profile <provider>` or `codex -c model_provider=...`.

Without step 4, the old restore ran plain `claude --resume <id>`. That command does not get the base URL, model or context settings of the wrapper. Claude Code then shows these lines:

- `Session model ... could not be restored`
- `Switched to Opus ... because ... is not available`
- Many `Conversation compacted` lines, and then `Prompt is too long`

The session then continues on a different model with less context. The current restore does not do this. It leaves a proxied pane empty when the pane has no resume hint. The log gives the reason.

## 1. Check the prerequisites

```sh
command -v herdr python3 curl base64
herdr pane list >/dev/null && echo "herdr OK"
```

Expected: four paths and `herdr OK`. If herdr does not answer, start herdr first.

## 2. Install the restore daemon

Run these commands from the root of the TermWeave clone.

```sh
python3 tools/resurrect/test_resurrect.py
mkdir -p ~/.local/bin ~/.local/state/termweave
cp tools/resurrect/termweave-resurrect ~/.local/bin/termweave-resurrect
chmod +x ~/.local/bin/termweave-resurrect
```

Expected: `test_resurrect: ok`. Stop if the test fails.

Write the LaunchAgent. launchd does not expand `$HOME`, so the shell writes the real path into the file.

```sh
herdr_dir="$(dirname "$(command -v herdr)")"
cat > ~/Library/LaunchAgents/com.termweave.resurrect.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>com.termweave.resurrect</string>
 <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>$HOME/.local/bin/termweave-resurrect</string><string>daemon</string></array>
 <key>EnvironmentVariables</key><dict><key>PATH</key><string>$herdr_dir:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
 <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
 <key>StandardErrorPath</key><string>$HOME/.local/state/termweave/resurrect.stderr.log</string>
</dict></plist>
EOF
plutil -lint ~/Library/LaunchAgents/com.termweave.resurrect.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.termweave.resurrect.plist
```

Wait 90 seconds. Then check the daemon and the snapshot.

```sh
launchctl print gui/$(id -u)/com.termweave.resurrect | grep -m1 -E "^\s+state ="
python3 ~/.local/bin/termweave-resurrect cmd
```

Expected: `state = running`. The second command prints one line for each agent pane: `<pane> -> <command>`.

## 3. Read the snapshot

Each pane in `~/.local/state/termweave/resurrect.json` has these fields:

| Field | Meaning |
| --- | --- |
| `kind`, `id`, `cwd` | Agent type, session id and folder. |
| `resume` | The command from the wrapper hint. `{id}` is the session id. |
| `health` | A URL that must answer before the restore runs `resume`. |
| `proxied` | `true` if the agent uses a proxy. A proxied pane without `resume` stays empty. |

`termweave-resurrect cmd` prints `(left empty: proxied without a resume hint)` for a pane that needs step 4.

## 4. Proxy users: add a resume hint to the wrapper

The restore reads two environment variables from the agent process. Child processes inherit them from the wrapper.

| Variable | Value | Required |
| --- | --- | --- |
| `TERMWEAVE_RESUME_CMD_B64` | Base64 of one shell command that resumes the session. Write `{id}` where the session id goes. | Yes |
| `TERMWEAVE_RESUME_HEALTH` | The URL of the router. The restore waits up to 120 seconds for any HTTP answer. | Recommended |

Obey these rules:

1. Export both variables in the wrapper before the line that starts `claude` or `codex`.
2. Make the command start the same wrapper with the same model and profile.
3. Use an absolute path for the wrapper.
4. Do not put a token, key or password in the command. The snapshot stores the command as plain text.
5. Use the permanent address of the router for `TERMWEAVE_RESUME_HEALTH`. Do not use a temporary relay port.
6. Keep the base64 value on one line.

Bash wrapper that starts Claude Code through a router:

```bash
# Put these lines before the line that starts claude.
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
printf -v tpl '%q ' "$self" "$model" --resume          # model = the model argument of the wrapper
export TERMWEAVE_RESUME_CMD_B64="$(printf '%s{id}' "$tpl" | base64 | tr -d '\n')"
export TERMWEAVE_RESUME_HEALTH="http://127.0.0.1:3456/"  # the port of the router
```

zsh wrapper: replace the `printf -v` line with `tpl="${(q)self} ${(q)model} --resume "`.

Codex with a provider profile. Use a shell alias if there is no wrapper:

```sh
alias cx='TERMWEAVE_RESUME_CMD_B64=$(printf %s "codex resume --profile myproxy {id}" | base64 | tr -d "\n") codex --profile myproxy'
```

`ANTHROPIC_BASE_URL` set for every shell in `~/.zshrc`: a new shell gets the same proxy, so plain resume keeps the model. Tell the restore that:

```sh
export TERMWEAVE_RESUME_CMD_B64="$(printf %s 'claude --resume {id}' | base64 | tr -d '\n')"
```

Start a new agent through the changed wrapper. Agents that run now keep their old environment. Wait 90 seconds and run `termweave-resurrect cmd` again. Expected: the pane shows the wrapper command, not `(left empty ...)`.

## 5. Router as a service: remove a stale PID file

Some routers write a PID file and refuse to start when that PID is alive. claude-code-router (`ccr start`) does this. After a reboot, macOS can give that PID number to a different process. The router then prints `server is running` and stops. launchd starts it again, and the loop continues. In one measured case, the loop ran 141 times in 27 minutes.

Make the service remove the PID file before it starts the router. launchd only, `ProgramArguments`:

```xml
<array>
  <string>/bin/sh</string>
  <string>-c</string>
  <string>rm -f "$HOME/.claude-code-router/.claude-code-router.pid"; exec /abs/path/to/node /abs/path/to/claude-code-router/dist/cli.js start</string>
</array>
```

`/bin/sh` expands `$HOME` here. Do this only when launchd is the only process that starts the router.

Check with a planted stale PID. PID 1 is always alive:

```sh
echo 1 > ~/.claude-code-router/.claude-code-router.pid
launchctl kickstart -k gui/$(id -u)/<router label>
sleep 5; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3456/
launchctl print gui/$(id -u)/<router label> | grep -E "^\s+runs ="
```

Expected: an HTTP code that is not `000`. The `runs` value does not increase after 30 seconds.

## 6. Test the restore without a reboot

Do this test. Do not report success without it.

1. Create a test workspace: `herdr workspace create --cwd "$PWD" --label resurrect-test --no-focus`. Record `pane_id` and `workspace_id`.
2. Start a proxied agent in it: `herdr pane run <pane_id> "<wrapper> <model>"`.
3. Send one short prompt with `herdr pane send-text` and `herdr pane send-keys <pane_id> enter`. The transcript must exist.
4. Take a test snapshot: `TERMWEAVE_RESURRECT_STATE="$TMPDIR/rt.json" python3 ~/.local/bin/termweave-resurrect snapshot`.
5. Check that the test pane in `$TMPDIR/rt.json` has `resume` and `health`. Its `id` is the session id.
6. Find the agent PID: the `pid` in the `~/.claude/sessions/*.json` file that has that `sessionId`. Run `kill -TERM <pid>`.
7. Edit `$TMPDIR/rt.json`. Set `boot` to `"test"`. Keep only the test pane in `panes`.
8. Run the restore: `TERMWEAVE_RESURRECT_STATE="$TMPDIR/rt.json" python3 ~/.local/bin/termweave-resurrect restore`.
9. Wait 15 seconds. Run `herdr pane read <pane_id>`. Expected: the banner shows the proxy model and the earlier prompt.
10. Find the new PID of the same `sessionId`. Run `ps eww -o command= -p <pid>`. Expected: `TERMWEAVE_RESUME_CMD_B64=` is present.
11. Search the transcript `~/.claude/projects/*/<sessionId>.jsonl` for `could not be restored` and `Switched to`. Expected: zero matches.
12. Close the test workspace: `herdr workspace close <workspace_id>`.

Fail-closed check (optional, 2 minutes): repeat steps 6 to 8 with `health` set to `http://127.0.0.1:1/`. Expected: after 120 seconds, `~/.local/state/termweave/resurrect.log` says `did not answer in 120s, left empty`. The pane stays a shell.

## Roll back

```sh
launchctl bootout gui/$(id -u)/com.termweave.resurrect
rm ~/Library/LaunchAgents/com.termweave.resurrect.plist ~/.local/bin/termweave-resurrect
```

Remove the two `export` lines from the wrapper. Restore the router plist from a backup, then run `launchctl bootout` and `launchctl bootstrap` for it.

## Prompt for your agent

Copy this prompt into Claude Code or Codex:

```text
Read docs/proxy-session-restore.md in https://github.com/VoidLight00/termweave.
Apply it on this Mac. Back up each file before you change it.
Ask me before you restart a service that runs now.
Do the test in section 6. Report each check with its real output.
```

한국어로 지시하려면 아래 문장을 그대로 붙여 넣으면 됩니다.

```text
https://github.com/VoidLight00/termweave 의 docs/proxy-session-restore.md 를 읽고 이 Mac에 적용해 주세요.
파일을 바꾸기 전에 각각 백업해 주세요. 실행 중인 서비스를 재시작하기 전에는 먼저 물어봐 주세요.
6번 테스트를 실행하고, 각 확인 항목을 실제 출력과 함께 보고해 주세요.
```
