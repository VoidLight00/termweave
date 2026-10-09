# herdr web ui Design System

Extracted from the shipped client (`src/styles.css`, `src/components/*`), not invented. The machine
copy of every token is the `:root` block in `src/styles.css`; every table below mirrors it value for
value. When a component needs a value that is not here, add it to both first.

## 1. Atmosphere & Identity

A warm terminal: an amber-phosphor console on lamp-lit graphite (dark) or ledger paper (light),
with chat-app clarity. Tonal surfaces and hairlines keep the chrome out of the way. There is ONE
chrome color, amber: selection, focus, the terminal cursor and the user's own action (Send, primary
buttons). Agent states carry the remaining saturated colors and none of them is amber. The user's
chat turns are neutral raised cards, so a long thread never turns into a wall of color. Dark is the
default, light follows the same hierarchy, and comfortable or compact density changes scale without
changing information architecture. A dark report look and a neutral charcoal one are opt-in palettes
(Settings → Appearance → Colors); amber stays the default and the look before settings load.

The signature is the amber status rail: a 3px bar on the selected pane row (whose mark box also
takes an amber edge), the same amber on focus, the chosen lens glyph and the terminal cursor, tying
“what I am looking at” to “where I am typing.”

## 2. Color

### Palette

Only tokens overridden by `[data-theme="light"]` have a light value. Both columns are literal CSS.

| Role | Token | Dark | Light |
|------|-------|------|-------|
| Surface/base | `--bg` | `#12100e` | `#eeeae2` |
| Surface/panel | `--bg-panel` | `#181613` | `#faf8f3` |
| Surface/elevated | `--bg-elevated` | `#211e1a` | `#f2eee6` |
| Surface/hover | `--bg-hover` | `#2a2621` | `#e8e2d6` |
| Surface/input | `--bg-input` | `#1c1916` | `#fffdf9` |
| Border | `--border` | `#2d2924` | `#dcd4c6` |
| Border/strong | `--border-strong` | `#3e3830` | `#c5baa8` |
| Text/primary | `--text` | `#d8d0c3` | `#2a251f` |
| Text/dim | `--text-dim` | `#9b9183` | `#685e52` |
| Text/strong | `--text-strong` | `#f2ebdf` | `#16120d` |
| Accent | `--accent` | `#f0a830` | `#8c5000` |
| Accent/tint | `--accent-tint` | `rgba(240, 168, 48, 0.13)` | `rgba(140, 80, 0, 0.1)` |
| Primary | `--primary` | `#f0a830` | `#c57d12` |
| Primary/hover | `--primary-hover` | `#f6bb55` | `#d48c1f` |
| Primary/text | `--primary-text` | `#1b1407` | `#1b1407` |
| Primary/tint | `--primary-tint` | `rgba(240, 168, 48, 0.16)` | `rgba(197, 125, 18, 0.14)` |
| Status/idle | `--status-idle` | `#9b9183` | `#685e52` |
| Status/working | `--status-working` | `#6cb8d6` | `#155a72` |
| Status/blocked | `--status-blocked` | `#ff7b70` | `#a82323` |
| Status/done | `--status-done` | `#93c36b` | `#2f6317` |
| Working/tint | `--status-working-tint` | `rgba(108, 184, 214, 0.14)` | `rgba(21, 90, 114, 0.12)` |
| Blocked/tint | `--status-blocked-tint` | `rgba(255, 123, 112, 0.14)` | `rgba(168, 35, 35, 0.12)` |
| Done/tint | `--status-done-tint` | `rgba(147, 195, 107, 0.14)` | `rgba(47, 99, 23, 0.12)` |
| Danger/tint | `--danger-tint` | `rgba(255, 123, 112, 0.12)` | `rgba(168, 35, 35, 0.1)` |
| Danger/text | `--danger-text` | `#ffd9d4` | `#8f1d1d` |
| Meter/plenty | `--meter-ok` | `var(--status-done)` | `var(--status-done)` |
| Meter/getting low | `--meter-mid` | `#e2b93b` | `#865900` |
| Meter/low | `--meter-low` | `var(--status-blocked)` | `var(--status-blocked)` |
| Overlay/scrim | `--scrim` | `rgba(8, 6, 4, 0.55)` | `rgba(40, 32, 22, 0.35)` |
| Drawer shadow | `--shadow-drawer` | `0 0 40px rgba(0, 0, 0, 0.6)` | `0 0 40px rgba(40, 32, 22, 0.22)` |
| Popover shadow | `--shadow-pop` | `0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--border)` | `0 16px 48px rgba(40, 32, 22, 0.16), 0 0 0 1px var(--border)` |
| Card shadow | `--shadow-card` | `0 4px 16px rgba(0, 0, 0, 0.35)` | `0 4px 16px rgba(40, 32, 22, 0.07)` |

