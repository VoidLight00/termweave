# Review priorities

Report concrete failing scenarios and regressions before style suggestions. A passing
AI review is advisory; CI and maintainer review determine whether a PR can merge.

- This app bridges herdr-owned PTYs. Never use `--takeover`, load node-pty in Bun,
  or rebuild terminal output from viewport snapshots. Keep xterm scrollback at zero.
- Observe connections cannot input, send keys or resize. Enforce this on the server.
- Never queue terminal input across disconnections. Only control frames replay.
- Concurrent attaches share pending creation; detach/close during creation must cancel
  that client's claim. Release the sidecar after its last client leaves.
- Each herdr RPC needs a fresh socket; only subscriptions stay connected. Pass the
  same socket to terminal attach through `HERDR_SOCKET_PATH`.
- Tests mutate only panes they create and use temporary app state. UI/media captures
  use isolated test/demo sessions. Preserve the user's running terminals and push keys.
- Generate `shared/herdr-api.generated.ts` from the committed schema. Check changes
  to HTTP/WS contracts on both client and server and cover them with contract tests.
- A malformed VAPID file must fail without rotating the key. The service worker must
  show a notification for every push, including while the app is visible.
- Preserve IME and native clipboard input. Use existing theme tokens for component CSS.
- Installed updaters discover Git tags immediately. Release only the exact commit
  that passed CI; never create the release tag as a prerequisite for validation.
- External contributors' PRs get the same priority and the same bar as maintainers'
  own: review them when they arrive and consider them for the next release. Approve
  their CI runs only after reading everything CI executes: workflows, scripts, tests,
  `package.json` scripts and dependency changes. Workflows must keep read-only PR
  permissions and never add a `pull_request_target` trigger.

[CONTRIBUTING.md](../CONTRIBUTING.md) is the process contributors follow. Maintainers may
keep local AGENTS.md notes, but a PR is held only to rules committed in this repository.
