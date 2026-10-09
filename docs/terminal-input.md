# Terminal input

The terminal keeps xterm.js and the herdr-owned PTY. Mobile input improvements live at the
input boundary; the terminal screen is still rendered from the attach stream.

## Input modes and drafts

Settings → Appearance → Terminal input mode offers Automatic, Input line and Direct typing.
Automatic keeps the existing device preference: a touch screen uses the input line unless the
user previously chose direct typing; a fine pointer uses direct typing. The key bar's keyboard
button switches modes too, on a touch screen only: a desktop changes the mode in Settings.
Settings → Shortcuts can change each app action's Mod+Shift key or return its keys to the
terminal. The hold-to-dictate binding remains fixed. Conflicts include the legacy New session
alias, and Reset restores the defaults. Browser-reserved keys still depend on the browser and
installed-app mode.

The input line keeps its unsent text per `paneStorageId(machineId, paneId)`, including across
lens changes and reloads. Storage refusal falls back to memory for view changes. Pending sends
are shared across mounts, so switching modes cannot submit the same pending line twice. A late
acknowledgement removes only an unchanged sent prefix; replacement text stays even if it happens
to equal the text sent before it. Editing remains available while disconnected; sending does not.
Passwords continue to use the separate non-persistent secret-input path.

Direct input arriving before readiness or during a disconnect is held for explicit Send/Discard.
An IME may commit several code points at once, so printable chunks (including emoji) are retained.
Control sequences are counted as discarded, never saved for later execution. No draft is replayed
on reconnect. The input-line and chat Send buttons preserve an active composition, and the key bar
waits for composition to finish. Leaving the input clears its composition guard.

## Readiness and failures

A server advertising `input-ready` sends `{type:"input-ready", pane_id}` only after the attach's
initial output has passed refusal detection, or when an existing ready attachment is joined.
`ready:false` revokes readiness when that attachment ends or retries. A mirrored attachment uses
the existing RPC input path. Legacy unattached mirror input remains serialized with submits.
Clients talking to an older bridge use its first output, after capabilities are known, as the
compatibility signal. A screen frame alone does not establish readiness on a new bridge.

`input_not_ready` reports a rejected PTY input. `input_failed` reports an RPC or local sidecar
write failure; the UI displays it outside the terminal stream. These are not acknowledgements
that the application consumed individual keystrokes. Failed input is never automatically retried.
The new readiness frame is also implemented in the website demo transport.

## Verification

- `bun run test:unit`: multi-codepoint held input, size/control boundaries, owner isolation,
  replacement edits before acknowledgements, shortcut overrides/conflicts, and old/new bridge readiness.
- `bun run test:integration`: actual UTF-8 input through the owned PTY into a file, non-attached
  client rejection, attach refusal/resume, mirror ordering, disconnect and sidecar lifecycle.
- `bun run build && bun scripts/terminal-input-regression.ts`: focused browser checks for desktop
  mode switching, pane and reload persistence, an unfinished composition, unmount during composition,
  pending-send remounts, replacement text, shortcut customization, first held-input persistence,
  readiness delay, an xterm composition commit, batched commits before punctuation, and Korean
  final-consonant movement. Submit/input interception isolates UI assertions;
  contract tests separately verify real delivery.
- `bun run test:ui`: includes those checks plus the existing mobile, clipboard, secret-entry,
  reconnect, prompt, queue and viewport checks. `UI_EVIDENCE_DIR` saves screenshots.
- `bun scripts/file-viewer-regression.ts`: existing navigation and touch regressions.

Synthetic composition events exercise event handling, not a real Samsung/Gboard/iOS IME.
Validate rapid Hangul, final-consonant movement, Enter, Backspace, dictation, keyboard-app round
trips and pane changes on those keyboards before claiming universal IME compatibility.

## Upstream findings and limits (2026-10-03)