### Dark report and charcoal palettes

`settings.palette` (`amber` default, `report`, `charcoal`) is written as `data-palette`. The
tables above are amber, the base blocks; the two opt-in palettes override them in
`[data-theme][data-palette]` blocks of `src/styles.css`, which hold the complete values.

- **Dark report** is a near-black blue-grey canvas with hairlines: `--bg` `#0a0d12`, panel and
  terminal `#0f1319`, text `#b4bdc9` / `#8792a3` / `#e8ecf2`. Primary (the user's action) is white
  `#e8ecf2` with `#0a0d12` text; accent is electric blue `#4c9aff`, kept for small marks. Agent
  states use meaning colors (working `#f5b544`, input `#ff6b7a`, done `#3ddc97`, idle `#8792a3`).
  Terminal cursor `#4c9aff`, selection `#1f3a66`. It has near-square corners (`--radius-sm/md/lg/xl`
  = `2/3/3/4px`) and no resting card shadow (`--shadow-card: none`).
- **Charcoal** is a neutral Ghostty-style dark: `--bg` `#0f0f0f`, panel and terminal `#171717`, text
  `#cbc7c0` / `#918c85` / `#f5f2ec`, accent and primary near-white `#e8e4dc` with `#171717` text,
  muted states (working `#c2a2af`, input `#e0877f`, done `#a7b789`, idle `#9a958e`), terminal cursor
  `#cbc7c0`, selection `#49443d`. It keeps amber's rounded corners and card shadow.
- In light both use plain paper (`--bg` `#f2f2f0`, panel `#fafaf9`, text `#242424`, primary ink
  `#242424` with `#fafaf9` text): report with a blue `#1f5fcc` accent and cursor, charcoal with an
  ink accent and cursor `#242424`.

### Terminal theme

xterm.js reads a JavaScript theme, so `src/lib/settings.ts` `terminalTheme()` mirrors these four
CSS tokens verbatim for each resolved theme and palette (`settings.test.ts` checks the match).

| Role | Token | Dark | Light | xterm key |
|------|-------|------|-------|-----------|
| Background | `--term-bg` | `#181613` | `#faf8f3` | `background` |
| Foreground | `--term-fg` | `#d8d0c3` | `#2a251f` | `foreground` |
| Cursor | `--term-cursor` | `#f0a830` | `#8c5000` | `cursor` |
| Selection | `--term-selection` | `#4a3d26` | `#f0d9ae` | `selectionBackground` |

### Rules
- Amber is the one chrome color. Accent (selected, focused, informational) and primary (the user's
  action: Send, primary buttons) are both amber; in light, accent is the darker text-safe ochre and
  primary the brighter fill carrying ink text. Agent states never use amber. The report palette
  keeps the same split, accent (blue) marks and primary (white, or ink on paper) acts, and there
  agent states never use blue.
- Agent state is always written as a label as well as colored. Unknown uses dim text and a dashed
  edge rather than inventing a fifth state color.
- Tints are named tokens; components do not introduce ad hoc translucent state colors.
- `theme: "system"` follows `prefers-color-scheme`; `src/lib/settings.ts` writes the resolved
  `data-theme`, `color-scheme`, and matching PWA `<meta name="theme-color">`.

## 3. Typography

### Scale

| Level | Token | Comfortable | Compact | Typical use |
|-------|-------|-------------|---------|-------------|
| Micro | `--fs-2xs` | `11px` | `10px` | Badges, hints, kbd |
| Meta | `--fs-xs` | `12px` | `11px` | Subtitles, field labels |
| Small | `--fs-sm` | `13px` | `12px` | Controls, row titles |
| Body | `--fs-md` | `14px` | `13px` | Body and dialog copy |
| Large | `--fs-lg` | `16px` | `15px` | Header title, modal title |
| Display | `--fs-xl` | `18px` | `17px` | Markdown h1 |
| Input | `--fs-input` | `16px` | `16px` | Mobile-safe text input |

| Token | Value | Usage |
|-------|-------|-------|
| `--font-ui` | `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif` | Chrome and chat prose |
| `--font-mono` | `"Symbols Nerd Font Mono", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "D2Coding", monospace` | Paths, keys, terminal-adjacent metadata |
| `--lh-tight` | `1.2` | Titles |
| `--lh-base` | `1.5` comfortable / `1.45` compact | Body copy |
| `--fw-regular` | `400` | Body |
| `--fw-medium` | `500` | Controls |
| `--fw-semibold` | `600` | Labels and titles |
| `--fw-bold` | `700` | Brand |
| `--tracking-tight` | `-0.01em` | Brand and primary titles |
| `--tracking-caps` | `0.06em` | Uppercase operational labels |

### Settings
- `theme`: `dark`, `light`, or `system`; default `dark`.
- `palette`: `amber`, `report` or `charcoal`; default `amber`.
- `density`: `comfortable` or `compact`; default `comfortable`.
- Terminal font size is independent: default `13px`, clamped to `10–22px`.
- Terminal and chat font families are comma-separated lists, default empty. They go in front of the
  terminal's built-in fonts (after the bundled Symbols Nerd Font Mono, which only draws icons) and of
  `--font-ui` in the chat's prose (as `--font-chat`), never in place of them; code in the chat keeps
  `--font-mono`. At most 200 characters, with `;`, `{`, `}`, `<`,
  `>`, `\` and control characters stripped and names with spaces quoted.
- Composer Enter behavior and folded thinking visibility are preferences, not typography tokens.
- All settings share one sanitized `localStorage["herdr-web-ui:settings"]` record.

## 4. Spacing & Layout

### Base unit

All spacing derives from a 4px base.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | `4px` | Tight icon and control gaps |
| `--space-2` | `8px` | Row and menu gaps |
| `--space-3` | `12px` | Control padding |
| `--space-4` | `16px` | Section and modal padding |
| `--space-5` | `20px` | Wide modal padding |
| `--space-6` | `24px` | Card breathing room |
| `--space-8` | `32px` | Large separation |

### Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `6px` | Chips and inner controls |
| `--radius-md` | `8px` | Buttons, inputs, selected rows |
| `--radius-lg` | `12px` | Menus and chat surfaces |
| `--radius-xl` | `16px` | Modals and composer |
| `--radius-pill` | `999px` | Pills and dots |

### Sizes

Comfortable values are `:root`; the final column is the complete compact override set.

| Token | Comfortable | Compact | Usage |
|-------|-------------|---------|-------|
| `--header-h` | `52px` | `46px` | App header |
| `--sidebar-w` | `320px` | `300px` | Sidebar/drawer |
| `--control-h` | `34px` | `32px` | Buttons and fields |
| `--touch-target` | `40px` | — | Coarse-pointer minimum |
| `--keybar-h` | `48px` | — | Terminal key bar |
| `--row-h` | `56px` | `44px` | Roster and palette rows |
| `--chip-h` | `20px` | `18px` | Badge/pill height |
| `--icon-size` | `18px` | — | Standard icon |
| `--mark-size` | `22px` | — | Brand mark |
| `--avatar-size` | `32px` | `26px` | Roster mark box |
| `--dot-size` | `7px` | — | Connection dot |
| `--rail-w` | `3px` | — | Selected-row rail |
| `--hairline` | `1px` | — | Borders |
| `--content-w` | `820px` | — | Chat/settings content |
| `--palette-w` | `640px` | — | Command palette |
| `--palette-top` | `12vh` | — | Palette top offset |

### Focus and layers

| Token | Value | Usage |
|-------|-------|-------|
| `--ring` | `2px solid var(--accent)` | Global `:focus-visible` outline |
| `--ring-offset` | `2px` | Outline offset |
| `--z-banner` | `5` | Terminal banners |
| `--z-popover` | `10` | Composer completions |
| `--z-scrim` | `15` | Mobile drawer scrim |
| `--z-drawer` | `20` | Mobile drawer |
| `--z-modal` | `30` | Dialog and palette scrims |
| `--z-droplet` | `40` | In-app alert, over dialogs |

### In-app alert

One set for both themes: the card is island black wherever it shows.

| Token | Value | Usage |
|-------|-------|-------|
| `--droplet-bg` | `#000` | Drop, anchor and card |
| `--droplet-text` | `#f5f5f7` | Pane name |
| `--droplet-text-dim` | `rgba(245, 245, 247, 0.62)` | Ended detail, blank mark |
| `--droplet-blocked` | `#ff8a80` | Needs-input detail and dot |
| `--droplet-done` | `#9fd47a` | Finished detail and dot |
| `--droplet-mark-bg` | `rgba(255, 255, 255, 0.1)` | Agent mark disc |
| `--droplet-ring` | `rgba(255, 255, 255, 0.1)` | Card hairline |
| `--droplet-shadow` | `rgba(0, 0, 0, 0.35)` | Drop shadow under the liquid |

### Shell
- `.app` is a full-viewport column: `.app-header` over `.app-body`; the body is sidebar plus
  `.terminal-host`. While a phone's soft keyboard is up (`data-keyboard`), `--app-height` follows
  `visualViewport` so the keyboard does not cover input; otherwise the shell is `100dvh`, because an
  iPhone home screen app reports a visual viewport shorter than the screen without a keyboard.
- Header anatomy, left to right: mobile drawer toggle / desktop sidebar toggle; flexible context
  title plus PC/workspace/cwd subtitle; segmented Chat/Terminal switch; the connection chip (herdr
  version in its tooltip) and meta actions for palette, notifications, settings and lock. Theme
  lives in Settings and the palette; the herdr version also sits in the sidebar footer.
- The sidebar is fixed-width on desktop and a `<=768px` drawer. The desktop collapse removes its
  column; the drawer uses a scrim and keeps safe-area insets. On touch, a mostly horizontal swipe in
  from the left `24px` edge opens the drawer and a swipe to the left closes it (`56px` of travel).
- The terminal stack contains a positioned terminal surface, then composer or key bar. The xterm
  mount stays alive under the chat lens; changing views never creates a second connection.
- At `<=480px`, labels shed in priority order: version, brand name, context subtitle, connection
  text and desktop-only control labels. Icons and selected context remain.

## 5. Components

### Button (`.btn`, `.icon-button`)
- `.btn` is a medium text control. Variants: neutral, `.btn-primary`, `.btn-danger`, `.btn-ghost`.
  Primary uses `--primary`; danger uses danger tint plus blocked border; ghost removes fill/edge.
- `.icon-button` is a square unlabeled visual control with mandatory `aria-label`; `.is-outlined`
  adds the border. Both families use `--control-h`, `--radius-md`, focus ring, hover and disabled.
- Coarse pointers grow controls to `--touch-target`.

### Segmented control (`.segmented`)
- One `aria-pressed="true"` option receives hover fill and strong text; the group itself is an
  elevated, bordered `--radius-md` track.
- Used for Chat/Terminal, theme and density. It is not a generic tab list.

### Keyboard hint (`.kbd`)
- An inline mono keycap: `18px` high, strong bottom edge, `--radius-sm`, `--fs-2xs`.
- `Mod` resolves to `⌘` on Apple platforms and `Ctrl` elsewhere.

### Modal (`.modal*`)
- `.modal-scrim` centers an `aria-modal` dialog at `--z-modal`; `.modal` is a capped scrollable
  column with header, body and footer and `--shadow-pop`.
- At `<=640px`, it becomes a bottom sheet with top `--radius-xl` corners and safe-area padding.
- Escape, explicit close and scrim click close dialogs; first meaningful control receives focus.
- A confirm (`.confirm-dialog`, `alertdialog`, 420px) asks before something that cannot be undone:
  Cancel has the focus, Tab stays between the two buttons, the danger action sits at the right,
  and a failure shows inside it. A no gives the focus back to what opened it.

### Field (`.field`, `.input`, `.select`)
- Stacked uppercase label, optional hint and `--bg-input` field. Desktop fields use `--fs-sm`;
  small-screen fields retain `--fs-input` to avoid focus zoom.
- Focus names the edge with accent; errors use blocked/danger tokens and `role="alert"`.

### Menu / popover (`.menu*`)
- Bordered `--radius-lg` surface with `--shadow-pop`; rows use `--control-h`, `--radius-md`, icon,
  ellipsized main label and optional hint.
- Hover or `aria-selected` uses `--bg-hover`. Headings are dim uppercase micro labels.
- The sidebar's row menu (`.row-menu`) is a `.menu` drawn through a portal at fixed coordinates,
  under its `⋯` with right edges aligned, above it when the screen ends first, and over the drawer.
  A one-pane row offers Rename workspace, Rename pane, then Close under a hairline; a workspace
  header Rename workspace and Close workspace; a pane under a header Rename pane and Close. The
  danger item takes `--status-blocked`. At `<=640px` it is a `.modal` bottom sheet (`.row-sheet`):
  a grip, the row's name and place, 48px rows and a Cancel button; Tab stays among them. Escape, a press outside and
  focus leaving it close it (on a desktop a scroll or a resize too), and focus returns to the
  `⋯`. Arrow keys move between items. A row that leaves the roster takes its open menu with it.
- Close follows herdr's `ui.confirm_close`: a close that takes the workspace with it (a one-pane
  row, Close workspace) asks in a confirm first; a pane that leaves its workspace standing closes
  at once. After a confirmed close, focus lands on the header's workspace-list toggle.

