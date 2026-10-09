# Changelog

herdr web ui is versioned with [semantic versioning](https://semver.org/). Each release is a
`vX.Y.Z` Git tag with a GitHub release. Installs update only to releases; commits on `main`
between releases do not reach them. Remote-PC runtime bundles are versioned separately as
`remote-vN` releases.

## [Unreleased]

## [0.3.45] - 2026-10-03

### Added
- **Settings → herdr → Update herdr** updates herdr itself from the app, on the PC the app runs
  on (Linux and macOS). herdr refuses `herdr update` typed into one of its panes, and every
  terminal in the app is a pane, so the server runs it instead: it installs the newest herdr and
  moves the running panes onto it. Panes and agents keep running, and open terminals reconnect.
  A newer herdr installed from a shell is picked up the same way.
  ([#373](https://github.com/devswha/herdr-web-ui/pull/373))

### Changed
- Each sidebar row has one `⋯` button in place of a hover pencil and a two-click X. Its menu
  renames the workspace or the pane and closes the row: a close that takes the workspace with it
  (a one-pane row, or **Close workspace** on a workspace header) asks first, as herdr's
  `ui.confirm_close` does, and a pane that leaves its workspace standing closes at once. On a
  phone the menu is a bottom sheet.
  ([#379](https://github.com/devswha/herdr-web-ui/pull/379))
- The sidebar has no top bar. A session starts from the `+` on its PC's header, as before, or from
  the **New session** button an empty PC now shows; Mod+Shift+N and the palette still open it on
  the selected PC. **Add PC** moved to Settings → Remote PCs, above the bridge auto-update switch,
  and the command palette has it too.
  ([#378](https://github.com/devswha/herdr-web-ui/pull/378))
- In the sidebar's By workspace view, a workspace with one pane is a single row again, as it was
  before 0.3.44: no numbered header above it, and the row carries the reorder handle and names
  its workspace on its second line. A workspace with several panes keeps its header. A fold made
  on a one-pane workspace in 0.3.44 no longer hides its row.
  ([#371](https://github.com/devswha/herdr-web-ui/pull/371))
- On a desktop the terminal no longer has a bar under it holding one keyboard button. The input
  line or direct typing is still chosen in Settings → Terminal input mode, and a touch screen
  keeps the button in its key bar.
  ([#372](https://github.com/devswha/herdr-web-ui/pull/372))

### Fixed
- An open terminal no longer says "terminal ended" when herdr hands its panes to a new server,
  as `herdr update --handoff` and `herdr server live-handoff` do. The pane is still running, so
  the terminal attaches to it again for everyone viewing it.
  ([#370](https://github.com/devswha/herdr-web-ui/pull/370))
- Cmd+Backspace on macOS sends Ctrl+U in the live terminal, deleting the input back to
  the start of the line instead of a single character. Pending IME text keeps its order.
  ([#347](https://github.com/devswha/herdr-web-ui/pull/347) by @WOULDU-pres)
- Opening a pane in the chat lens leaves its terminal at the size it has. A phone's chat lens, its
  keyboard included, no longer narrows the pane for a desktop showing it; switching to the terminal
  lens still fits the pane to that device. A remote PC gets this with its next bridge update.
  ([#363](https://github.com/devswha/herdr-web-ui/pull/363) by @WOULDU-pres)
- An OmO pane that has not been asked anything yet, or has just run `/new`, shows an empty chat
  instead of "Conversation unavailable". OmO writes its session file only with the first message,
  so the chat found no conversation until then and offered the terminal output instead.
  ([#360](https://github.com/devswha/herdr-web-ui/pull/360) by @nahwan-kim)
- An answer tapped on a prompt card for a screen the app does not know goes through while the
  agent's working line ticks on that screen. The card's id took in the line's spinner, time and
  token count, so a tap after each tick was refused with "the prompt changed" and took several
  tries. Anything else that changes on the screen still refuses the answer.
  ([#377](https://github.com/devswha/herdr-web-ui/pull/377), [#365](https://github.com/devswha/herdr-web-ui/pull/365) by @Haeminway1)

## [0.3.44] - 2026-10-03

### Added
- Native Windows x64 installation through `install.ps1`, with the same herdr plugin startup
  and updates. Windows needs Bun and Git, without Node or WSL, and keeps using the terminal
  screen mirror. ([#330](https://github.com/devswha/herdr-web-ui/pull/330) by @JJLiebig)
- Settings can choose Chat, Terminal, or Auto as the default view for panes. Changing it resets
  remembered pane views on this device. Shell panes still open in Terminal.
  ([#325](https://github.com/devswha/herdr-web-ui/pull/325) by @Haeminway1)
- Choose the terminal input line or direct typing on desktop as well as touch screens, and
  customize or unbind the app's Mod+Shift shortcuts with conflict checks and reset.
  ([#334](https://github.com/devswha/herdr-web-ui/pull/334))

### Changed
- In the sidebar's By workspace view, a workspace with one pane keeps its numbered header and
  can be folded, renamed and reordered from that header, just like a workspace with several panes.
  ([#332](https://github.com/devswha/herdr-web-ui/pull/332) by @beomq)
- The top usage panel shows larger percentages, remaining-capacity colors and compact reset
  countdowns with their local time. Expired reset times stay hidden until fresh usage arrives.
  ([#336](https://github.com/devswha/herdr-web-ui/pull/336) by @Haeminway1)
- Pane titles that contain a directory show its last folder, and matching workspace and folder
  names appear once in the sidebar and command palette, including Windows paths.
  ([#337](https://github.com/devswha/herdr-web-ui/pull/337) by @Haeminway1)
- In the sidebar's By workspace view, a pane row no longer repeats the workspace its header names.
  Its second line shows the folder only when neither the title nor the workspace already says it.
  ([#358](https://github.com/devswha/herdr-web-ui/pull/358))

### Fixed
- GJC conversations are resolved from the foreground process directory when it differs from
  the pane directory. ([#333](https://github.com/devswha/herdr-web-ui/pull/333) by @Kinetic27)
- Direct terminal input preserves rapid IME commits when punctuation arrives before composition
  timers run, with a bounded xterm 5.5 backport and Korean final-consonant regression checks.
  Native Android/Gboard checks also fixed stale editor text after Backspace breaking the next
  Hangul word. Secret entry now refuses a held or unready attachment and failed PTY writes.
  ([#334](https://github.com/devswha/herdr-web-ui/pull/334))
- New session in the browser demo opens the new session instead of leaving a blank page.
  ([#355](https://github.com/devswha/herdr-web-ui/pull/355))
- Terminal input keeps multi-character IME commits and emoji while disconnected, waits for the
  attachment before sending keys, and reports input failures. Unsent input lines survive pane,
  lens and mode changes; late acknowledgements preserve replacement edits. Composition keeps
  its Enter and Send button, and terminal key-bar taps wait until it finishes.
  ([#334](https://github.com/devswha/herdr-web-ui/pull/334))
- The background tasks list stays below the app header on a short screen, such as a phone held
  sideways, and scrolls inside the room above the message box.
  ([#354](https://github.com/devswha/herdr-web-ui/pull/354))
- The mobile message box sits closer to the home indicator while retaining its base spacing.
  ([#335](https://github.com/devswha/herdr-web-ui/pull/335) by @Haeminway1)
- Adding or reconnecting a remote PC says when herdr is not running or not answering there,
  instead of only `Bridge verification failed (500)`.
  ([#353](https://github.com/devswha/herdr-web-ui/pull/353))
- Shift+Enter in the live terminal sends the same newline chord as Alt+Enter, instead of plain
  Enter that submits an agent's message. Pending IME text is sent before the newline chord.
  ([#339](https://github.com/devswha/herdr-web-ui/pull/339) by @WOULDU-pres)
- On Windows, and from an install path with a space or a non-ASCII character, the app page loads
  instead of the "not built yet" notice. The Windows installer replaces a copy from a release
  without Windows support, and says so when a release cannot run there.
  ([#356](https://github.com/devswha/herdr-web-ui/pull/356))
- On an iPhone home screen app, a text field that keeps its focus with the keyboard down no
  longer leaves a status-bar band under the message box.
  ([#349](https://github.com/devswha/herdr-web-ui/pull/349) by @Haeminway1)
- After `/new` in an OmO pane, the chat stops showing the conversation before it: OmO writes the
  new session's file only with its first message, and until then the chat shows what a fresh OmO
  shows. ([#351](https://github.com/devswha/herdr-web-ui/pull/351) by @WOULDU-pres)
- On a Windows PC, an omo pane shows omo's mark instead of Claude's, and its chat finds the
  conversation: process words with `bun.exe`, backslashes and a drive letter read as omo, and the
  session folder is named as omo's engine names a Windows folder.
  ([#342](https://github.com/devswha/herdr-web-ui/pull/342) by @Haeminway1)
- The chat lens finds an omo pane's conversation when its process keeps its sessions outside
  `~/.omo/agent` (`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR` or `PI_CODING_AGENT_DIR`).
  ([#350](https://github.com/devswha/herdr-web-ui/pull/350) by @Haeminway1)

## [0.3.43] - 2026-10-02

### Changed
- The sidebar's rows are as they were before 0.3.42. Its new tab and split buttons took room from
  every pane's name, also while hidden, so the names were cut shorter. Both buttons are gone, and
  so are `POST /api/tab/create` and `POST /api/pane/split`.
  ([#327](https://github.com/devswha/herdr-web-ui/pull/327))

### Fixed
- The message box stays editable while the app reconnects. On an iPhone, a dictation keyboard such
  as Typeless or Wispr Flow opens its own app and comes back; the connection could drop meanwhile,
  the box was disabled and lost its focus, and the dictated text went nowhere. Sending still waits
  for the connection. ([#318](https://github.com/devswha/herdr-web-ui/pull/318) by @Haeminway1)
- New session starts an agent when another of the same kind is already running. The second
  Claude (or Codex, ...) used to get an empty workspace and `agent name claude is already used`,
  because every agent was named after its kind and herdr wants each name once. Later ones are now
  named `claude-2`, `claude-3` and so on. An agent is also started once the new workspace's shell
  is up, instead of being refused when it was not yet.
  ([#328](https://github.com/devswha/herdr-web-ui/pull/328))

## [0.3.42] - 2026-10-02

### Added
- Voice input in the chat composer and the terminal input line. Hold or tap the mic and speak,
  Korean and English mixed; the text lands in the box at the caret and is never sent by itself.
  It uses your own OpenAI API key, kept on the server (Settings → Voice input), and falls back to
  the browser's speech recognition without one. Off by default. Silence before, between and after
  the words is left out of the recording, so it is neither uploaded nor billed.
  ([#231](https://github.com/devswha/herdr-web-ui/pull/231) by @nahwan-kim)
- While the app is open, an alert drops in from the top edge as a card: an agent that needs input,
  one that finished (by this device's alert choice) or a terminal that ended. A tap opens that
  pane, a flick up puts the card away, and it leaves by itself after a few seconds. No card for
  the pane already open, and none while the bell is off. Settings → Alerts → In the app turns it
  off; it is on by default. Push and tab alerts are unchanged.
  ([#313](https://github.com/devswha/herdr-web-ui/pull/313) by @Haeminway1)
- The sidebar opens a new tab in a workspace (a `+` on the workspace, or on the row when it
  holds a single pane) and splits a pane beside itself, through `POST /api/tab/create` and
  `POST /api/pane/split`. The new pane is selected once herdr reports it.
  ([#307](https://github.com/devswha/herdr-web-ui/pull/307) by @piotrchabros)
- Settings → Appearance lets you group sidebar sessions by folder, combining panes with the
  same full working-directory path within each PC. Grouping by workspace remains the default;
  the selected mode and each mode's collapsed groups are remembered independently.
  ([#299](https://github.com/devswha/herdr-web-ui/pull/299) by @beomq)
- While an OmO pane has background tasks running, the chat's status line says how many, and tapping
  it lists them: what each is doing, its category and model, how long it has run, its turns, tool
  calls and tokens. The newest tasks that ended in the last day (up to ten) are one line under
  them that says how many ended and how many failed, and opens to show whether each finished,
  failed, was cancelled or was lost with OmO's process. A remote PC lists them once it runs a
  bridge that knows this list.
  ([#305](https://github.com/devswha/herdr-web-ui/pull/305), [#310](https://github.com/devswha/herdr-web-ui/pull/310))
- The same list shows the workflows (DAG runs) the OmO session started: each one's name, how many
  steps are done, running or failed, and its steps wave by wave, with why a failed step failed.
  A workflow that ended folds into the same line as the tasks that ended.
  ([#306](https://github.com/devswha/herdr-web-ui/pull/306))
- An OmO turn that set or updated a goal shows it on the turn, beside the skills, also while its work
  is folded: the objective, whether it is in progress, complete, blocked, paused or out of budget, and
  opened, the whole objective, why it is blocked and the time and tokens spent on it so far.
  ([#303](https://github.com/devswha/herdr-web-ui/pull/303))
- Terminal and chat font families in Settings: a comma-separated list, such as
  `D2Coding, "Cascadia Mono"`, tried in order before the built-in fonts, so a font this device
  lacks falls back as before. The chat font applies to message text; code stays monospace.
  Stored per browser, like the other appearance settings.
  ([#308](https://github.com/devswha/herdr-web-ui/pull/308) by @Kuhave)

### Changed
- Remote PCs use the `remote-v11` runtime, which carries the server-side changes since `remote-v10`
  to them: a new tab and a split from the sidebar, an OmO pane's background tasks and workflows,
  and the access token asked before a Tailscale login is trusted. A PC connected with the
  `remote-v10` bridge updates as it did for earlier runtimes.
  ([#322](https://github.com/devswha/herdr-web-ui/pull/322))
- With an access token set (`HERDR_WEB_TOKEN`), your own Tailscale devices are asked for it too:
  once per device, and that browser then stays signed in for a year. A paired device still gets in
  without it, and nothing changes when no token is set. Before, the token was skipped for a request
  that named this PC's Tailscale login, and any other proxy on the same PC (nginx, Caddy, a tunnel)
  passes a visitor's copy of that name on unless it is told to drop it, so the token did not keep
  such a visitor out. ([#309](https://github.com/devswha/herdr-web-ui/pull/309))
- A mirrored terminal (a Windows PC, or one with no Node for the terminal attach) sends the rows
  that changed instead of the whole screen each time, and shows what you type sooner. An agent at
  work repaints a spinner about 12 times a second: measured with gjc, that was 88 KB a second to
  every viewer and is 11 KB now. Typing waited for the mirror's next look at the screen, up to
  0.4 s on an idle pane: on a real Windows PC a key's echo took 159 ms and takes 23 ms.
  ([#292](https://github.com/devswha/herdr-web-ui/pull/292))

### Fixed
- On a phone, picking a pane (from the drawer, the palette or a notification) or switching between
  chat and terminal no longer raises the keyboard over it: you read first, and a tap on the message
  box or the terminal raises it. Turning direct typing on still does. A desktop is unchanged.
  ([#315](https://github.com/devswha/herdr-web-ui/pull/315) by @Haeminway1)
- On a phone the status line above the message box is always one row. With a background-task
  count, a model name and a reasoning level it wrapped to two rows, three with the context text
  open, and took that room from the conversation. On a narrow screen the background-task chip now
  shows its icon and the number (the icon alone while nothing runs), the reasoning chip the level
  alone, and a model name that still does not fit is shortened. ([#312](https://github.com/devswha/herdr-web-ui/pull/312))
- The terminal accepts dropped file paths and uploads dropped or pasted files to
  the pane's working directory before inserting their quoted paths, without submitting them.
  ([#304](https://github.com/devswha/herdr-web-ui/pull/304) by @beomq)
- A message sent to Claude Code while it is working shows in the chat. Claude records such a
  message differently from one sent while it waits, and the chat skipped it, so the agent acted
  on words the chat never showed.
  ([#301](https://github.com/devswha/herdr-web-ui/pull/301))
- In an OmO, omp or pi chat, a message that invoked a skill (`/skill:name`, `$name`, or a keyword
  such as `ulw`) shows what you asked, not the whole SKILL.md the agent put before it: one such message
  filled tens of KB of the chat. The skill shows as a chip under your message, standalone `.md`
  skills included. ([#302](https://github.com/devswha/herdr-web-ui/pull/302))
- A chat message the page cannot draw no longer blanks the whole app. That message says it can't be
  shown and the rest of the conversation stays; if the chat as a whole fails, it says so with Try
  again, and the header, sidebar and terminal keep working.
  ([#300](https://github.com/devswha/herdr-web-ui/pull/300))
- New session has a shortcut that works in a browser tab: Ctrl+Shift+O (Cmd+Shift+O on a Mac).
  Chrome keeps Ctrl+Shift+N for a new incognito window and never passed it to the page, so it
  worked only in the installed app, where it still does.
  ([#298](https://github.com/devswha/herdr-web-ui/pull/298))
- Cmd+Shift+↑ and ↓ select text in the message box on a Mac again (Ctrl+Shift+↑ and ↓ in any text
  field elsewhere). The pane shortcut took them wherever the cursor was, switched panes and left
  the message behind; it now switches panes from the terminal and outside text fields only.
  ([#298](https://github.com/devswha/herdr-web-ui/pull/298))
- Nerd Font icons (a Starship or Powerlevel10k prompt, `lsd`, `eza --icons`, Neovim file
  trees) show in the terminal instead of empty boxes. The terminal's fonts had none of them, and
  Safari never uses a font the user installed, so even a Nerd Font set up for the native
  terminal did not help there. The app now carries Symbols Nerd Font Mono for those characters
  alone; the browser downloads it (1.2 MB) only once a pane prints one, and each icon is drawn to
  its one cell, Powerline's separators at the full height of the row.
  ([#294](https://github.com/devswha/herdr-web-ui/pull/294) by @jmr533)
- An agent's finish is no longer lost when a pane opens or closes somewhere at the same moment.
  The server reopens its status subscription whenever the set of panes changes, and a status
  that changed in between was never sent again: no done alert came, and a browser kept the old
  state until its next refresh. The status is now read back once the new subscription is live
  and told as the event it would have been. Seen as a flaky test first: with panes opening and
  closing beside it, a pane's one status change was lost in 5 of 10 runs, and in none after.
  ([#291](https://github.com/devswha/herdr-web-ui/pull/291))
- Frames and tables an agent draws in the terminal have whole lines. Box-drawing characters came
  from the font, whose glyph is shorter than a row, so an upright line broke at every row and a
  corner did not meet its lines; a phone drew the heavy lines `━ ┃ ╋` almost like the light ones,
  and shades `░▒▓` as a dot pattern. These characters and the block elements (`█ ▄ ▌` and the
  like, as in a progress bar) are now drawn to the cell, edge to edge, on whole screen pixels.
  ([#295](https://github.com/devswha/herdr-web-ui/pull/295))
- Several lines sent to an agent from the terminal's input line, or pasted into the terminal,
  stay in its message box until sent on a Linux or macOS PC that mirrors its terminals too (one
  with no Node for the terminal attach). They went as bare lines there, and the agent sent the
  first line as a message of its own. Measured with gjc on a mirrored Linux pane: two lines
  arrived as two messages, and now arrive as one.
  ([#290](https://github.com/devswha/herdr-web-ui/pull/290))

## [0.3.41] - 2026-10-02

### Added
- An OmO pane shows how many background tasks it still has running, as a small count beside its
  state in the sidebar. A turn can be DONE while tasks it started still work, and they wake the
  session by themselves; the count tells that pane from one with nothing left to do.
  ([#287](https://github.com/devswha/herdr-web-ui/pull/287))
- Settings → Appearance has a wheel scroll speed for the terminal, from 1× (as it was) to 10×.
  xterm sends herdr at most one wheel report per wheel event however far the wheel turned, so a
  long history took a lot of turning; at 3× the same turn scrolls three times as far. A trackpad
  is scaled the same way; a pinch and touch scrolling are unchanged.
  ([#274](https://github.com/devswha/herdr-web-ui/pull/274) by @taehwan08)
- A file path or a `file:///` address in the terminal opens in the file viewer with a click or
  a tap, as one in the chat does. A path counts when it names a folder (`src/App.tsx`,
  `server/index.ts:120`); a bare name such as `README.md` stays text, since a terminal is full
  of those and a tap to focus the pane would open the viewer. In the chat a `file:///` address
  opens too, written plain, as code or as a link, and one that names a folder shows the folder's
  files. `process.env`, `Math.random` and the like no longer read as files in the chat.
  ([#266](https://github.com/devswha/herdr-web-ui/pull/266) by @beomq)
- A pi or omp pane says so when you type `/tree` into the chat. The command runs, in the terminal,
  and opens a tree the chat cannot show — so the composer says that while you are typing it, and
  where to go instead. Wording checked at 390 wide: the lens switch is an icon there (its word is
  hidden below 560px, and a `title` is a tooltip a phone never shows), so the hint names where the
  button is rather than a word no phone displays
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi pane says when the conversation is bigger than what the chat shows. `/tree` moves pi's leaf
  pointer and writes nothing, so the turns a `/tree` left behind simply disappeared from the chat
  with no sign they had been there. The chat now names how many it holds back and across how many
  branches, and where pi summarized the abandoned path — answering `/tree`'s **Summarize branch?**
  — it shows that summary. Going back to those turns still means `/tree` in the terminal: the chat
  reads them but cannot move pi's pointer, and a chat that could would offer to undo a branch by a tap
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi pane is a chat. Its own session file under `~/.pi/agent/sessions` is read through herdr,
  so prompts, thinking, tool calls with their results, the model and the reasoning level show
  the way they do for omp. `/new`, `/resume`, `/fork` and `/clone` move the chat to the session
  that replaced the old one, and after a `/tree` it shows the branch in play: the paths pi
  navigated away from stay in the file, unread, as they do in pi. Where pi folded old context
  into a summary — on `/compact`, or by itself — the chat says so and opens the summary. A pi
  dialog answers from the chat too: an extension's question, a Yes/No, and one that wants text
  typed, though not `/tree` itself, which would move the session's branch. pi calls itself idle
  while it waits on a dialog, never blocked, so the card comes from its screen. A session
  directory chosen with `--session-dir` or the `sessionDir` setting is not found;
  `PI_CODING_AGENT_SESSION_DIR` is.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A picture a pi tool opened shows in the chat. pi keeps the image a `read` returned in the
  session file beside the text it answers with, so a screenshot the agent looked at was in the
  transcript and invisible here; it now shows inside that tool's row, and opens full size on a
  tap. Only the address travels in the conversation, so the bytes arrive when the row is opened
  and not on every poll, and an image left behind by a `/tree` stays out of reach, the way its
  output does.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi pane's context ring shows. What a request filled was already recorded; the window it
  filled was not, so the ring had nothing to divide by and stayed hidden. It now reads the
  window from the same `~/.pi/agent/models.json` pi reads its own providers from, and the
  figure matches what pi's own footer says. A model that file does not state keeps no ring:
  pi answers those from its built-in catalogue or from a running llama.cpp server, neither of
  which a reader of the transcript can ask, and a window invented would show a percentage no
  different from the real one.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi pane's message box lists pi's own slash commands as you type `/`, the way it does for
  Claude Code, Codex and omp: pi's built-ins in pi's words, the templates in `~/.pi/agent/prompts`
  and the skills under `~/.pi/agent/skills` and `~/.agents/skills`. A project's own skills and
  prompt templates stay out of the list, because pi loads those only once you have trusted the
  folder, and a command the agent will not run is worse than one missing from the menu.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- The browser demo runs a pi pane, backfilled into the recorded snapshot when the fixtures
  predate it: `site/demo/fixtures.ts` is the only file a new demo agent needs.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)

### Changed
- Remote PCs use the `remote-v10` runtime, which carries the server-side fixes since `remote-v9`
  to them, Windows PCs included: New session with Gajae Code, the chat of a Gajae Code or omp
  pane, pasted and sent lines that stay in an agent's message box, typing that no longer outlives
  its connection, and OmO detection. A PC connected with the `remote-v9` bridge updates as it did
  for earlier runtimes. ([#282](https://github.com/devswha/herdr-web-ui/pull/282))

### Removed
- `/tree` is no longer suggested in a pi pane's chat. pi offers it, and typing it works, but the
  chat reads the tree browser it opens as nothing at all — no card, and the pane still looks idle
  while the terminal waits for arrow keys — so a reader who picked it from the menu landed in a
  state only the terminal lens can leave. Navigating was never the chat's to do; omp curates its own
  list the same way. What the chat does say is where a `/tree` left the conversation: the marker
  above the turns names how many it holds back and across how many branches
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)

### Fixed
- A Codex pane whose answers are all short shows its chat. The chat finds a Codex conversation by
  an answer it can see on the pane's screen, and only one of 64 letters or more counted, so a
  session of one-line answers stayed empty until a longer answer came. When nothing else tells
  (herdr names no session, Codex was not resumed, and no long answer found the conversation
  before), the newest two or more answers of a conversation, shown one after another on the
  screen, now count together. That is weaker evidence than one long answer, so it is used only
  when exactly one of the folder's conversations shows that way, no other one said those answers
  as far as its text tells, every one of them was read whole (none missing its file, forked from or continuing
  another, or too long to read at once), and the folder has no more than 32. An answer with a
  link in it does not count, since the screen shows a link its own way. It is never
  remembered: once the answers scroll away the chat is empty again until a long one shows. Text
  pasted into the pane or printed by a command can still look like another conversation's
  answers and show that conversation instead.
  ([#284](https://github.com/devswha/herdr-web-ui/pull/284))
- The chat of a Gajae Code pane on a Windows PC follows `/new` and `/resume`. It stayed on the
  previous conversation until an answer of the new one was long enough to recognise, which a
  one-word answer never is. It now goes by the session title gjc shows in its status line: when
  that names one session of the folder, the chat shows that one, and when two sessions share
  the title it shows none rather than the wrong one. A later gjc that Windows gave the same
  process number no longer inherits the old session, and a process list that could not be read
  keeps the chat as it was instead of dropping it.
  ([#285](https://github.com/devswha/herdr-web-ui/pull/285))
- An OmO pane reads RUN while OmO works and DONE when it finishes. herdr reports nothing for such
  a pane (it read READY or DONE whatever OmO did), so a message sent meanwhile was not held, Stop
  was not offered, and no done alert came, in the browser or by web push. The status is now read
  from OmO's own session file, also for a turn a finished background task, a monitor or a goal
  starts by itself. Nothing of OmO's or Claude's is installed or changed for it. A remote PC gets
  this with the next remote bundle.
  ([#287](https://github.com/devswha/herdr-web-ui/pull/287))
- On a PC whose Tailscale node is tagged, your own devices are no longer refused as "another
  Tailscale user". A tagged node has no person's login, and the server took the node's own name
  for one, which no device could match. Such a PC now asks every device to pair, yours included,
  and `HERDR_WEB_TAILSCALE_OWNER` names the login that gets in without pairing.
  ([#280](https://github.com/devswha/herdr-web-ui/pull/280))
- Several lines sent to an agent from the terminal's input line on a phone stay in its message
  box until sent, on a Windows PC too. The mirrored terminal there never learns the agent's paste
  mode, so the lines went as typed and the agent sent the first one alone. They now go as one
  paste, as the same lines pasted into that terminal do since 0.3.40.
  ([#281](https://github.com/devswha/herdr-web-ui/pull/281))
- The chat of an OmO, omp or Gajae Code session shows the reasoning level the session runs at
  now. It read the level from the first 64 KB of the transcript and the newest page, so a level
  changed in between (`/thinking`, or a model switch) was never seen: a session started at
  `high` and switched to `medium` still showed `high`. A model or thinking-level change between
  them now counts, in order, without reading more of the file.
  ([#279](https://github.com/devswha/herdr-web-ui/pull/279) by @ddotz)
- The chat shows the conversation of OmO installed with `bun add -g omo-ai` again, and the
  sidebar marks its pane as OmO. A global bun install puts OmO's engine next to omo-ai rather
  than inside it, so the pane runs `bun …/@code-yeongyu/senpi/dist/bundle/cli.js --extension
  …/omo-ai/plugin`, and 0.3.40 no longer took it for OmO: the chat found no conversation and
  New session did not see OmO start. That engine counts as OmO again when omo-ai's plugin is one
  of its extensions.
  ([#278](https://github.com/devswha/herdr-web-ui/pull/278) by @ddotz)
- Claude usage on a Mac no longer shows `expired` while Claude Code is signed in. Claude Code
  started outside the desktop session (over SSH, or by a background service) cannot write its
  keychain item, so it refreshes only `~/.claude/.credentials.json` and the item keeps a token
  that expired hours ago. The app took the keychain item whenever it could read it; it now
  takes whichever of the two expires later, the way it already does for Cursor. Both are still
  only read.
  ([#277](https://github.com/devswha/herdr-web-ui/pull/277) by @ddotz)
- Claude's subscription usage no longer shows a locked keychain on a Mac whose server was
  started outside the desktop session (over SSH, or by a detached multiplexer), where
  `security` cannot open the login keychain. The item is read through a one-shot launchd job
  in the desktop session instead.
  ([#255](https://github.com/devswha/herdr-web-ui/pull/255) by @ddotz)
- A pi pane no longer shows a context window pi never used, and now shows the one it does. A
  provider that states `contextWindow` beside a model that names none reported that number as the
  model's denominator; pi does not inherit it, and runs the model at its own default instead, so the
  ring is now quiet there rather than showing a figure pi never had. And `modelOverrides` is applied
  the way pi applies it — an override that raises a model to 256k was read at 128k, which drew twice
  the utilisation pi shows. Both checked against pi 0.87.1 by pointing `PI_CODING_AGENT_DIR` at a
  crafted `models.json` and reading `pi --list-models`.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A malformed entry in `~/.pi/agent/models.json` no longer takes the chat down with it. One model
  that was not an object — a stray `null` from a hand edit — threw while the window was being read.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A prompt template reached through a symbolic link is offered again. A `.md` linked from a dotfiles
  repo into the prompt directory was hidden from the menu while pi loaded it and ran it.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A command name longer than the menu no longer runs out from under it, on a phone or a desktop. A
  template is named after its file, and the name kept its full width past the row's edge.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A model list caught mid-redraw is refused instead of offered in part. A screen written while pi is
  still drawing it ends a row inside its provider bracket; the rows above it were kept and offered
  as a catalogue, so counting down walked into models pi had not drawn.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A path abandoned at the very root of a pi session is counted. Navigating pi's tree to its first
  entry clears where the next entry attaches, and starting a second path beside the first was read
  as no navigation at all, hiding what was left behind.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi dialog shows on a phone. A phone leaves pi a pane barely wide enough for its own hint, so
  the hint wraps, and pi keeps its footer underneath: the wrapped hint then sat further from the
  bottom than the window that tells a live dialog from an answered one reached, so no card came up
  at all. `/model` failed twice over — the wrapped hint, and a model's own name wrapping so that
  the provider's bracket, which is what tells a row from pi's notes, fell onto a line of its own
  among them. The wrap is joined back before the screen is read, and a row still missing its
  provider voids the whole reading, because a name cut in half would switch pi to a model that
  does not exist
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)

## [0.3.40] - 2026-10-01

### Fixed
- Korean, Japanese and Chinese in the terminal no longer look spread apart on an iPhone. iOS has
  no font that draws Hangul as wide as two terminal cells, so every syllable sat at the left of
  its cells with a 4px gap after it. A character narrower than its cells is now drawn larger
  (up to 1.2×) and centered in them. Vietnamese written with separate accent marks, as in a
  file name from a Mac, now shows every mark on iPhone; Safari drew only the first one. The ⏺
  before every Claude Code message is drawn as a symbol in its cell on iPhone, no longer as a
  blue emoji over the next character
  ([#272](https://github.com/devswha/herdr-web-ui/pull/272)).
- Several lines pasted into the terminal of a Windows PC stay in an agent's message box until
  you send them. Gajae Code took the first line break for Enter and sent the first line alone.
  PowerShell and cmd still run a pasted block line by line. Enter, Ctrl+C, Esc, Tab and the
  arrows were checked on a real PC and already worked
  ([#267](https://github.com/devswha/herdr-web-ui/pull/267)).
- A bridge that cannot run the PTY sidecar (no Node, or no `@lydell/node-pty`, as in the Windows
  bundle) keeps mirroring its panes even when herdr reports terminal attach. It used to leave
  the working mirror for an attach it could not start, and the terminal ended at once.
  `/api/health` and the PC list say `terminal_attach: false` and `terminal_mirror: true` there.
  The real terminal on Windows therefore needs a bundle that ships the sidecar, not only a
  herdr that attaches ([#265](https://github.com/devswha/herdr-web-ui/pull/265)).
- A password entered from the secret prompt on a mirrored terminal (a PC whose herdr cannot
  attach, as on Windows) is reported as entered only after herdr took it, and a send herdr
  refused is reported as failed instead of as done. Enter is now pressed as a key after the
  text, not sent as a carriage return inside it
  ([#263](https://github.com/devswha/herdr-web-ui/pull/263)).
- A pane running a command that is only given an omo path (`grep -q …/omo-ai/x`, `cat …/bin/omo`) is
  no longer shown as OmO or counted as a second OmO in its folder. Only the program a pane runs
  counts, or the script that node or bun runs
  ([#249](https://github.com/devswha/herdr-web-ui/pull/249)).
- **New session** with Gajae Code starts on a Windows PC. The command was typed the way a POSIX
  shell wants it and ended with a newline, which PowerShell takes for a line break, so it never
  ran; and herdr names only the pane's shell on Windows, so the start was never seen. The
  command is now written for the pane's shell (PowerShell or cmd), run with the Enter key, and
  found among the shell's child processes. OmO is not offered on a Windows PC for now
  ([#251](https://github.com/devswha/herdr-web-ui/pull/251)).
- A reverse proxy on the same PC that keeps the browser's `Host` but sends no
  `X-Forwarded-For` no longer makes every visitor count as this computer. A request from this
  PC with a `Host` that is not `localhost` or `127.0.0.1`, or with any forwarding header, is
  treated as proxied: once a device is paired, a visitor needs pairing or the token. A proxy
  that also rewrites `Host` and adds nothing, as nginx's plain `proxy_pass` does, still cannot
  be told from this computer, so set a token behind a proxy. The guide has Caddy and nginx
  examples to copy ([#252](https://github.com/devswha/herdr-web-ui/pull/252)).
- The chat lens finds the conversation of a Gajae Code pane and of an omp pane on a Windows PC.
  Both lookups compared paths with `/`, which a Windows path does not have, and Gajae Code was
  looked for only among the processes herdr names, which on Windows is the pane's shell alone.
  Paths are now compared by the PC's own rules, and Gajae Code is found among the shell's child
  processes, then matched by the text on screen. Once matched, the pane keeps its conversation
  while that Gajae Code process runs, so a long list or tool output that pushes every answer off
  the screen no longer drops the chat, and the PC's process list is read once every few seconds
  instead of on every poll. A path that leaves the store through `..` is
  refused on every platform. A Windows PC gets this with the next remote bundle
  ([#264](https://github.com/devswha/herdr-web-ui/pull/264)).
- Emoji in the terminal take as many cells as herdr gives them, so a line with emoji no longer
  shifts: the browser counted most emoji, and the ⚠️ kind with a selector, as one cell, and an
  emoji sequence such as 👨‍👩‍👧 as one cell per emoji. The next letter overlapped the emoji, parts
  of the sequence were overwritten, and stray characters stayed behind. Thai and Indic vowel
  signs and invisible characters such as a zero-width space are counted as herdr counts them too
  ([#273](https://github.com/devswha/herdr-web-ui/pull/273)).

## [0.3.39] - 2026-10-01

### Fixed
- A password or PIN sent right after a reconnect is no longer refused with "Update this PC to
  use masked input". The terminal's output could arrive before the server had said what it
  supports, and a Send in that gap sent nothing
  ([#244](https://github.com/devswha/herdr-web-ui/pull/244)).
- A Stop, an Enter or anything typed right after a message no longer reaches the pane once the
  connection that sent it has closed. It waited behind the message and was sent afterwards, with
  nobody watching. The message itself is still finished for a phone that locks
  ([#235](https://github.com/devswha/herdr-web-ui/pull/235)).
- A terminal whose grid is not the browser's own (a mirrored pane on a PC whose herdr cannot
  attach, or a view-only connection) can be reached past the edge of a small screen: a drag pans
  it on a phone, the wheel or a scrollbar in a small desktop window, and it opens on the rows
  with the prompt instead of the top of the grid
  ([#241](https://github.com/devswha/herdr-web-ui/pull/241)).
- An omo question in the chat gets a real card, not the last-resort one with only Enter and
  Esc. omo asks several questions in one form: the card asks them one at a time, with a chip per
  question that checks off the answered ones, and an option is picked by its number as in omo.
  After the last one the card reviews the answers: Submit, tap an answer to change it, or type a
  comment that goes with them. The card's text comes from the question as omo's session recorded
  it, so a pane too short for the whole form, or one that wraps it, still shows every option word
  for word; without the session it is read off the screen, with wrapped Korean words joined back.
  While an answer is typed in omo's own field, the card offers to save or discard it
  ([#237](https://github.com/devswha/herdr-web-ui/pull/237) by @nahwan-kim).
- A pane that waits for another web bridge to let go of its terminal is no longer shown as
  connected for a moment, and then told again that it is held, when herdr answers a retry slowly.
  The first bytes `herdr terminal attach` writes before herdr has answered no longer count as
  the attach having taken ([#243](https://github.com/devswha/herdr-web-ui/pull/243)).
- A new shell is no longer taken for OmO while its startup files run. A startup command that
  printed a `PATH` containing omo-ai's directory matched the OmO process check, so the pane could
  get the OmO mark for a moment and **New session** could report OmO started before it had
  ([#243](https://github.com/devswha/herdr-web-ui/pull/243)).

## [0.3.38] - 2026-10-01

### Added
- A workspace with several panes gets a chevron in its sidebar header that folds its pane rows
  away. The fold is remembered per PC and workspace, the header keeps its status badge, Needs you
  still lists agents inside it, and opening one of its panes (palette, Needs you, an alert link)
  unfolds it ([#222](https://github.com/devswha/herdr-web-ui/pull/222)).
- **Add PC** connects a Windows PC (x64, OpenSSH Server, herdr 0.9+). Setup asks it in
  PowerShell when `sh` is not there, installs a Bun-only `win32-x64` bundle under
  `%LOCALAPPDATA%\herdr-web-ui`, runs herdr's own installer when the PC has no herdr, registers
  the app key where Windows OpenSSH reads it (an administrator's
  `administrators_authorized_keys`), and starts the bridge and the daemon through WMI so they
  outlive the SSH session and each other. The bridge talks to herdr over its named pipe. herdr
  has no terminal attach on Windows yet ([herdrdev/herdr#4821](https://github.com/herdrdev/herdr/issues/4821)),
  so `/api/health` and the PC list carry `terminal_attach`, and the real terminal turns on by itself
  once herdr reports it. Remote bundle `remote-v9`
  ([#227](https://github.com/devswha/herdr-web-ui/pull/227)).
- A PC whose herdr cannot attach a terminal (a Windows PC for now) has a terminal lens all the
  same. The bridge reads the pane's screen a few times a second and repaints it, so output and
  colours show and typing works. It is a stopgap until herdr can attach there: the cursor is not
  shown, and the grid is the pane's own size on that PC, not the browser's, so a phone shows its
  left part and cannot pan it yet
  ([#230](https://github.com/devswha/herdr-web-ui/issues/230),
  [#228](https://github.com/devswha/herdr-web-ui/pull/228)).

### Fixed
- A gjc chat no longer folds hours of work into one turn. gjc wakes its agent with a
  background job's result in the user's seat; the chat skipped that record, so the answer before
  it sank into the work block and only the last status line showed as the reply. The result now
  ends the turn, as a quiet "Background result delivered" divider with the text on request, like
  a compaction ([#225](https://github.com/devswha/herdr-web-ui/pull/225)).
- **New session** offers **Gajae Code** when `gjc` is on the server's PATH. herdr's `agent.start`
  has no gjc kind, so like omo it is typed into the new pane's shell and the pane counts as
  started once gjc is its foreground process
  ([#220](https://github.com/devswha/herdr-web-ui/pull/220)).
- OmO panes show their agent mark in the sidebar even when herdr reports no agent kind,
  including panes started with OmO in the new-session dialog. Detection uses the pane's
  foreground processes, not its title, so ordinary shells remain shells
  ([#224](https://github.com/devswha/herdr-web-ui/pull/224) by @beomq).
- A bridge that died without withdrawing its registration (a crash or a reboot) no longer
  makes the reconnect verify the dead one before the new bridge has registered
  ([#227](https://github.com/devswha/herdr-web-ui/pull/227)).

## [0.3.37] - 2026-10-01

### Changed
- Settings → Appearance no longer offers Clawd and the Codex app icon in place of the
  provider logos. Claude and Codex panes show their provider logos again, also where one of
  the icons was chosen in 0.3.36. The color palettes stay
  ([#219](https://github.com/devswha/herdr-web-ui/pull/219)).
- The chat's status line no longer has **Report a problem**, and on a phone no **Hide keyboard**
  while typing. A tap on the transcript or a drag down it still puts the keyboard away. Problems
  go to [GitHub issues](https://github.com/devswha/herdr-web-ui/issues/new/choose)
  ([#221](https://github.com/devswha/herdr-web-ui/pull/221)).
- On a touch screen, the chip above the message box that takes Claude Code's suggested next
  prompt is now off until Settings → Composer → **Suggestion chip** turns it on. The suggestion
  still stands as the box's placeholder, and Tab still takes it with a keyboard
  ([#223](https://github.com/devswha/herdr-web-ui/pull/223)).
## [0.3.36] - 2026-10-01

### Added
- On a phone, a swipe in from the left edge opens the workspace list and a swipe to the left
  closes it; a stroke on a text field or one that selects text is left alone. While typing in
  the chat, a tap on the transcript, a drag down it, or the new **Hide keyboard** button puts
  the keyboard away to read, and the draft stays in the composer
  ([#187](https://github.com/devswha/herdr-web-ui/pull/187) by @Haeminway1, [#217](https://github.com/devswha/herdr-web-ui/pull/217)).
- Settings → Appearance → Colors offers two opt-in palettes beside herdr's amber, which stays
  the default: **Dark report** (a near-black blue-grey canvas, hairlines, near-square corners,
  white primary actions, electric blue only on small marks, and amber / red / green agent states)
  and a neutral Ghostty-style **Charcoal**
  ([#188](https://github.com/devswha/herdr-web-ui/pull/188) by @Haeminway1).
- Settings → Appearance can show Clawd, Claude Code's mascot, on Claude panes and the Codex
  logo (a blue cloud with a prompt) on Codex panes instead of the provider logos, which stay the
  default ([#188](https://github.com/devswha/herdr-web-ui/pull/188) by @Haeminway1).
- The chat's message box offers the prompt Claude Code suggests next, the grey text in its
  empty input. It stands as the box's placeholder, and Tab takes it into the box; on a touch
  screen a dashed chip above the box does the same. Nothing is sent until you send it. It is
  read only while Claude waits for a prompt and never holds up the chat for more than 1.5s
  ([#198](https://github.com/devswha/herdr-web-ui/pull/198) by @Yoonwoo-Ha, [#216](https://github.com/devswha/herdr-web-ui/pull/216)).
- Settings → Plan limits → Where puts the plan meters at the top of the sidebar instead of
  beside Settings: a row per account with its plan, the limit closest to running out, a bar
  and when it resets. A tap opens every limit. An account whose numbers are old or missing (a
  sign-in expired, a provider asking to slow down) dims them and says why in its row
  ([#206](https://github.com/devswha/herdr-web-ui/pull/206) by @Haeminway1, [#217](https://github.com/devswha/herdr-web-ui/pull/217)).

### Fixed
- A table an agent indents under a list item shows as a table in that item in the chat. It was
  read as the item's text, so its rows ran together on one line with their pipes. The list goes
  on after it: items numbered `1.` throughout keep counting, and nested items stay nested
  ([#209](https://github.com/devswha/herdr-web-ui/pull/209) by @Yoonwoo-Ha, [#217](https://github.com/devswha/herdr-web-ui/pull/217)).
- `stop` (herdr's Stop action, `bun scripts/plugin.ts stop`) returns once the server is gone.
  It returned at once, while the old supervisor still held the checkout's lock, so a `start`
  right after it found that lock and gave up: nothing ran, and it reported no answer after 20s.
  On Linux, a server that has exited but whose parent has not yet collected it counts as gone
  ([#210](https://github.com/devswha/herdr-web-ui/pull/210) by @Yoonwoo-Ha, [#216](https://github.com/devswha/herdr-web-ui/pull/216)).
- A pane herdr reports waiting for input gets a card in the chat even when no reader knows its
  screen (Codex's collapsed question queue keeps its own handling). A numbered menu whose hint
  (a way to choose, such as "Enter to select") is the screen's last line is offered as its
  options, each answered by typing its number, with wrapped labels in full and Enter and Esc
  after them; anything else, such as a new prompt under
  the hint, shows the screen's last lines with Enter and Esc, plus Yes and No for a `(y/n)` prompt
  and arrows when its hint names them. An answer to a changed screen is refused. Each such
  wait is logged once ([#205](https://github.com/devswha/herdr-web-ui/pull/205) by @Haeminway1, [#216](https://github.com/devswha/herdr-web-ui/pull/216)).
- **Add PC** on a Windows host now says that Windows hosts are not supported yet, instead of
  failing with the host shell's "'sh' is not recognized" ([#208](https://github.com/devswha/herdr-web-ui/pull/208), [#189](https://github.com/devswha/herdr-web-ui/issues/189)).
- A pane waiting for another web bridge no longer frees its input for a moment and reports the
  wait twice when herdr's refusal of a retry arrives slowly (a busy PC). It keeps waiting and
  tries again instead, however late that refusal's exit is
  ([#207](https://github.com/devswha/herdr-web-ui/pull/207) by @Haeminway1, [#216](https://github.com/devswha/herdr-web-ui/pull/216)).
- In the terminal, **Ctrl+Shift+↑/↓** only switches panes. It no longer also types `ESC[1;6A` /
  `ESC[1;6B` into the pane it switched to ([#215](https://github.com/devswha/herdr-web-ui/pull/215)).
- On a wide screen, the quick replies above the message box line up with the box instead of
  starting at the chat pane's left edge ([#212](https://github.com/devswha/herdr-web-ui/pull/212)).
- Queued messages show under the chat lens only. In the terminal lens they stay saved but
  hidden, so their **Send now** can no longer type into a Codex question that only the chat
  lens knows is open ([#213](https://github.com/devswha/herdr-web-ui/pull/213)).

## [0.3.35] - 2026-09-30

### Added
- A Korean README (`README.ko.md`), linked from the English, Simplified Chinese and
  Japanese READMEs.

### Changed
- Remote PCs without their own herdr get herdr 0.9.3 in the bundled runtime (was 0.9.1),
  along with this release's event-stream recovery for the remote bridge. The runtime is
  version 8: a connected PC's bridge asks for **Update bridge…** once, and herdr sessions
  keep running while it updates.

### Fixed
- Claude Code's unnumbered menus, such as the folder-trust check on a folder it has not seen
  ("Enter to confirm · Esc to cancel"), show as a card in the chat and can be answered there.
  herdr reported the pane INPUT, but no card appeared. An answer presses Enter only once the
  cursor is on the row it answers; a menu whose rows cannot be told apart gets no card.
- The iPhone home-screen app starts below the status bar instead of drawing beneath it, so the
  header text is no longer blurred on iOS 27 ([#199](https://github.com/devswha/herdr-web-ui/pull/199) by @Yoonwoo-Ha). iOS reads this when the app is added, so an
  existing install keeps the blur until it is removed from the Home Screen and added again; send
  or copy unsent drafts and queued messages first. See [the testing guide](docs/ios-home-screen-testing.md).
- A Codex pane no longer reads RUN for good after its first turn. herdr reports Codex as
  `unknown` at rest, and that was taken for more work; the agent that worked reading `unknown`
  is now a finish (DONE until seen, with its done alert). Late session snapshots no longer
  end a newer turn, and DONE follows the agent that finished.
- Subscription usage no longer lists Copilot for everyone signed in to the GitHub CLI. GitHub
  gives every account Copilot Free, so a Free plan found only through `gh` is left out; a
  Copilot sign-in in an editor, or a paid plan, still shows.
- A local or remote PC refresh no longer replaces a newer pane status with an older
  snapshot. Status and session changes received during a refresh queue a fresh load.
- The installed iPhone app no longer leaves a band under the composer. The shell keeps its
  full height until a text field takes the keyboard, and the keyboard sizing also follows
  direct terminal typing and pointer changes, and clears when a focused field goes away.
- Tapping an alert opens its PC and pane, also when the tap starts the app or focusing the
  window is refused; the newest tap wins over an older one still opening.
- A pane whose terminal another web bridge on the same herdr has open (two installs side by
  side) now waits for it instead of ending with "Another web bridge is attached": it says so,
  keeps the chat readable, and attaches by itself as soon as the other bridge lets go.

## [0.3.34] - 2026-09-30

### Added
- A pane herdr could not restore after a restart (herdr 0.9.3+, e.g. its folder was
  removed) is marked NOT RESTORED in the sidebar, and selecting it shows herdr's reason
  instead of a terminal that ends at once. The server no longer tries to attach it.
- The new-session dialog offers OmO when `omo` is installed on the PC. herdr cannot start
  omo itself, so the new pane's shell runs `omo` and the dialog waits until it is up.
- Subscription usage beside Settings: the plan limits of Claude, Codex, Cursor, Copilot,
  Grok and Antigravity, read with the sign-in each tool keeps on the server's PC, which is
  never refreshed. Each account shows its limit closest to running out, red from 80%; a
  tap lists every limit with its reset time. Two accounts of one provider (a second
  `~/.codex-*` or `~/.claude-*`, several GitHub CLI or Grok sign-ins) are listed apart,
  named by their email or login. Settings orders the accounts, hides any, and counts what
  is used or what is left. Off until turned on in Settings, since it sends the PC's
  sign-ins to each provider. `GET /api/usage`.
  Sign-in locations and endpoints follow OpenUsage.

### Changed
- Tested against herdr 0.9.3: CI runs the integration and browser suites on it, and the API
  types are generated from its schema. herdr 0.9.0 or newer is still enough.
- The website is redesigned after herdr.dev: ink and paper modes, one large headline with the
  install line, a strip of figures, and five numbered rows for what the app does. It is built
  from the README's own media: its top video, with a tab that swaps it for the demo app, its
  four feature clips, and the installer screenshot.
- The one-line installer installs the latest release instead of `main`, so a new install
  runs the same version as existing ones and never picks up changes merged since.
  `HERDR_WEB_UI_REF` still picks another branch or tag.

### Fixed
- Enforce device permissions and request origins consistently, persist device changes
  before reporting success, and stop alerts after device access is revoked. A device that
  can only watch can no longer read files on a connected PC through a path with an empty
  segment, and an alert subscription made before any pairing stops once pairing closes the
  open network.
- Show remote conversation images and full tool output, including Codex output inherited
  from earlier rollouts.
- Dragging terminal text copies the visible selection immediately, including when an
  installed app's asynchronous clipboard permission is blocked. Scrollback copies
  reserve clipboard access during the release gesture; delayed or empty selection
  responses cannot erase a newer copy.
- Settle sent composer drafts across pane switches and cancel all delayed completion
  alerts when work resumes.
- Closing the selected pane with the sidebar's X no longer puts the keyboard on the pane
  selected in its place. On a phone it came up over the drawer, in the way of closing the
  next pane. A pane or lens the user picks still takes the keyboard.
- Pane statuses and web push recover when herdr drops the app's event stream: herdr 0.9.2
  and newer close a listener that falls behind, and herdr restarts do the same. Every
  stream now reconnects at once, keeps trying while herdr restarts, and reads back what
  it missed from herdr, so a pane created meanwhile is no longer left without status or
  alerts for up to a minute, and an alert for a pane that has since gone quiet is called
  off instead of sent.

## [0.3.33] - 2026-09-29

### Fixed
- The chat finds an omo pane's conversation again with current omo, which no longer keeps
  its session file open. It now reads the session omo records as held by the pane's
  process, so the chat works with several omo panes in one folder, on macOS, and after
  `--continue`, `--resume` or `/new`.
- The installed Android app picks up the auto-rotate fix from 0.3.32 a day sooner. The
  first launch after upgrading from 0.3.31 or older still got the old, rotating web
  manifest from the previous service worker's cache, and Chrome checks the installed app
  against it at most once a day.

## [0.3.32] - 2026-09-29

### Added
- The desktop terminal selects with a plain drag and copies on release, like the herdr
  TUI; Ctrl+C copies a selection instead of interrupting the pane.
- A selecting drag can outlive one screen: the wheel, or dragging past the top or bottom
  edge, scrolls herdr's scrollback, and the copy is herdr's own text for the whole range
  with soft-wrapped lines joined. Plain HTTP, view-only tabs and PCs on an older bridge
  copy the visible selection. Remote PCs use bundle v7.

### Removed
- The todo pill at the top right of the chat is gone, with its lane beside the
  transcript. The chat shows the agent's transcript and nothing pinned over or beside
  it: a todo call stays in its turn's work block, where it reads as the done count or the
  step it took and opens to the whole list.

### Fixed
- A terminal attach whose helper process could not start (for example, `node` missing from
  PATH) no longer leaves the pane half-open. The pane stayed blank for the next device, and
  closing that device crashed the server. The attach now reports the error, the failure is
  written to the server log, and the pane can be opened again ([#155](https://github.com/devswha/herdr-web-ui/pull/155)).
- The installed app on Android follows the phone's auto-rotate setting. With rotation
  locked it no longer turns sideways when the phone is tilted. The service worker no
  longer serves a cached web manifest, so Chrome sees this change and updates the
  installed app; reinstalling applies it at once.

## [0.3.31] - 2026-09-29

### Added
- Recognized password, SSH passphrase and PIN prompts offer a masked input in both
  lenses. Secrets go straight to the attached terminal after a fresh prompt check;
  they are never saved in drafts or the held queue. Remote PCs use bundle v6.
- The herdr plugin's **Phone setup** action opens a pane with the phone address, QR and
  a pairing code. It follows the active app release and shows any needed Tailscale command.
- A **Needs you** group at the top of the sidebar gathers agents waiting for input across
  connected PCs, including collapsed PCs, without changing workspace order.
- Japanese (日本語) and Simplified Chinese (简体中文) join English and Korean in Settings →
  Language. System follows the browser's first translated language, so a Japanese or Chinese
  browser now opens in its own language; dates and times follow it too.
- Settings → Phone offers **Keep screen on**, off by default. Supported browsers keep
  the screen awake while viewing a terminal or chat pane and release it in the background.
- Settings → Alerts can send another test notification to this device, with a result
  and a way to turn alerts on again when its subscription is missing.
- The one-line installer ends a first install with one line asking for a GitHub star, so
  other herdr users can find the app. Reruns, such as the one for the phone address, skip it.

### Changed
- The new-session dialog's agent list shows each agent's mark beside its name, and the plain
  shell entry reads "Shell" in every language (it was "셸만" in Korean). Every agent herdr can
  start now has a mark (Amp, Antigravity, Cline, Devin, Droid, Gemini CLI, GitHub Copilot,
  Grok, Hermes, Kilo, Kimi, Kiro, maki, Muse, pi, Qoder, Qwen) instead of a letter, in the
  sidebar and palette too.
- The agent's todo list no longer sits in the chat. It floats at the top right of the chat
  pane, as a one-line pill (done count and the item in progress) that opens to a card with
  the whole list, like the WORK card in gajae-code-app. A pane wide enough keeps a lane
  for it beside the conversation; a narrower one shows it over the conversation until it
  is closed (Escape closes it too).

### Fixed
- The chat finds a Claude Code pane's conversation when its folder name has a dot, an
  underscore, a space or non-ASCII characters (a Korean folder, `example.com`, `my_project`).
  The project folder is now named the way Claude Code names it, and a session Claude
  started in another folder is found by its id.
- A GJC pane's chat stays on the pane's own session after GJC runs subagents. GJC points its
  terminal breadcrumb at a subagent's transcript while the subagent runs and leaves it
  there, so the chat switched to that subagent's conversation, and its last turn read
  "Working…" for as long as the real session worked. A subagent's file now stands for the
  session it belongs to.
- Image thumbnails in a chat message keep a fixed box, so a lazy image no longer grows the
  message by about 120 px when it loads and pushes the view off the bottom. Non-square
  attachment tiles in the composer are cropped to fill instead of stretched.
- A tap on a touch screen no longer leaves the hover background on the paperclip, the
  search button and other buttons and menu rows; hover styles now apply only where a pointer
  can hover.
- The folder browser shows a loading row until its first listing arrives, instead of an
  empty list. File sizes read in bytes below 1 KB ("179 B", not "1 KB"), and an empty file
  reads "0 B", not "0 MB".
- On a phone, a short text file in the file viewer starts at the top instead of floating in
  the middle of the screen; images, video, audio and PDFs stay centered.
- Escape in a file opened from the Files dialog closes only the viewer, so the folder you
  browsed to stays open; Escape still closes the Files dialog when no file is open.
- The Add PC dialog focuses the SSH field when it opens, not the Close button.
- The Add PC dialog no longer shows a step that has already passed. Approving the changes or
  answering an SSH question moves the step on in the same response, so the question's
  heading does not linger until the next poll. Starting a bridge on a PC that had none is
  labelled by its own step instead of "Restarting the bridge", and a step without byte
  progress, such as registering the app SSH key after the bundle install, shows its own
  text instead of the previous stage's label.
- The chat no longer relabels the previous, finished turn "Working…" for a moment after you
  send a message: the turn that was last when the message went out stays finished until the
  transcript holds the reply to it. When the pane starts or stops working, the chat also reads
  the conversation at once instead of at the next 2 s poll, so DONE and the answer arrive
  together rather than the answer trailing by up to 2 s.
- The Add PC dialog shows what SSH prints while it connects, under the current step, with
  https addresses as links. A message that needs the user but does not end SSH, such as
  Tailscale SSH's browser check URL, no longer looks like a hang. The text is the same as the
  failure message and disappears once the connection is up.
- When a GJC pane is matched to its transcript by the text on screen, the oldest whole
  record in each candidate's 64 KiB tail is read too. A complete record was dropped along
  with the cut first line, or in place of it when the window started exactly on a record.

## [0.3.30] - 2026-09-29

### Added
- A Japanese README (`README.ja.md`), linked from the English and Simplified Chinese
  READMEs' language selectors.

### Fixed
- Prompt cards list each option on its own full-width row, number, label and description
  aligned, instead of wrapping buttons of uneven width. The first option is no longer filled
  as if already chosen, which left its description unreadable in both themes. Checked and
  typed picks share one highlight, a `(Recommended)` option shows a tag, multi-select Submit
  counts the picks, and the custom-answer field is labelled.
- Enter while an IME is composing in the prompt card's custom answer no longer sends the
  half-composed text.
- In Safari and other WebKit browsers, the Enter that commits an IME candidate (Korean,
  Japanese, Chinese) no longer sends the chat message, the prompt card's custom answer or
  the touch terminal's input line. WebKit delivers it after composition ends, as key code 229.
- An image attached after typed text gets its own `@path` token: a space goes in front
  of the mention when the text before the caret does not end in whitespace, so the
  chat shows its thumbnail and the agent reads the path.

## [0.3.29] - 2026-09-28

### Fixed
- Escape closes the command palette even if terminal attachment moves keyboard focus
  outside it, and does not forward that Escape into the terminal.
- Restore GJC chat when its writer closes the transcript between writes. Resolve the
  native terminal-to-session breadcrumb, validate it against the running process and
  session store, or match a unique substantial assistant answer visible in that pane.
  Ambiguous matches never fall back to the newest file in the working directory.
  When native history is unavailable, agent panes show a labeled terminal-output
  disclosure instead of presenting raw terminal UI as assistant messages.
- A latest assistant turn waiting on approval remains in progress instead of reading
  “Worked for …”. The transcript's last-activity timestamp is not a completion signal.
- Suppress native browser tap highlights on buttons and links so mobile approval options
  show only the app's selection and pressed states.

### Documentation
- Clarify that pinned plans require supported todo-tool records. Claude Code sessions
  without TodoWrite do not currently show a pinned plan; TaskCreate/TaskUpdate support
  remains pending.

## [0.3.28] - 2026-09-28

### Fixed
- Problem reports now bound the full encoded GitHub URL, preventing errors with long or Korean
  reports. Large reports can be copied or saved for attachment. The report dialog fits mobile
  screens, its chat entry button has a visible label and a touch-sized target, and manual edits
  survive status updates and inclusion changes until explicitly rebuilt.
- Messages queued while an agent works now form a persistent list per PC and pane instead of
  replacing the previous message. Each item can be edited, discarded, or explicitly sent;
  confirming one send leaves the remaining messages intact. Queue mutations read the latest
  stored list across tabs, and failed persistence is shown before a reload can lose messages.
- On iPhone (iOS 26 and later) the header of the home-screen app was blurred, not in Safari. iOS
  lays its Liquid Glass edge blur over the top of an installed web app unless a fixed or sticky box
  with a background covers that edge; the header is now sticky, so iOS takes its color there.
- Alerts could be turned on but not off: once on, the bell was disabled. It is now a switch for
  this device. Off drops the device's push subscription (the server forgets it) and silences the
  page's own alerts; on subscribes again. The choice is kept per device.
- A video playing next to the app stuttered while an agent worked. The working dot (the RUN badge,
  a live work block, a reconnecting connection) faded in and out smoothly, so the browser drew a
  new frame at every display refresh, 60 or more a second, for as long as the agent ran. It now
  jumps between its two looks: about one frame a second (600 to 13 frames in 10 s in the chat
  view, measured in Chrome).
- Android's system Back button closes a file or video preview and returns to the
  chat instead of leaving the app. Closing with X, Escape or the backdrop also
  consumes the preview's history entry; Forward restores the original file target.
- GJC chat only selects a unique transcript file held open by the pane's process.
  Panes sharing a working directory no longer follow whichever session was modified
  last. When exact file evidence is unavailable (including directory-only descriptors
  and platforms without `/proc`), chat reports unavailable instead of guessing.
- Machine polling no longer overwrites newer streamed pane statuses or machine rosters.
  Superseded HTTP responses and errors are ignored; subsequent polls still catch up.

## [0.3.27] - 2026-09-27

### Fixed
- An omo pane's chat keeps its transcript while a background task runs. omo holds the task's log
  (`.omo/senpi-task/logs/*.jsonl` in the working directory) open, and that file was taken for the
  pane's session, so the chat fell back to terminal text until omo restarted. Only files in omo's
  session store count now.

## [0.3.26] - 2026-09-27

### Changed
- Releases are published only from a `main` commit that passed the full CI run, and pull requests
  must pass the same checks before they merge.

### Fixed
- Foldable and tablet-width screens (481-768px, e.g. a Galaxy Z Fold8 inner screen): the header no
  longer breaks the Korean "채팅"/"터미널" labels one syllable per line, and no longer shows the
  sidebar collapse toggle (a no-op in drawer mode) or sign out beside the drawer button. Up to
  560px the chat/terminal switch shows icons only, so the pane title keeps room.
- The chat's terminal-text fallback, used when an agent's transcript cannot be found, reflows lines
  the terminal soft-wrapped instead of breaking them where the pty's columns ended. A PC whose
  herdr predates unwrapped reads falls back to the old read.
- Korean UI: the new session dialog's Browse, the prompt card's Submit and Send, and the held-input
  and queued-message banners' Send, Discard and Send now are translated.
- Phone-width screens (up to 480px) hide the command palette's keyboard shortcut hints, and the
  key bar puts its direct-typing toggle first, so a narrow cover screen no longer cuts it off.

## [0.3.25] - 2026-09-27

### Added
- Chat Markdown renders inline `\(...\)` and display `\[...\]` equations with KaTeX.
  Code stays literal, and invalid or incomplete formulas preserve the surrounding Markdown.

### Changed
- The installer keeps herdr's plugin install preview (every command of the manifest) to itself and
  prints only herdr's `Installed ...` line; when the install fails, it prints all of herdr's output.
- README: a sample of the installer's output, from a PC that had herdr but no Bun or Node.

### Fixed
- Ctrl+V in the terminal pastes clipboard text instead of sending a control character that
  triggers an agent's image-paste shortcut and reports "No image in clipboard". Korean text,
  multiline paste, Ctrl+Shift+V and other terminal control keys retain their expected behavior.
- Revoking a paired device closes its active terminal connections and roster stream immediately.
  A corrupt or unreadable device registry stays gated and intact, with recovery guidance.
- Token and paired-device sessions show **Sign out** in the header and command palette.
  Closed or obsolete pane selections recover to a live pane without discarding newly created
  panes or selections on disconnected PCs.
- The plugin also reads its settings from `.env` in herdr's plugin config dir, the name herdr's
  plugin docs use; it read only `env`, so a `.env` (say, `HOST=0.0.0.0` for a reverse proxy) was
  silently ignored. `env` is still read; where both set a key to different values, `.env` wins and
  `start` and `status` name the keys (never their values). `status` prints the files it read. The
  plugin checkout runs this, and in-app updates do not replace it: reinstall the plugin to get it.

## [0.3.24] - 2026-09-27

### Changed
- The installer's addresses are links a terminal can open with a click (OSC 8), plain text when
  the output goes to a file or log. It also names this PC's Tailscale IP next to the phone address,
  which stays the MagicDNS name: the HTTPS certificate is for the name, not the IP.

## [0.3.23] - 2026-09-27

### Fixed
- The one-line installer, run where the app is already installed, prints the phone address and its
  QR code from the version that runs. herdr's plugin directory keeps the version first installed
  (in-app updates run from `~/.config/herdr-web-ui/updates`), so it used to find no `phone` step
  there and only said to update. A running version from before 0.3.22 gets the address it already
  knows, as a QR code.

## [0.3.22] - 2026-09-27

### Added
- A one-line installer: `curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh`
  installs what is missing (herdr, Bun, Node 22, for the user only and without sudo), installs the
  herdr plugin and starts it when herdr runs. When Tailscale runs on the PC, it serves the app to
  the tailnet on the first free HTTPS port, says how to undo that, and prints the address a phone
  opens as a QR code. Running it again keeps what is there and prints the address again.
- `bun scripts/plugin.ts phone`, the installer's last step, for a plugin installed without it.

### Changed
- Through a proxy on a PC whose Tailscale login is known, as with `tailscale serve`, a request
  with no login (a tagged device) needs pairing, even before the first device is paired.
- The plugin starts the server with `~/.bun/bin`, `~/.local/bin` and the installer's Node appended
  to herdr's PATH, so a herdr started from a shell without them still runs terminals.

## [0.3.21] - 2026-09-27

### Added
- Codex and Claude skill activity stays visible above folded chat work blocks: the skill name,
  invocation/read status, and expandable evidence or document path. Recorded activity is distinct
  from completing the skill's workflow; English and Korean labels work on desktop and mobile.
- Native Codex image attachments, including image-only prompts, appear in the chat through
  bounded, pane-scoped image reads.

### Fixed
- Native context clears discard old turns, pending calls, loaded pages and stale cursors.
  Late page and tool-output responses cannot restore cleared history or populate another pane.
- omp, omo and gjc transcripts honor hidden messages and normalize string messages, tool field
  aliases and embedded results consistently across rendering, paging and full-output reads.
- omo transcript selection uses process/session evidence and rejects ambiguous same-directory
  candidates. Claude paste wrappers unwrap only when their identifiers match.

### Changed
- Growing Codex tasks parse incrementally while preserving transcript rewrite invalidation,
  reducing repeated parsing of long tool-heavy turns.

## [0.3.20] - 2026-09-27

### Added
- **Report a problem**: a small bug icon at the end of the chat's status line gathers what a chat
  or prompt-card bug is made of (the versions, browser and agent; the latest turns and the prompt
  card as parsed; the terminal screen if chosen) into a report to read and edit. It is then
  copied, saved as a file, or opened as a prefilled GitHub issue; nothing is sent on its own.

### Changed
- The ⚡ button beside the message box is gone: quick replies show above the box only when turned on
  in **Settings → Quick replies** (off by default), so the box looks as it did before them.
- The context left is a small ring beside the model, filled by what is used and red when little is
  left, as Codex's app shows it; hovering or tapping it says "Context 27% left" with the token
  counts. A session whose window the transcript does not name shows no ring.
- The `/ commands  @ files` hint above the message box is gone.
- In the sidebar, the computer the app runs on is marked **Host**, not "This PC", which on a phone
  read as the phone.
- Settings open from the sidebar's Settings button (and ⌘⇧, or the palette): the ⚙ in the header,
  one more way to the same place, is gone. On a phone that is ☰, then Settings.

### Fixed
- Numbered lists in the chat keep their numbers now: items with blank lines between them (as agents
  often write them) each read "1.", a list broken by a code block started over at 1, and one that
  began at 3 read 1. An item's indented lines now read as its own text, and a code block indented
  inside a list reads as code.

## [0.3.19] - 2026-09-27

### Added
- Quick replies: one-tap messages above the chat's message box (`continue`, `yes`, `no`,
  `commit and push`, `retry` to start with). Each is sent as if typed: queued while the agent works,
  taken as the answer when a question is open, and a draft in the box stays. **Settings → Quick
  replies** edits the list on each device; the row is hidden until the ⚡ button beside the paperclip
  shows it.
- The chat's status line says how much context is left: `74% left` from the window Codex records,
  or for Claude once a request has run past 200k (the 1M window); `68k used` where the transcript
  names no window (omp, omo, gjc, and Claude below 200k). It turns red at 20% left. Hovering shows
  the token counts.
- A tool call that failed says so: its row reads "failed" in red, its output is headed Error, and
  the folded "Worked for…" header counts the failures. Claude and omp record the failure; for Codex
  it is read from the output (a command that exited non-zero, a script or patch that failed).
- A file a tool call names (an edit, a read, a patch's files) opens in the viewer on a tap.
- A Codex patch reads as a diff: each file as a header, then its lines in red and green, and the row
  is summed up by the files it touches, also when an `exec` script applies it.
- While reading further up the chat, a ↓ button takes you back to the end, new messages or not.
- Images you sent show above your message: ones pasted into Claude's prompt, fetched only when
  shown, and ones attached here (an `@…png` mention). A tap opens them.
- An edit reads as one diff: unchanged lines once, removed and added lines in place between them,
  instead of the whole old block and then the whole new one. Several edits to one file each get
  theirs.
- Where a compaction folded a Claude conversation, a divider says so, and opens to its summary.
- Headings down to `######` render as headings.
- A tool output cut for the chat (past 4,000 characters) has a "Show the whole output" button that
  fetches the rest, up to 2 MB, into a box of its own.
- The `/` menu lists Claude's skills (yours and the project's) and the skills and commands of the
  plugins turned on in its settings, as `/<plugin>:<name>`. In a Codex pane it lists your saved
  prompts as `/prompts:<name>`, and `$` opens Codex's skills.
- On a phone, the terminal lens has an input line above the key bar. A phone keyboard rewrites
  what it typed (dictation revising a phrase, a Korean syllable being composed, autocorrect), and
  the terminal could not take back keys it had sent, so every revision arrived as more text. The
  line is written with the keyboard's own editing and goes to the pane whole, then Enter (typed
  like the keyboard, into an agent's open menu too); an empty line's button presses Enter alone.
  Tapping the terminal no longer raises the keyboard; the ⌨ key on the key bar switches to typing
  straight into it, remembered per device. Desktops are unchanged.

### Changed
- Remote PCs use the `remote-v5` runtime, which carries this release's server side to them: the
  context left and failed calls in their chats, images and whole tool outputs, skills in the menu,
  questions read in a narrow pane, and the terminal's input line. A connected PC's bridge updates
  itself as for `remote-v3`.
- Alerts wait before they go out, and a change of the pane meanwhile calls them off: a question
  answered at the PC within 10 seconds, or a finish followed by the next prompt within a minute,
  never buzzes the phone. A finish is told only after a turn that worked a minute or more, since a
  quick answer is read where it was asked.
- **Settings → Alerts** chooses, per device, whether a waiting agent alerts, and whether a finish
  does never, after a long turn (the default) or every time (then after 10 seconds). An ended
  terminal follows the finish choice.

### Fixed
- An agent's chat said "No conversation yet" until its first answer arrived, seconds on a remote PC.
  It now says it is loading.
- A Claude question never showed as a card in the chat when its pane was narrow (a phone, a split):
  the hint under the menu wraps (`… Esc to` / `cancel`), and it was looked for on one line. Hints
  are now read across the wrap, in every agent's menus, and so is the check that a menu is still
  open before an answer is typed into it. A single question's card is titled by its header chip.

## [0.3.18] - 2026-09-26

### Changed
- Remote PCs use the `remote-v4` runtime, which carries the fix below to the remote side: an omo
  or gjc pane that finished keeps reading DONE after the bridge restarts. A connected PC's bridge
  updates itself as for `remote-v3`.

### Fixed
- An omo or gjc pane that had finished read READY again after this server restarted (an update
  does): what this server adds to herdr's own `done` lived in memory. It is now kept in
  `completions.json` in the state directory, for the herdr it was seen in; a herdr started anew
  starts it over.

## [0.3.17] - 2026-09-26

### Changed
- Remote PCs use the `remote-v3` runtime, which carries 0.3.16's server fixes to the remote side: a
  finish in the pane herdr has in front reads DONE, and a Codex answer ending with a file link is
  found on screen. With **Update PC bridges automatically** on (the default), a connected PC's
  bridge updates itself once the app has; otherwise it asks for **Update bridge…**. herdr sessions
  are kept either way.

## [0.3.16] - 2026-09-26

### Added
- A pairing code from the PC's terminal, for a headless PC with no browser to open Settings →
  Devices in: `bun scripts/plugin.ts pair` (in the plugin checkout; a terminal command, since herdr
  keeps an action's output in its log) prints the code, the address a phone opens when Tailscale
  serves one, and that address as a QR code. Run by hand, it reads the PORT, HOST and token the
  plugin runs with from the config dir herdr names for it. Settings → Devices also shows the pairing
  link as text, to send to the other device however you like.

### Fixed
- Web addresses in the chat open. An address in backticks (`` `https://…` ``, as agents often write
  them) is a link that still looks like code; `[docs](www.example.com/x)`,
  `[guide](docs.example.com/guide)` and `[here](localhost:7317)` are links, not files; a bare
  `www.example.com/…` links like a full URL does, and `[here](127.0.0.1:8080)` over plain http. A
  file and its line (`[main.ts](main.ts:42)`) still opens the file, never a site of that name. In
  the terminal view, addresses in the output open in a new tab on click.
- A Codex chat whose last answer ends with a file link said "Conversation unavailable" while the
  terminal was open. Codex shows such a link as its label and a path relative to the repo, not
  the absolute path the session file keeps, so that answer was never found on screen. Answers are
  now looked for up to their last link target.
- An agent that finished in the pane herdr's terminal has in front read READY, and sent no alert,
  though nobody was looking: herdr reports a finish there as idle, and working from a browser or
  a phone never moves that focus. A finish now reads DONE and alerts in every pane, until the pane
  works again or focus moves onto it in herdr's terminal.
- A chat link to a local file (`[report](/repo/output/REPORT.md)`, as Codex writes them) showed
  only its label, so a sentence like "results and evidence" ended with nothing after it. The label
  now opens the file in the viewer, and where no viewer is available the path shows after it.

## [0.3.15] - 2026-09-26

### Added
- The app speaks Korean. It follows the browser's language, or **Settings → Appearance → Language**
  picks English or 한국어. Every label, button, hint and status in the client is translated; what
  agents write, terminal output and server messages are not. A test keeps the dictionary complete.

## [0.3.14] - 2026-09-26

### Added
- **Who gets in, without a token.** From anywhere but this PC, a request now gets in as the PC's
  own Tailscale login (which `tailscale serve` states in a header nobody else can set), as a
  paired device, or with the token. **Settings → Devices** pairs a device: a six-digit code that
  lives ten minutes, or the QR code that carries it, entered once on the other device, which then
  keeps its own credential; the list shows every device with its last visit, and **Revoke** ends
  one at its next request. Another Tailscale user's device is refused with a message. Until the
  first device is paired, and with no token set, a LAN or proxied address stays open as before.
  The sign-in screen asks for the code first and keeps the token as the other way.

## [0.3.13] - 2026-09-26

### Fixed
- With two or more Codex panes, one pane's chat could show another pane's conversation. Since
  Codex 0.157 every Codex TUI shares one app-server daemon, and that daemon reports each TUI's
  thread to herdr as the thread of the pane that started it. That report is now only a fallback:
  what the pane shows on screen decides, and a thread another pane shows, is bound to, or was
  resumed on is never taken for it.

## [0.3.12] - 2026-09-26

### Added
- The website has a demo, <https://devswha.github.io/herdr-web-ui/demo/>: the app itself on a
  fictional session, no server. Its five panes, chats and Codex approval are the README media's;
  answering the approval, sending a message and typing into the shell pane all get demo answers.

### Fixed
- Installing no longer compiles a native module. The terminal addon comes prebuilt for Linux x64
  and arm64 and for macOS (`@lydell/node-pty`, node-pty 1.1.0 repackaged), so a PC without Python
  and a C++ toolchain installs, where `herdr plugin install` used to end in a page of node-gyp
  errors and "Plugin was not installed". The first build step now says in one line what is
  missing (`bun`, `node`, or a version too old) instead of failing some steps later.

## [0.3.11] - 2026-09-26

### Added
- **Settings → Phone**: how to get the app onto a phone from this PC. When the page is already on
  an HTTPS address, or Tailscale on the PC already serves the app, it shows that address as a QR
  code. Otherwise it shows the one `tailscale serve` command still to run, on the first free of the
  usual HTTPS ports, with a Copy button and the address it will give, or says that Tailscale is
  not connected or not installed. The server reads `tailscale status` and `tailscale serve status`
  only (`GET /api/access`); it never changes the tailnet.
- **Star on GitHub** in Settings → About, next to a link to the website.
- A website, <https://devswha.github.io/herdr-web-ui/>: the demos, the install command, the phone
  setup and how it compares with other herdr phone clients. GitHub Pages builds it from `site/`
  on every push to `main`; `bun run build:site` builds it locally.

### Fixed
- A link styled as a button (**Reconnect** after a PC drops, **Star on GitHub**) is no longer
  underlined.

## [0.3.10] - 2026-09-26

### Fixed
- A file named without its folders in a chat answer (`demo.mp4` for `docs/screenshots/demo.mp4`)
  opens: the viewer finds it under the pane's folder, ignored files included, and lists the
  files to choose from when several have that name. It used to say "No readable file".

## [0.3.9] - 2026-09-26

### Added
- Open the files your agents write, from any device. A file path in a chat answer
  (`docs/demo.mp4`, `~/out/shot.png`) opens in a viewer: images, video and audio that play and
  seek at once, PDFs, and the start of a text file, each with Open in new tab and Download.
  **Browse files** (in the header, or the command palette on a phone) lists the pane's folder
  and any other. Files stream from disk with ranges, so a large video costs the server no memory;
  HTML and SVG open sandboxed and text as plain text, never as script on the app's origin.

### Changed
- The README's screenshots and demos are sharper and framed: recorded at 2x, in a browser window
  or a phone, with a moving camera and cursor on desktop. The phone demo no longer shows only the
  top left of the screen.

## [0.3.8] - 2026-09-26

### Added
- The chat pins the agent's todo list to its bottom: done count and the item in progress on one
  line, the whole list by phase when opened. It follows Claude Code's `TodoWrite`, Codex's
  `update_plan`, and omp, omo and gjc todo operations, and in the work block a todo call reads as
  one line ("done · Build") that opens to the list as it stood after it.

### Fixed
- A pane's terminal (and the chat over it) no longer shows "terminal ended" when it reconnects
  just after Codex finished an answer, for example on a phone coming back from the background.
  herdr refuses an attach while a read of the same terminal is in progress, and asks for a
  retry. On an idle Codex pane, the transcript match's 400-line read makes herdr scroll the
  history back, which takes about a second or more. The attach is now retried for as long as
  such a read can last, and a refused attach no longer prints herdr's message into the terminal.
  ([#45](https://github.com/devswha/herdr-web-ui/pull/45) by @Yoonwoo-Ha)
- An omo or gjc pane that finishes while you are not looking at it reads **DONE** (and alerts),
  not READY, and reads RUN while it works. herdr recognises these agents from their screen and
  processes; omo's label turns from `pi` to `claude` mid-turn, so herdr reported the whole turn
  as `unknown` and its end as plain `idle`. The server now keeps whether each pane worked and
  reports what herdr does for agents it does not lose: done until the pane is focused in herdr.

## [0.3.7] - 2026-09-25

### Added
- Answer an agent's waiting prompt from the chat's message box: type an option's number or your
  own answer. A pick for an approval, a plan or a menu waits in the prompt card for **Confirm**,
  and the options are numbered to match ([#6](https://github.com/devswha/herdr-web-ui/pull/6) by @Yoonwoo-Ha).
- Codex's queued questions (the collapsed "? N questions" block) show as a card and are answered
  from the chat; the queue closes again afterwards, so messages still reach Codex. Prompts of
  Claude Code 2.1 and Codex 0.156 are recognised ([#6](https://github.com/devswha/herdr-web-ui/pull/6) by @Yoonwoo-Ha).
- **Browse** beside the directory field of a new session: pick the folder from a list instead of
  typing its path. It lists one folder at a time on the PC the session starts on, hidden folders
  on request. A remote PC offers it once its bridge is updated; until then, type the path.

### Fixed
- The header no longer says "reconnecting" after you switch to another pane on the same PC. The
  switch reset the connection badge, and the terminal, still connected, never reported again.

## [0.3.6] - 2026-09-25

### Added
- gjc and omo have their own marks in the sidebar and the chat. An omo pane is named `omo` even
  though herdr labels it `pi` or `claude` as omo works, so its mark no longer changes under you.
- gjc panes open in the chat view with their conversation, model and effort, like omp and omo.
  The chat follows the session the pane's gjc has open.

### Fixed
- A request that failed (an authentication error, an overloaded provider) shows its error in the
  chat of an omp, omo or gjc pane. The prompt used to stand there with no answer at all.

## [0.3.5] - 2026-09-25

### Added
- Web addresses in chat messages are links: a bare `https://…` URL or one in `<…>` opens in a
  new tab, as a `[text](url)` link already did. Punctuation that ends the sentence stays out of
  the link, and so does text written straight after it (e.g. Korean without a space).
- The chat composer attaches any file, not only PNG, JPEG, GIF and WebP images. An icon, a PDF or
  a log is stored beside the pane under its own name and mentioned by path, as images are; SVGs
  get a thumbnail too. Other files used to be dropped without a word.

### Fixed
- Resizing the window no longer lags on a long session. Every frame of the drag resized the pane,
  and each resize made herdr reflow it and the program in it (Claude Code) repaint its whole
  conversation; the terminal now resizes once the drag rests.
- The app does much less work while it sits open. The terminal under the chat view no longer
  draws every output frame, an unchanged chat is no longer re-rendered on every status update,
  and a hidden tab or a phone app in the background stops polling until it is back.
- A chat open on a long session no longer stalls the server every poll while the agent works. The
  server re-read and re-parsed up to 16 MB of the transcript every 2 s; it now reads only what was
  appended and re-parses only the last turn.
- Live status, pane-ended and session-changed updates resume after herdr restarts. One failed
  reconnect used to stop them until the web server itself restarted.
- Long code blocks in a chat answer no longer look cut off. A block was capped at about six lines
  with the rest behind an inner scroll that a phone does not show, so a long answer seemed to stop
  halfway. Blocks now show whole; one longer than 30 lines opens at its first 20 with a
  **Show all N lines** row below it.

## [0.3.4] - 2026-09-25

### Changed
- On a phone or tablet, an agent pane opens in the chat the first time you select it; shells, and
  every pane on a desktop, still open their terminal. The lens you pick is still remembered per
  pane.

### Fixed
- Scrolling the terminal on a phone scrolls herdr's history again when another tab (for example a
  desktop browser) already had that pane open. The phone joined a busy pane without its mouse
  mode, so a drag turned into arrow keys and paged through the agent's prompt history instead.
- Picking a session in the chat view and typing straight away now types into the chat box. The
  keys went to the hidden terminal instead, straight into the agent's own prompt, and a phone
  showed the typed text in the middle of the screen.

## [0.3.3] - 2026-09-25

### Added
- Remote PC bridges update in the background. When an app update needs a newer bridge, PCs that
  connect with their saved key are updated automatically (**Settings → Remote PCs**, on by
  default); with it off, **Update bridge** starts the same update in one tap. A PC that needs a
  password asks through **Sign in and update…**.
- The sidebar and the header show a bridge update's step, bytes and time left, with **Cancel
  update**. Closing the dialog after approval no longer cancels an install.
- The web server keeps downloaded bridge bundles by checksum and downloads each once, so a second
  PC or a retry only sends it to the PC.

### Fixed
- Dragging the terminal on a phone scrolls herdr's history again. The gesture was lost after its
  first move, since the redraw replaced the row it started on, and the browser then scrolled the
  page or the composer instead. The text now also follows the finger (drag down for older lines),
  and each scroll lands at the finger's position.
- Android notifications show the herdr mark instead of Chrome's bell as their small icon.

### Development
- Tests and the browser QA scripts run in a herdr session of their own, `herdr-web-ui-test`, so
  their workspaces and agents never show in the herdr you work in. `HERDR_TEST_LIVE=1` restores
  the old behaviour.

## [0.3.2] - 2026-09-25

### Changed
- A pane opens its terminal the first time you select it, agent panes included, instead of the chat.
  Switch to Chat once and that pane keeps opening in chat.
- `bun run start` now listens on `127.0.0.1` by default, like the plugin, instead of every
  interface. To reach it from your LAN again, set `HOST=0.0.0.0` together with `HERDR_WEB_TOKEN`;
  for a phone, `tailscale serve` or an SSH tunnel to `127.0.0.1` needs no change.
- The README and INSTALL.md say when a token is needed: not on this computer, over an SSH tunnel,
  or through `tailscale serve` on a tailnet of your own devices; needed on a LAN, a shared tailnet
  or a public address.

### Fixed
- A composer message that waited more than 45s behind earlier input is not typed any more; the
  composer keeps it and says nothing was typed. Before, it could reach the pane after the composer
  had given up on it, so sending it again typed it twice.
- Text typed after a message that is still sending keeps its leading spaces, and an edit inside
  the part being sent stays in the box with a note that it was not sent.
- A numbered menu row under Codex's collapsed question queue is no longer mistaken for its main
  prompt.

## [0.3.1] - 2026-09-25

### Changed
- Remote PCs use the `remote-v2` runtime, which carries 0.3.0's server changes (chat pages, the
  Codex conversation fixes, server-side message sending and `304` answers) to the remote side.
  A PC connected with the `remote-v1` bridge needs **Update bridge…** once; its herdr sessions are
  kept.
- A PC that only an update or an approval can reconnect says so: it stops retrying, shows the next
  step under its name with the button that does it (**Update bridge…** or **Set up…**), and a line
  under the header says the same, so it shows on a phone with the drawer closed.

## [0.3.0] - 2026-09-25

### Added
- Chat history pages: a transcript is read one page at a time (at most 16MB and 50 prompts), and
  scrolling up loads earlier turns while keeping your place. A long Codex rollout no longer re-reads
  the whole file on every poll, and a Codex conversation that was backtracked shows the history
  from the rollouts before it.
- **Settings → Chat → Chat font size**, from 11 to 24px. Messages, code and prompt cards scale
  together; the rest of the UI and the composer keep their size.
- The composer is resizable: drag its top edge or use ↑/↓, double-tap or press Home to go back to
  the automatic height. The height is remembered per device and capped at half the visible screen.
- The status line shows the reasoning effort Claude Code records, for example `Reasoning xhigh`.

### Changed
- **New session** is back at the top of the sidebar, opening on the selected PC (the same as
  Mod+Shift+N), with **Add PC** beside it.
- **Install app** shows in the sidebar unless the app is installed. Where the browser offers no
  install prompt (iOS, plain HTTP), it explains the platform's own steps, such as Share → Add to
  Home Screen on iOS. Settings → Install shows the same steps.
- A composer message is now sent on the server: agent panes use herdr's `agent.prompt`, which pastes
  the text and presses Enter separately, and refuses while the agent waits for an answer. Other
  panes get the text, a short gap, then Enter. This fixes messages left unsent in the agent's input
  box on phones, where the text and its Enter used to arrive as one chunk. The composer keeps the
  text until the pane confirms it, and says why when it can't be sent.
- The empty composer is taller (42px on desktop, 48px on touch) and its status line is a size up.
- Unchanged conversations answer `304` with no body, and the chat stops polling while the page is
  hidden, which saves data and battery on phones.
- Each window reopens its own pane on reload; a new window still starts on the last pane used.

### Fixed
- A Codex pane kept its conversation only while an answer was on screen; a long run of tool output
  flipped the chat to "Conversation unavailable". The pane now keeps the rollout it matched, or the
  thread named by `codex resume`, until a newer interactive thread begins in that directory.
- Conversation cursors are tied to the Codex rollout chain, so a changed chain reloads the chat
  instead of showing turns twice or out of order, and a chain whose earlier rollout was archived is
  looked up again instead of falling back to terminal output.
- On an iPhone, a second tap on the token field no longer closes the keyboard, and the empty band
  under the composer is gone.
- On Windows, the terminal measures its cells with a monospace font, so ASCII text is no longer
  spaced apart.

## [0.2.1] - 2026-09-23

### Fixed
- Updates now replace the update supervisor too. `server/managed.ts` became a small launcher that
  runs the active release's supervisor; after an install passes its health check the supervisor
  hands over to the new one (one more brief reconnect), and a new supervisor that cannot start is
  replaced by the previous one, with the failure shown in Settings → Updates.
- Release CI skips the one updater test that needs a live herdr.

## [0.2.0] - 2026-09-23

### Added
- Remote PCs over SSH: **Add PC** walks through the host fingerprint, password or key passphrase and
  an approved install, then groups workspaces by PC. Chat, files, images, terminal input and alerts
  follow the selected PC.
- Remote runtime bundles for linux-x64, linux-arm64, darwin-x64 and darwin-arm64, published as the
  `remote-v1` release and verified by SHA-256.
- Managed app updates: `bun run start` and the herdr plugin run a supervisor that builds each update
  in a private checkout, restarts after a health check, and rolls back a failed start.
- Updates follow release tags, and **Settings → Updates** and the header notice show versions
  (`v0.2.0`) instead of commit ids. The sidebar footer shows the running version.
- herdr plugin installs, which herdr leaves as a shallow detached checkout, can now update in place.
- [INSTALL.md](INSTALL.md), a step-by-step install guide written for coding agents.

### Changed
- Warm terminal redesign: amber on graphite (dark) and ledger paper (light), with agent states in
  their own colors. Sidebar titles use the full width, PC headers fit on one line, user chat turns
  are neutral cards, and the composer placeholder is short.
- The header drops the version pill and the theme toggle. The version is in the connection chip's
  tooltip and the sidebar footer, and theme lives in Settings and the command palette.
- README rewritten around setup, remote PCs, mobile use and updates.

### Fixed
- Codex transcripts resolve on macOS, where `/proc` does not exist.
- Underscores inside identifiers (`MAC_QA_CHAT_OK`) stay literal in rendered Markdown.
- The settings shortcut table no longer splits its row rules.

## [0.1.0] - 2026-09-22

First public version.

- Chat and Terminal lenses on one live herdr pane, with Codex, Claude Code and omp/omo transcripts.
- Composer with `/` commands, `@` file mentions, image paste, per-pane drafts and a queued message.
- Answers to approval, question and plan menus from chat.
- Session management, command palette and keyboard shortcuts.
- Installable PWA, a mobile key bar, web push alerts and optional token auth.
- Distribution as a herdr plugin.

[Unreleased]: https://github.com/devswha/herdr-web-ui/compare/v0.3.45...HEAD
[0.3.45]: https://github.com/devswha/herdr-web-ui/compare/v0.3.44...v0.3.45
[0.3.44]: https://github.com/devswha/herdr-web-ui/compare/v0.3.43...v0.3.44
[0.3.43]: https://github.com/devswha/herdr-web-ui/compare/v0.3.42...v0.3.43
[0.3.42]: https://github.com/devswha/herdr-web-ui/compare/v0.3.41...v0.3.42
[0.3.41]: https://github.com/devswha/herdr-web-ui/compare/v0.3.40...v0.3.41
[0.3.40]: https://github.com/devswha/herdr-web-ui/compare/v0.3.39...v0.3.40
[0.3.39]: https://github.com/devswha/herdr-web-ui/compare/v0.3.38...v0.3.39
[0.3.38]: https://github.com/devswha/herdr-web-ui/compare/v0.3.37...v0.3.38
[0.3.37]: https://github.com/devswha/herdr-web-ui/compare/v0.3.36...v0.3.37
[0.3.36]: https://github.com/devswha/herdr-web-ui/compare/v0.3.35...v0.3.36
[0.3.35]: https://github.com/devswha/herdr-web-ui/compare/v0.3.34...v0.3.35
[0.3.34]: https://github.com/devswha/herdr-web-ui/compare/v0.3.33...v0.3.34
[0.3.33]: https://github.com/devswha/herdr-web-ui/compare/v0.3.32...v0.3.33
[0.3.32]: https://github.com/devswha/herdr-web-ui/compare/v0.3.31...v0.3.32
[0.3.31]: https://github.com/devswha/herdr-web-ui/compare/v0.3.30...v0.3.31
[0.3.30]: https://github.com/devswha/herdr-web-ui/compare/v0.3.29...v0.3.30
[0.3.29]: https://github.com/devswha/herdr-web-ui/compare/v0.3.28...v0.3.29
[0.3.28]: https://github.com/devswha/herdr-web-ui/compare/v0.3.27...v0.3.28
[0.3.27]: https://github.com/devswha/herdr-web-ui/compare/v0.3.26...v0.3.27
[0.3.26]: https://github.com/devswha/herdr-web-ui/compare/v0.3.25...v0.3.26
[0.3.25]: https://github.com/devswha/herdr-web-ui/compare/v0.3.24...v0.3.25
[0.3.24]: https://github.com/devswha/herdr-web-ui/compare/v0.3.23...v0.3.24
[0.3.23]: https://github.com/devswha/herdr-web-ui/compare/v0.3.22...v0.3.23
[0.3.22]: https://github.com/devswha/herdr-web-ui/compare/v0.3.21...v0.3.22
[0.3.21]: https://github.com/devswha/herdr-web-ui/compare/v0.3.20...v0.3.21
[0.3.20]: https://github.com/devswha/herdr-web-ui/compare/v0.3.19...v0.3.20
[0.3.19]: https://github.com/devswha/herdr-web-ui/compare/v0.3.18...v0.3.19
[0.3.18]: https://github.com/devswha/herdr-web-ui/compare/v0.3.17...v0.3.18
[0.3.17]: https://github.com/devswha/herdr-web-ui/compare/v0.3.16...v0.3.17
[0.3.16]: https://github.com/devswha/herdr-web-ui/compare/v0.3.15...v0.3.16
[0.3.15]: https://github.com/devswha/herdr-web-ui/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/devswha/herdr-web-ui/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/devswha/herdr-web-ui/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/devswha/herdr-web-ui/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/devswha/herdr-web-ui/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/devswha/herdr-web-ui/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/devswha/herdr-web-ui/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/devswha/herdr-web-ui/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/devswha/herdr-web-ui/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/devswha/herdr-web-ui/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/devswha/herdr-web-ui/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/devswha/herdr-web-ui/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/devswha/herdr-web-ui/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/devswha/herdr-web-ui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/devswha/herdr-web-ui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/devswha/herdr-web-ui/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/devswha/herdr-web-ui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/devswha/herdr-web-ui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devswha/herdr-web-ui/releases/tag/v0.1.0
