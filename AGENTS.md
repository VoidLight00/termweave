# AGENTS.md: install TermWeave

You are an AI coding agent. A person asked you to install TermWeave. Follow these steps in order.

## 1. Get the source

```sh
git clone https://github.com/VoidLight00/termweave.git
cd termweave
```

Do not edit files in the clone. The installer copies only clean, committed files.

## 2. Check first

```sh
sh scripts/install.sh --check
```

This changes nothing. Exit code 0 means installed and running. Exit code 2 means a prerequisite is missing. Exit code 1 means not installed or not running yet.

## 3. Install and start

```sh
sh scripts/install.sh
```

It checks git, Bun 1.4+, Node 18+ and herdr 0.9.0+. It installs into `~/.local/share/termweave-owned`, runs `bun install --frozen-lockfile`, builds, starts the server on `127.0.0.1:7317`, and waits for health. Running it again is safe.

Options: `--port N`, `--dir PATH`, `--no-start`, `--yes`.

## 4. Verify

```sh
curl -s http://127.0.0.1:7317/api/health
```

Expected: JSON that starts with `{"ok":true,"herdr":{"version":...`. Then tell the person to open `http://127.0.0.1:7317` in a browser.

## Ask the person before you

- Run with `--yes`. It runs the official Bun installer (`curl -fsSL https://bun.sh/install | bash`) and the official herdr installer (`curl -fsSL https://herdr.dev/install.sh | sh`).
- Install Node, git or any other system software.
- Open access from outside this computer: Tailscale, Cloudflare tunnel, `HOST=0.0.0.0`, `TERMWEAVE_EXTERNAL_ACCESS=1`.
- Sign in to any service, or create or change a token.

Never print, log or commit a token.

## Optional features (off by default)

- Phone: easiest with Tailscale on both devices. It needs `HERDR_WEB_TOKEN` and `TERMWEAVE_EXTERNAL_ACCESS=1`. Ask first.
- Cloudflare tunnel: same token rules. Ask first.
- Android companion: build from `mobile/android`. See `docs/mobile-android-integration.md`.
- OpenRig teams: turn on later from the OpenRig panel in the app.
- Resume agents after a reboot (macOS): follow `docs/proxy-session-restore.md`. If the person starts Claude Code or Codex through a proxy or wrapper (claude-code-router, LiteLLM, `ANTHROPIC_BASE_URL`, `codex --profile`), step 4 of that guide is required. Without it, a resumed session can switch to a different model.

## Common errors

| Message | Fix |
| --- | --- |
| `MISS bun not found` (exit 2) | `curl -fsSL https://bun.sh/install \| bash`, open a new shell, rerun. |
| `MISS herdr not found` (exit 2) | `curl -fsSL https://herdr.dev/install.sh \| sh`, rerun. Docs: https://herdr.dev/docs/install/ |
| `MISS node not found` (exit 2) | Install Node 18+ (nodejs.org, nvm or `brew install node`). |
| `install failed ... clean git clone` | The clone has local edits. Run `git status`, then `git stash` or clone again. |
| `exists but is not a TermWeave install` | Pass `--dir` with a new path. |
| `port 7317 is used by another server` | Rerun with `--port 7318`. |
| `herdr does not answer` | Start herdr in a terminal (`herdr`), then rerun. |
| `did not answer within 40 s` | Read `~/.local/share/termweave-owned/server.log`. |

## Stop

```sh
kill -TERM "$(sed -n 's/.*"launcher":\([0-9]*\).*/\1/p' ~/.local/share/termweave-owned/lifecycle.json)"
```

## Windows (native, no WSL)

On Windows, use `install.ps1` from the clone instead of `scripts/install.sh`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --check
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --stop
```

- Exit codes and `--check`/`--yes`/`--no-start`/`--dir`/`--port` work as above. The default dir is `%LOCALAPPDATA%\termweave-owned`.
- Prerequisites: git, Bun 1.4+ and herdr 0.9.0+. Node is not needed on Windows.
- The person starts herdr. Ask before `--yes`. It runs `irm https://bun.sh/install.ps1 | iex` and `irm https://herdr.dev/install.ps1 | iex`.
- Stop only with `install.ps1 --stop`. It uses the recorded port. Never run `Stop-Process` or `taskkill` with a remembered PID. If the stop fails, follow INSTALL.md.
- Open `msedge --app=http://127.0.0.1:7317`.
- `install.ps1` and `install.sh` both run the shared lifecycle entry: `bun scripts/install-lifecycle.ts <check|install|start|stop> --dir PATH`.

Tests for the Windows port:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-install.test.ps1
bun test ./scripts/install-lifecycle.test.ts
bun scripts/windows-native-acceptance.ts --self-test
bun scripts/verify-isolated.ts type build unit render source-style
```

Real-machine evidence: `scripts/windows-native-acceptance.ts`. See INSTALL.md (M10). The self-test does not count as real-machine evidence.