### Badge (`.badge`)
- Agent states read **READY**, **RUN**, **INPUT**, **DONE**; unknown reads **—**.
- Idle is elevated/dim; working, blocked and done use their own tint and text. RUN carries a small
  breathing dot before the word; the word itself never fades.
- The written label and unknown dashed edge keep color from being the only signal.

### Pill (`.pill`)
- Mono metadata at `--chip-h`. The herdr version is a sidebar-footer pill; offline is the one header pill and uses danger tokens.

### Sidebar roster row and footer
- No top bar. The sidebar opens with the plan panel (when Settings puts it there), **Needs you**
  and the PC groups. A session starts from the `+` on its PC's header, or from the **New session**
  button in the dashed **No workspaces yet** box of an empty PC. **Add PC** lives in Settings →
  Remote PCs and in the command palette. Search lives in the command palette, not the roster.
- Appearance's **Sidebar grouping** is **By workspace** by default, with numbered, foldable
  workspace headers and merged single-pane rows. **By folder** opts into the grouping below.
  The choice applies immediately and persists in the browser's existing Settings record. Workspace
  and folder fold keys remain independent when switching modes; original workspace keys are retained.
- In folder mode, within each PC, panes with the same full cwd share a folder group, including panes from
  different workspaces. Trailing separators and Windows slash styles are normalized; case and
  symlinks are not resolved. Unknown cwd stays with its workspace rather than merging unrelated sessions.