- [xterm #6089](https://github.com/xtermjs/xterm.js/issues/6089) and
  [PR #6090](https://github.com/xtermjs/xterm.js/pull/6090): rapid composition under renderer load;
  the proposed patch is unmerged. Stock 5.5.0 was independently reproduced dropping both syllables
  of `니다.` when completions and punctuation arrive before deferred timers. A limited backport
  drains pending commits in order, uses the live selection end for interrupted compositions, and
  tracks emitted offsets to prevent duplicates. It reads corrected DOM text rather than stale
  `compositionend.data`, retaining the `핫 → 하세` case. The readable source patch is in `patches/`;
  Vite builds that source through `scripts/build-xterm.ts` so the patch is present in the shipped
  app, not just unused TypeScript. Version changes fail closed until the patch is revalidated.
  The queue/watermark approach follows @joonhoekim's proposal in #6090 (MIT); the backport targets
  5.5.0 and is maintained here pending an upstream release. Reset/disposal also invalidate deferred
  composition work so old input cannot enter a newly selected pane. The app resets in a layout
  effect, before another task can deliver the previous pane's commit.
- Related to [xterm #3600](https://github.com/xtermjs/xterm.js/issues/3600), native Gboard testing
  reproduced stale editor context after Backspace: `가나다 `, two deletes, then `한글` + Enter
  delivered `가나다 \x7f\x7fㅎㅏㄴ글\r`. Clearing the scratch editor on non-composing Backspace
  fixes this case; active compositions and screen-reader mode retain their existing editor behavior.
  This does not declare every case in that umbrella issue resolved.
- [xterm #6078](https://github.com/xtermjs/xterm.js/issues/6078), broader stale-text re-emission,
  remains a separate regression target; this change does not claim to resolve all its triggers.
- [#6084 was retracted](https://github.com/xtermjs/xterm.js/issues/6084#issuecomment-5162622279):
  the reporter identified a missing UTF-8 locale and a harmful custom IME bridge. Do not adopt that
  workaround. Check the spawned session's locale when bytes are corrupted downstream; do not
  replace an explicitly configured user locale blindly.
- [Termux's text input view](https://github.com/termux/termux-tools/blob/master/doc/termux.1.md.in#text-input-view)
  supports retaining an editable input surface alongside direct terminal input. Its
  [composition preview PR](https://github.com/termux/termux-app/pull/5242) is still unmerged.
- Mosh-style speculative local echo is not added. It addresses network responsiveness and needs
  a separate reconciliation design; it does not repair text lost before transmission.

### Native Safari check

On 2026-10-03, Safari 26.2 on an EA MacBook Air (macOS 26.2), reached through an SSH tunnel
inside Tailscale, passed Unicode text entry, draft reload, direct/line mode switching and the
batched composition regression (`["니", "다", "."]`). The Safari WebDriver session used an
owned test workspace and was deleted afterward. These checks use WebDriver text entry and
synthetic composition events; they do not certify a physical Korean IME or an iOS keyboard.

### Native Android/Gboard check

On 2026-10-03, an Android 16 Google Play x86_64 emulator (API 36 revision 7, Pixel 7,
1080×2400 at 420 dpi) ran Chrome **133.0.6943.137** and Gboard
**15.1.08.726012951-preload-x86_64**, with Korean two-bulsik selected. These are the system
image's bundled versions, not a claim about the newest Android Chrome/Gboard releases.

`scripts/android-ime-regression.ts` taps Gboard's actual on-screen keys through ADB; it does
not inject text or composition events for the typing assertions. A plain HTML textarea is the
control, followed by the app's input line and direct terminal. The direct-input oracle is the
raw bytes received by a Node capture process in an owned herdr workspace.

Passed: `한글 ` in the input line, reload persistence, direct word commits, final-consonant
movement (`값` + `아` → `갑사`), Backspace during composition, and three repetitions of
`가나다 ` → Backspace twice → `한글` → Enter. Before the Backspace fix, the last sequence
failed twice; the integrated build produced the exact expected bytes in every recorded trial.
The initial Gboard language-model download must finish before testing: a plain textarea that
only produces compatibility jamo is a fixture failure, not evidence of an app defect. Restart
Gboard after that download if necessary.

To repeat, boot an owned emulator with the same screen geometry, choose Korean two-bulsik in
Gboard, enable Chrome command-line support, build the app, then run:

```sh
ANDROID_IME_SERIAL=emulator-5580 \
ANDROID_ADB=/path/to/android-sdk/platform-tools/adb \
UI_EVIDENCE_DIR=/tmp/herdr-android-evidence \
bun scripts/android-ime-regression.ts
```

The script refuses physical-device serials, creates and closes its own workspace/server and
reverse forwarding, and saves native screenshots plus event evidence when requested. The caller
owns emulator startup/shutdown. Samsung Keyboard, newer Gboard/Chrome builds, iOS keyboards,
voice recognition and foldable posture still require separate checks.
