# TermWeave installation

Use the reviewed local source instructions in [README](./README.md) and CONTRIBUTING. No curl|sh installer, automatic prerequisite upgrade, public exposure or upstream plugin replacement is supported. External access needs explicit opt-in and authentication. Runtime bundle distribution remains unsupported.

Every platform installs from a clean git clone into an owned directory and starts the same server on `127.0.0.1`. The front end differs:

| Platform | Front end | Needs |
| --- | --- | --- |
| macOS, Linux | `sh scripts/install.sh` | git, Bun 1.4+, Node 18+ (terminal sidecar), herdr 0.9.0+ |
| Windows 10 1809+ / 11 (native, no WSL) | `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1` | git, Bun 1.4+, herdr 0.9.0+. Node is not needed and not checked. |

Both front ends use exit code 0 for ok, 2 for a missing prerequisite and 1 for any other failure. Both call `scripts/install-lifecycle.ts` (see [Starting and stopping an owned install](#starting-and-stopping-an-owned-install)).

## macOS and Linux: scripts/install.sh

```
sh scripts/install.sh [--check] [--yes] [--no-start] [--dir PATH] [--port N]
```

- The default directory is `~/.local/share/termweave-owned`. `TERMWEAVE_INSTALL_DIR` changes it, and `--dir` takes precedence over both.
- The default port is 7317. `PORT` changes it, and `--port` takes precedence over both.
- `--check` changes nothing. `--yes` allows the official installers: `curl -fsSL https://bun.sh/install | bash` and `curl -fsSL https://herdr.dev/install.sh | sh`.
- Node 18+ is required here, for the terminal sidecar. Install it yourself from nodejs.org, nvm or Homebrew. `--yes` does not install Node.
- Stop the server with the command the installer prints: `(cd "$DIR" && bun scripts/install-lifecycle.ts stop --dir "$DIR")`.

## Windows: install.ps1

Run `install.ps1` as a file from a clean clone of TermWeave. It is not an `irm | iex` script. It needs no administrator rights and never elevates itself. `-ExecutionPolicy Bypass` applies only to this one PowerShell process.

```
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [--check] [--yes] [--no-start] [--stop] [--dir PATH] [--port N]
```

| Option | Meaning |
| --- | --- |
| `--check` | Verify prerequisites, install and health. Changes nothing. Every other option except `--dir`/`--port` is ignored, `--yes` included. |
| `--yes` | Allow the official Bun and herdr installers when they are missing. |
| `--no-start` | Install and build, but do not start the server. |
| `--stop` | Stop the installed server. It uses the recorded port; an explicit `--port` must match it. |
| `--dir PATH` | Install directory. Default: `$env:TERMWEAVE_INSTALL_DIR`, else `%LOCALAPPDATA%\termweave-owned`. |
| `--port N` | Local port for a new start. Default: `$env:PORT`, else 7317. A running instance keeps its recorded port. |

### Bun only, and the herdr you start

- TermWeave on Windows runs on Bun alone. It needs no Node and no WSL. git is still needed, because the installer copies committed files from the clone.
- Start herdr yourself, in a terminal of your choice (`herdr`). `install.ps1` never starts or stops herdr.
- If herdr is not running, the server still starts and keeps running. The start reports `herdr is not ready` and exits 1. Start herdr, then run `--check`.
- With `--yes`, missing Bun and herdr are installed with their official installers: `irm https://bun.sh/install.ps1 | iex` and `irm https://herdr.dev/install.ps1 | iex`. Each installer runs in its own `powershell.exe -NoProfile` with TLS 1.2 enabled. A failed installer makes `install.ps1` exit 1 and prints the cause (download, proxy, TLS or policy) with the command to run by hand.
- `install.ps1` re-reads the Machine and User `Path` from the registry, read only, after an installer runs. You do not need a new terminal.
- Without `--yes`, a missing Bun ends `--check` and every other mode with exit 2 and the fix command.

### Check: exit 0, 1 or 2

`powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --check` writes nothing: no download, mutex, lock, log, file or registry write.

- **0**: this install's own server is running (process identity and bridge `boot_id` match) and the full `/api/health`, herdr included, is ok.
- **1**: not installed, not running, another server owns the port, or herdr is not ready.
- **2**: a prerequisite is missing (git, Bun 1.4+ or herdr 0.9.0+).

### Install directory, port and stop

- An existing install in `--dir` is reused, not rebuilt. To run a newer commit, install into a new `--dir`. A path that exists but is not a TermWeave install is refused.
- A new start uses `--port`, else `PORT`, else 7317. The running instance records its port in `<dir>\lifecycle.json`, and that record wins from then on:
  - `--stop` and `--check` use the recorded port, whatever `PORT` says.
  - `--stop --port N` with another port fails and sends nothing.
  - Starting again with another `--port` while it runs fails with "stop it first".
- Stop with `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --stop [--dir PATH]`. It stops the server gracefully and leaves herdr and Edge running. See [Starting and stopping an owned install](#starting-and-stopping-an-owned-install) for what it checks and what a failure prints.
- Changing runs (install, start, stop) of one Windows user are serialized by a per-user mutex. A second run waits up to 15 minutes, then fails. `--check` never takes the mutex.

### The server outlives the console

The server runs in the background, detached from the console and hidden. It is meant to keep running after you close the PowerShell window that ran `install.ps1`, until you run `--stop`.

- Automated tests show that it outlives the process that launched it.
- Closing a real console window is checked on a real machine (M10, below).
- Its output goes to `<dir>\server.log`.
- It does not start by itself after you sign out or restart Windows. Run `install.ps1` again.

### Edge app window or PWA

- Open TermWeave as an Edge app window: `msedge --app=http://127.0.0.1:7317`. Use the recorded port if it is not 7317. If `msedge` is not on `Path`, use `"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"`.
- Or install it as a PWA. Open the URL in Edge, then choose Apps > Install this site as an app.
- TermWeave does not create shortcuts.

### Supported Windows versions and architectures

- Windows 10 1809 or later and ARM64 are intended to be supported.
- Support is judged statically only. `install.ps1`, the lifecycle scripts (`scripts/install-lifecycle.ts`, `lifecycle-*.ts`, `process-identity.ts`, `owned-*.ts`) and the executable lookup contain no architecture checks, x64-only paths or x64-only binaries.
- Windows 10 1809 and ARM64 were not verified on real hardware. Whether Bun, herdr and Edge work together there is an open risk.

### Native window (deferred)

TermWeave has no native Windows window (WebView2/Tauri/Electron); the Edge app window or PWA is the supported path. A native window is reconsidered only if:

- Edge app key interception becomes a real problem, or
- Korean input fails in Edge.

A Tauri window would then need tao 0.36 or later, or a vendored patch: tao 0.35 deadlocks on Korean IME re-entry (Mymux `.issue/36`, CHANGELOG v0.2.1).

## Starting and stopping an owned install

`install.ps1` and `install.sh` run these commands for you; on Windows `install.ps1 --stop` is the stop front end. You can run them directly from the clone:

```
bun scripts/install-lifecycle.ts start --dir PATH [--port N]
bun scripts/install-lifecycle.ts stop  --dir PATH [--port N]
bun scripts/install-lifecycle.ts check --dir PATH
```

- `start` launches the server in the background and returns once it answers on `127.0.0.1`. If herdr is not running, the web server still starts and keeps running. `start` then reports `herdr is not ready` and exits 1. Start herdr and run `check`.
- `stop` stops the server gracefully. It uses the port recorded in `lifecycle.json`; `PORT` does not change it. If you pass a `--port` that differs from the recorded one, `stop` fails and sends nothing to either port.
- `stop` sends its request only after all of these checks pass:
  - The recorded server process is still the same process: same PID, start time and executable.
  - The bridge-only probe `/api/health?scope=bridge` on the recorded port answers with the recorded `boot_id`.
- herdr's state does not matter to `stop`. When the stop succeeds, the launcher removes `lifecycle.json` and exits. herdr and the browser are left running.
- Running `stop` again is safe. If nothing is running, it reports `not running` and exits 0. If an install or start is in progress, `stop` waits up to 10 s for it to finish.
- `check` exits 0 only when both are true:
  - this install's own server is running (process identity and bridge `boot_id` match);
  - the full `/api/health`, which includes herdr, is ok.
- The stop request is accepted only under these conditions:
  - It is a `POST` from this machine (loopback), and the `Host` header names the server's own port.
  - It carries no `Origin` or `Sec-Fetch-Site` header, so a browser cannot send it.
  - It carries the install instance's token in a header.
- The token is created for each launch. It is stored only in `lifecycle.json` inside the owned root, and the launcher passes it to the server through the environment, where the server deletes it at startup. It never appears in a URL, a command line, `server.log` or any output. Passing it through the environment does not hide it from an administrator of this machine.

### When stop fails

Nothing is ever killed automatically. A failed `stop` prints:

- the time of the check;
- the server's PID, start time and executable path;
- the launcher's PID and start time;
- the recorded port;
- the bridge probe result;
- guidance for the specific cause:
  - **The server accepted the stop but did not exit within 10 s.** It may still be finishing. Run `stop` again.
  - **The server process is alive but its port is silent** (hung or overloaded). The process is not killed and its state is not removed. Wait, then run `stop` again.
  - **Another boot id answers on the recorded port.** Another server holds the port, so no stop request was sent.

If you decide the server has to end now, use the PowerShell command that `stop` prints. Its form is:

```
$p=Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>'; if($p -and $p.CreationDate -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '<recorded start time>'){Stop-Process -Id <pid>}else{'Process <pid> changed or is gone: not stopped'}
```

Run it as printed. Just before stopping anything, it re-reads the process with CIM and compares the PID and CreationDate. If either changed, it stops nothing. The executable path is not compared here, because CIM can spell it differently from the recorded kernel path (for example through a junction); the start time is what rules out a reused PID. Windows reuses PIDs, so never run `Stop-Process` with a remembered PID number alone. After the server ends, the launcher removes `lifecycle.json` by itself. Then run `check` to confirm the state.

### Leftover lifecycle guard

Lifecycle commands serialize on a guard file next to the install directory (`.termweave-<digest>.guard`). If a lifecycle process crashed while it held the guard, `stop` reports `the lifecycle guard is still held`. This is not a server stop timeout. The report shows the guard path and the recorded owner, and no request is sent.

The guard is never removed automatically: no age, TTL, `--force` or "owner is gone" rule does it. An owner that is gone does not by itself make removal safe. Remove the guard by hand only during an offline maintenance window:

1. End every TermWeave lifecycle command for this install directory, including waiters, `install`/`start`/`stop` runs and the background launcher.
2. Make sure no new one can start.
3. Delete only the guard file named in the report.
4. Leave the work lock (`.termweave-<digest>.lock`) and `lifecycle.json` in place. The next normal command judges them again.

If you cannot confirm that nothing runs for this install, do not delete the guard. Afterwards, run `check`.

## Real-machine evidence on Windows (M10)

Some checks only a real Windows machine can make: the Edge app window, Korean input through the Microsoft IME, and `--stop` ending every owned process. Their before and after evidence is kept as UTF-8 text in `evidence/windows-native/<run-id>/`, written by `scripts/windows-native-acceptance.ts`:

| File | Content |
| --- | --- |
| `environment.txt` | candidate `git rev-parse HEAD`, `marker.source_sha`, install dir, OS/build/architecture, Windows PowerShell, Bun, herdr and Edge versions, recorded port and `boot_id`, commands run |
| `edge.before.txt`, `edge.after.txt` | app or PWA, URL and launch command, health, the checks and who confirmed them when (Needs-you by the user) |
| `ime.before.txt` | the original 9 sentences, their source and SHA-256, the test-owned pane, the IME condition |
| `ime.after.txt`, `ime.pane-read.json` | the raw `pane.read` answer, the extraction rule, per sentence the length and the first mismatching index and code point, and the n/9 result |
| `stop.before.txt`, `stop.after.txt` | owned launcher/server processes (PID, parent, CreationDate, executable, command line with secrets removed), N before and after, the filter rule, the stop exit code, `lifecycle.json`, the listener, herdr and Edge kept alive |
| `commands.txt`, `result.json` | every command with its exit code and output; per AC pass/fail/blocked/not-run, who confirmed it, file SHA-256s, CI run and pushed SHA, the 3G-C decision |

Rules the tool enforces:

- Each run installs into a new `--dir`. `init` refuses an existing directory.
- The install must be the candidate. `environment` checks that `marker.source_sha`, the HEAD recorded at `init` and the current HEAD are the same commit, that `marker.root` is the run's directory, and that the marker is newer than `init`.
- Collection is read only. Only `exec`, `pane`, `ime-before` and `pane-close` change anything, and only when you run them. They touch only the one herdr workspace the run created; your own panes are never written to.
- Evidence files are written once. A failed run is kept; start a new run id instead of repeating a step.
- A process query that is denied or fails is reported as blocked, never as 0 processes. Processes are matched by the exact owned script path in the command line (`<dir>\scripts\owned-server.ts start`, `<dir>\server\index.ts`) and by parent and start time. A string prefix is never enough.
- The IME comparison is code point by code point, spaces included. Nothing is trimmed or Unicode-normalized.
- Tokens, API keys and the stop token in `lifecycle.json` are never collected. Pane content is read only from the test-owned pane.

A run, in order:

```
bun scripts/windows-native-acceptance.ts init --run RUN --dir NEW_DIR
bun scripts/windows-native-acceptance.ts exec --run RUN -- powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --dir NEW_DIR
bun scripts/windows-native-acceptance.ts environment --run RUN
bun scripts/windows-native-acceptance.ts pane --run RUN
bun scripts/windows-native-acceptance.ts edge-before --run RUN --mode app
bun scripts/windows-native-acceptance.ts ime-before --run RUN --sentences FILE --sha256 HEX --source TEXT --ime TEXT
bun scripts/windows-native-acceptance.ts ime-after --run RUN
bun scripts/windows-native-acceptance.ts edge-after --run RUN --by user --verdict AC-B5=pass ...
bun scripts/windows-native-acceptance.ts stop-before --run RUN
bun scripts/windows-native-acceptance.ts exec --run RUN -- powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 --stop --dir NEW_DIR
bun scripts/windows-native-acceptance.ts stop-after --run RUN
bun scripts/windows-native-acceptance.ts finish --run RUN --ci-run URL --push-sha SHA --g3c not-triggered
```

Run `pane-close` once the Edge and IME checks are done. Record other ACs with `verdict`. `status` prints the AC table and checks the evidence links. `result.json` reports `real_machine_pass: true` only when:

- the binding holds;
- every real-machine AC passed;
- the CI run's pushed SHA is the candidate.

The user starts herdr, types the 9 sentences in Edge with the Microsoft Korean IME at normal speed, and confirms Needs-you. Automatic typing or key-interval timing does not replace this.

The canonical 9 sentences are not in the TermWeave repository: no commit of VoidLight00/termweave contains them. Its changelog describes the earlier WebKit test as 3 sentences at 60, 25 and 12 ms per key (9/9), recorded in an unpublished note (PM-20261009-04). Provide the original as a UTF-8 file without BOM: LF line ends, exactly 9 lines. Give its SHA-256 and where it came from. The tool refuses a file whose hash differs and never ships a copy.

`bun scripts/windows-native-acceptance.ts --self-test` checks the tool itself: the text comparison, the process filter, the binding, the evidence links and the result schema. Its `evidence/windows-native/self-test/result.json` has `kind: "self-test"` and `not_real_machine_evidence: true`. It is never real-machine evidence.

## Windows test coverage and POSIX-only skips

CI runs the same lanes (type, build, unit, render, source-style) plus `scripts/check-windows-invariants.mjs` on `ubuntu-24.04`, `macos-15` and `windows-latest`, and `scripts/windows-install.test.ps1` on Windows. A unit test is skipped on Windows only when it needs a POSIX host (tmux, `/bin/sh` or `/bin/bash` stand-ins, Unix sockets, POSIX signals or mode bits). Each skip is a single test with a reason comment; no file, folder or suite is skipped. Every skipped test still runs on ubuntu and macos.

| File | Tests skipped on Windows | Reason | Other coverage |
| --- | --- | --- | --- |
| `server/herdr-update.test.ts` | 10 updater-run tests, plus the 202/busy/405 part of the endpoint test | `#!/bin/sh` herdr stand-in; live handoff exists off Windows only, and the product answers `unsupported` on win32 | ubuntu/macos; on Windows, "offers nothing on Windows" and "refuses an update from anything but this app's own controls" |
| `scripts/pane-mesh-task.test.ts` | 5 CLI tests | Task ownership proves a herdr restart by the Unix socket's lstat identity; on win32 the CLI refuses with `native_server_identity_unavailable` | ubuntu/macos; on Windows, "Windows refuses task ownership without a native server identity and records nothing" |
| `scripts/pane-mesh-roster.test.ts` | 4 "P-number hook context" tests and the 4 `pane-mesh-roster.sh` tests | The hook is a `/bin/bash` script driving python3 and `#!/bin/sh` shims | ubuntu/macos |
| `server/pane-mesh-ownership.test.ts` | "reject a group or world readable state directory"; "deleting active state requires recovery in existing and new processes" | POSIX mode bits; POSIX unlink of a file SQLite holds open (Windows refuses with EBUSY) | ubuntu/macos; on Windows, "deleting closed active state requires recovery in a new process" |
| `server/openrig-service.test.ts`, `server/openrig/runtime.test.ts` | the 0o600 check only, split into its own test | POSIX mode bits; these files hold no secret | ubuntu/macos; the rest of each test runs on Windows |
| `scripts/plugin.test.ts` | "returns only once the server's process group is gone" | `sh` TERM trap and Unix process groups; the herdr plugin path is not a Windows target | ubuntu/macos; owned stop on Windows: `scripts/owned-stop.test.ts`, `scripts/windows-lifecycle.test.ts` |
| `scripts/tmux-mesh-isolation.test.ts`, `server/tmux/runtime.test.ts` | the real-tmux tests | Unix-socket tmux under `/tmp` with owner uid and 0700 checks; a Windows `tmux.exe` (psmux) is not such a host | ubuntu/macos |
| `server/tmux/metadata.test.ts` | "Git metadata observes branch and dirty state without running fsmonitor or exposing file names" | Serves only POSIX tmux pane paths; on Windows Git's `sh` maps `/tmp` elsewhere, so the fsmonitor probe cannot detect anything | ubuntu/macos; on Windows, the test that a non-POSIX cwd is refused |
| `server/tmux/ports.test.ts` | "port metadata belongs only to the selected process tree" | `ps` and `lsof` for the Unix-socket tmux adapter | ubuntu/macos |

Owner-only secret files (`voice.json`, `devices.json`, `vapid.json`, `push-subscriptions.json`) are not skipped on Windows. They are written by `server/private-file.ts` with a protected DACL that grants only the user and SYSTEM, and their tests check that DACL on Windows and mode 0o600 elsewhere.

`scripts/windows-plugin.test.ts` was retired. It tested the herdr plugin path on Windows, which is not a target; the plugin manifest declares Linux and macOS only. Owned install, launch and stop on Windows are covered by `scripts/windows-lifecycle.test.ts` and `scripts/owned-stop.test.ts`. `scripts/legacy-refusal.test.ts` still checks that the plugin's phone, start and stop are refused before any subprocess or signal.

Not yet on Windows: pane-mesh task ownership (needs a herdr server identity from the marker file and named pipe) and the pane directory's live herdr generation probe (`lsof`/`ps`); both fail closed rather than misidentify a server.