- Every folder has a caret, folder glyph, basename, full-path subtitle and pane count, even for
  one pane. Its indented contents use the existing spacing and border tokens. Folder folds are
  remembered per PC and path; opening a pane unfolds its folder, but status updates do not.
- Folder order follows the first workspace in server order; workspace handles still reorder
  workspaces, not filesystem directories. Workspace names and rename actions remain inside the group.
- A workspace header shows drag handle, number, editable label, roll-up status and its `⋯`.
  Drag/drop reorders; `Alt+↑/↓` on the handle is the keyboard equivalent.
- Every pane row is two lines: agent/shell mark, then the editable title alone on line one (full
  width), and the status chip followed by the pane's place on line two. Mark boxes are neutral;
  the selected row gets the amber rail and an amber-edged mark box. The row ends in one `⋯`
  (`.row-menu-toggle`: shown on hover, focus, selection and while its menu is open; always on
  touch) that opens the row menu. Inline server failures stay beside their row.
- A title that is a working directory written out (`/home/me/dev/api`, `~/dev/api`, `C:\work\api`) <!-- leakscan:allow: example path -->
  shows as its last folder, here, in the header, the palette and every alert; the full path stays
  in the row's tooltip. Line two names what the group header does not: the folder under a
  workspace header (nothing when the title or the workspace is already that folder), the workspace under a folder
  header. A merged single-pane row in the workspace view has no header: it names the workspace
  and the folder, each only when the title or the other does not already say it. The palette,
  which has no header, names the workspace and the folder, once when they are the same.
- A PC group header is caret, monitor, name, “Host” for the local machine, a state dot
  (done = connected, working pulse = connecting/reconnecting, blocked = error), then a `+` that
  starts a session on that PC (disabled while it is offline) and, for an SSH PC, its manage
  button. Connected says
  nothing more; every other state is written under the name, with the server's error clamped to
  two lines and complete in the tooltip.
- Single-pane workspaces merge their workspace handle into the pane row, in both groupings: one
  row, no header, number or fold. A fold stored for such a workspace is ignored until it has a
  header again.
- Footer holds the contextual **Install app** action, Settings with the plan meters beside it,
  product name and herdr version.

### Plan meters (`.usage*`)
- Beside Settings, one button holding up to four chips (three and `+N` past that), one per
  account in the user's order: provider mark, mono `--fs-2xs` percent of the limit closest to
  running out (used, or left when Settings says so), and a 2px bar on a `--border-strong` track
  filled to that percent. From 80% used the percent and bar take `--status-blocked`; amber stays
  chrome. A chip whose numbers are stale or missing dims. An account hidden in Settings is
  left out of the strip and the popover; with every account hidden, neither shows.
- The button opens a popover above the footer (`--shadow-pop`, `--radius-lg`), as wide as the
  footer and scrolling when it outgrows the sidebar: per account its mark, name and plan pill with
  the email or login right-aligned and ellipsized, then one row per limit (label, reset time, right-aligned percent) over a 4px bar. A problem
  note is dim, red for an expired sign-in or a failed request.
- At the top of the sidebar (Settings → Where), a panel with one row per account: mark, provider
  and plan (the account only when two of one provider show), a 5px bar, the limit's window and its
  reset as `1d 3h (10/4 15:00)` (time left in short units, then the local date and time), and the
  percent large (`--fs-xl`) as tall as those three lines. The bar is coloured by what is left:
  `--meter-ok` from half, `--meter-mid` from a fifth, `--meter-low` under it (the percent too).

### New session dialog
- Agent select comes from `GET /api/agents`; shell-only is always available. Directory defaults to
  the selected pane cwd and name is an optional workspace label.
- Submit calls `POST /api/workspace/create`; the server performs `workspace.create` and, when an
  agent was chosen, `agent.start` in its root pane. Pending and partial agent-start failure are
  explicit before the created pane opens.

### Header context and connection
- A selected pane shows agent mark + title over workspace + cwd. With no selection, the brand fills
  the context slot.
- The segmented Chat/Terminal view switch lives in the header. There is no floating view-toggle pill.
- Connection is one quiet chip: a dot plus the written live/reconnecting/disconnected state;
  reconnecting pulses the dot. On phones the chip keeps only its dot.

### Chat turn (`.chat-turn`)
- The chat lens is a centered `--content-w` transcript over the still-attached terminal surface.
  Structured Claude/omp transcripts fall back to ANSI-stripped pane scrollback when unavailable.
- The register is Codex / gajae-code-app: a quiet document. User turns are right-aligned neutral
  cards (`--bg-elevated`, hairline edge, `--radius-lg` with a `--radius-sm` tail corner, ≤80% wide,
  no avatar or name) and open a new exchange with a hairline above. Assistant turns have no header: the answer is plain prose; a meta row (MD / TXT
  copy, time) fades in on hover (always visible on coarse pointers).
- Markdown supports headings, lists, links, quotes, tables, inline/fenced code and code-copy actions.
  Code blocks never scroll inside: one longer than 30 lines opens at its first 20 behind **Show all N lines**.
  Thinking renders as a folded block only when **Show thinking** is enabled.
- Auto-follow stops when the reader scrolls up; later output raises a **New messages** pill.

### Work block (`.work-block`, `.work-row`)
- One per assistant turn: a `▸ Worked for 7s · 1 edit · 2 commands` header (duration = next turn's
  timestamp minus this one's; "Working…" in `--status-working` behind a breathing dot while the agent runs) over
  one-line rows `▸ [icon] name / summary` in mono, indented under the header; mid-work narration
  sits between rows as dim, one-step-smaller prose. The newest turn opens by default, older ones
  fold. A row expands to the typed input (command, diff, file, checklist, raw) and an Output pane.

### Prompt card (`.prompt-card`)
- Appears in chat while the agent is blocked and the visible pane contains a supported Claude, omp,
  omo or codex question, approval or plan menu.
- A form of several questions (omo) shows a row of step chips (`.prompt-card-steps`) under the
  header: a chip per question, pill-shaped, mono number or a check once answered (`--accent`), the
  one asked now with an `--accent` border, `--accent-tint` fill and a `--primary` number. The title
  then reads `Question 1 of 2`; the review after the last question keeps the chips, all checked.
- Single options submit immediately; multi-select exposes checks plus Submit; supported custom input
  has its own labelled field. The prompt content hash rejects a stale answer with `prompt_changed`.
- Options are full-width rows (`.prompt-card-option`): the menu's number in mono, the label, its
  description under it in `--text-dim`. No option is filled as a default; a checked or typed pick
  gets `--accent-tint` + an `--accent` border. A `(Recommended)` suffix renders as a tag.
- `POST /api/pane/prompt/answer` translates the chosen answer into the agent's navigation keys and
  sends them through herdr `pane.send_keys` / text input. The card never fabricates a chat reply.

### Composer (`.composer`)
- Chat mode is ONE surface: the stack, the transcript and the composer region all sit on `--bg`,
  and the composer column equals the transcript column (`--content-w`, same `--space-4` gutter).
  The only card is the input box: `--bg-elevated`, hairline border, `--radius-xl`, `--shadow-card`;
  focus turns its border `--accent` (no inner outline). Above it the agent/status line and the
  completion popover; inside, ONE row — attach control | auto-growing textarea | Send / Queue /
  Stop — with the controls bottom-aligned so they stay beside the last line as the box grows;
  the image strip is its own row above that line.
- The status line ends, on fine pointers, with `/` commands and `@` files keycaps (plus `Mod+Enter`
  sends when **Enter sends** is off); the placeholder is just `Message <agent>…`.
- `/` completions come from `GET /api/pane/commands` and group built-in, user and project commands;
  `@` completions query `GET /api/pane/files`. Arrow keys navigate, Enter/Tab accepts, Escape closes.
- Paste, picker or drag/drop accepts up to four png/jpeg/gif/webp files per action. Each gets a local
  preview, uploads through `POST /api/pane/image`, and inserts a removable editable `@path` mention.
- While a phone's keyboard is up, a tap on the transcript or a drag down it (`32px`) puts the
  keyboard away. Each only blurs the field, so the draft stays.
- On a touch screen, picking a pane (drawer, palette, notification) or switching its lens never
  raises the keyboard: the user reads first, and a tap on the message box or the grid raises it.
  A desktop's picked pane takes typing at once.
- Enter sends and Shift+Enter breaks by default; with **Enter sends** off, Mod+Enter sends. IME Enter
  is ignored. While working, Stop sends Escape and Queue stores the next message.

### Voice input
- A mic button sits beside Attach in the composer and beside Send in the terminal input line; it
  fills with `--accent` while recording. Dictated text is inserted at the caret, never sent.
- The recording pill shows Cancel, a **Recording** label, the level bars, a mono timer and Done.
  Amber only; `--danger` stays for errors.

### Command palette
- `Mod+Shift+K` opens a top-offset `--palette-w` dialog searching panes and actions. Recent panes
  lead an empty query; arrows cycle, Enter activates and Escape closes.
- Actions cover new session, lens/sidebar/theme, settings, notifications, lock and refresh, with
  `.kbd` hints where a global shortcut exists.

### Settings dialog
- Appearance: Dark / Light / System, Comfortable / Compact, terminal font `10–22px`, terminal font
  family.
- Composer: Enter sends. Chat: Show thinking, chat font size and family. Shortcuts: the complete
  platform-resolved table.
- A font family is a text field saved when it is left, on Enter or when the dialog closes, not
  per keystroke.
- Remote PCs follows Devices: an **Add PC** row (label, one-line description, button) opens the PC
  setup dialog and closes Settings behind it; when that dialog closes, focus lands on the header's
  workspace-list toggle. Under the row, once the server has answered, the bridge auto-update switch.
- Install reflects installed, promptable or browser-instructions state; About links the repository.
- Subscription usage: the on switch with one description, then (when on) Used / Remaining and one
  hairline card of accounts (`.usage-accounts`, `--radius-md`): an uppercase `--bg-elevated` header
  with **Nearest limit first** at its right once the user has ordered, then one 38px row per account
  (mark, name, dim ellipsized email, then 28px move-up, move-down and eye controls in fixed columns;
  a move that cannot happen keeps its column but is not shown). A hidden account's row fades and
  its eye closes; it stays listed so it can be shown again.

### Terminal host, key bar and drawer
- xterm has `scrollback: 0`; wheel/touch gestures reach herdr's alternate-screen scrollback. The
  mount clips its own gutter and hides the unused xterm scrollbar.
- Terminal banners stack top-right for ended, reconnecting, observe and held-draft review states.
- The mobile key bar is Esc, Tab, one-shot Ctrl, arrows and `^C`; it never steals xterm focus.
- The mobile drawer slides over a scrim. Closed visibility removes its controls from the tab order.

### In-app alert
- While the app is on screen, a pane that needs input, finishes a turn (by the device's Finished
  choice) or ends drops a card from the top edge: a black drop falls from above the safe area,
  spreads into the card, and its text shows. It hangs from `env(safe-area-inset-top)` only, so a
  Dynamic Island, a notch and a desktop window take the same path; no device is guessed.
- One at a time; a newer one folds the current one away first. Tap opens the pane; a drag or flick
  up puts it away; it leaves by itself 3.6s after its text shows, and waits while touched.
- Not for the pane already open, and not while the app is hidden (system notifications cover that).
- Reduced motion: it fades in and out where it rests, without falling or spreading.

### Token gate
- A centered password card replaces the entire shell while authentication is required. It has a real
  label, autofocused field, primary Unlock button and linked alert text.
- Success mounts the shell; Lock unsubscribes push, deletes auth and returns to the gate.

### Role (no control surface)
- `interact` types and resizes; `observe` does neither. The server enforces both and the WS protocol
  carries `role` / `role-ack`.
- The app connects as `interact` and exposes no role switch. An observe acknowledgement still gates
  local input, adopts server geometry and displays the view-only banner.

## 6. Motion & Interaction

### Timing

| Type | Token | Value | Usage |
|------|-------|-------|-------|
| Micro | `--dur-fast` | `120ms` | Hover, active, toggle and control state |
| Standard | `--dur-base` | `180ms` | Drawer slide; reserved dialog timing token |
| Pulse | `--dur-pulse` | `1600ms` | Working and reconnecting dots (trough opacity 0.35; text never pulses) |
| Easing | `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Finite transitions |
| Pulse easing | `--ease-pulse` | `steps(2, jump-none)` | Endless working and reconnecting dots; avoids drawing every display refresh |
| Spring easing | `--ease-spring` | `cubic-bezier(0.32, 0.72, 0, 1)` | Voice recording pill enter (180ms, scale 0.96->1 + opacity, from the mic button) and exit (120ms) |

### Rules
- Only state changes move: hover/press, the drawer, settings switches, working and reconnecting.
- Dialogs and their scrims snap open and closed; they have no entrance or exit animation. On mobile,
  their static layout changes to a bottom sheet.
- The voice recording waveform is the one surface allowed to draw every frame: only while
  recording, driven by the live microphone level, transform-only (`scaleY` on 7 bars). The pill is
  a state change, not a dialog, so the snap rule above does not apply to it.
- `prefers-reduced-motion: reduce` removes pulses, drawer/control transitions, smooth chat scrolling
  and settings toggle motion. State remains legible without animation.
- Under reduced motion the voice pill swaps its bars for one level bar updated at 4 Hz and drops
  the ring and the morph; the **Recording** label and the timer stay.

## 7. Depth & Surface

### Strategy

**Tonal shift + hairline, with shadow reserved for overlays.** Resting shell surfaces have no shadow.

| Type | Value | Usage |
|------|-------|-------|
| Hairline | `var(--hairline) solid var(--border)` | Shell, fields, controls |
| Strong edge | `var(--border-strong)` | Hover/focus separation |
| Dashed edge | `var(--hairline) dashed var(--border)` | Unknown/empty states |
| Tonal lift | `--bg-elevated` on `--bg-panel` | Selection, chips, tracks |
| Tinted lift | Named tint over an opaque surface | Primary and agent states |
| Drawer shadow | `--shadow-drawer` | Mobile drawer |
| Overlay shadow | `--shadow-pop` | Menus, palette and modal cards |
| Card shadow | `--shadow-card` | The composer's input box — the one resting card in chat mode |

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA is the target; do not document numeric contrast without measuring both shipped themes
  and every actual backing surface.
- Global `:focus-visible` uses `--ring`; interactive controls remain keyboard reachable except the
  touch key bar, which intentionally preserves terminal focus and has hardware-key equivalents.
- Icon-only controls carry `aria-label`; toggles expose `aria-pressed` or `role="switch"`; selected
  pane exposes `aria-current`; dialogs expose `role="dialog"` and `aria-modal`.
- Status, loading and composer progress use `role="status"`; failures use `role="alert"`. Agent state
  is text plus color, and unknown adds a dashed edge.
- Touch targets grow to `--touch-target`; fields stay `--fs-input` where mobile zoom is a risk.
- `prefers-reduced-motion` is honored. Lucide/inline SVG decoration is hidden from assistive tech.
- Global shortcuts use the convention **Mod+Shift+key**: Mod is Command on Apple platforms and Ctrl
  elsewhere. The settings table is the discoverable source of the complete mapping.
- `document.title` is `<pane title> · herdr` while selected, otherwise `herdr web ui`.

### Accepted debt

| Item | Location | Why accepted | Exit |
|------|----------|--------------|------|
| Terminal content accessibility relies on xterm defaults | `PaneTerminal.tsx` | Screen-reader mode changes terminal DOM and input behavior | Decide with herdr TUI owners |
| Drawer has no focus trap | `.sidebar.is-open` | Closed state leaves the tab order, but open-state trapping is not implemented | Add a shared focus utility |
| Modal focus is initialized, not fully trapped | Dialog components | Escape/scrim/close work; tab containment is not shared | Add the same focus utility |
| Terminal colors exist in CSS and JavaScript | `styles.css`, `settings.ts` | xterm consumes a JS theme | Keep `terminalTheme()` verbatim with `--term-*` |
