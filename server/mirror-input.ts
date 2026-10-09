/**
 * What typing into a mirrored pane hands to herdr's `pane.send_text`.
 *
 * A mirror repaint carries no terminal modes, so the browser's xterm never learns that the
 * program turned bracketed paste on and sends a pasted block as bare lines joined by CR. An
 * agent's composer takes the first CR for Enter and sends line one alone. Checked on a
 * Windows PC (#257): the same block inside the paste markers stays in gjc's composer unsent.
 *
 * Only a pane herdr names an agent on gets the markers. cmd and PowerShell do not read VT
 * input, and the Windows console drops a sequence it has no key for on the way to them, but a
 * program that does read VT input receives the markers whether or not it turned bracketed
 * paste on: `cat` under Git Bash showed `^[[200~` around the block. Any other pane therefore
 * gets the bytes as they came, and so does a paste whose pane herdr could not be asked about.
 * Enter, Ctrl+C, Esc, Tab and the arrows already work there as plain bytes and stay as typed.
 *
 * A Linux or macOS PC mirrors too, when it has no Node for the PTY sidecar, and herdr there
 * hands `send_text` to the program byte for byte, adding no markers even where the program
 * turned bracketed paste on (measured, herdr 0.9.0: `cat -v` after `ESC[?2004h` showed the two
 * lines bare). Two lines sent from the terminal's input line to gjc on such a mirror went as
 * two messages (#269), so the same shaping applies wherever a pane is mirrored.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export async function mirrorInput(text: string, paneAgent: () => Promise<string | null>): Promise<string> {
  // typing is one key per frame: only a paste has a line break with more text after it
  if (!/[\r\n][^\r\n]/.test(text)) return text;
  // a terminal that knew the mode has wrapped it already
  if (text.includes(PASTE_START) || text.includes(PASTE_END)) return text;
  let agent: string | null;
  try {
    agent = await paneAgent();
  } catch {
    // unknown is treated as no agent: bare lines are what the pane got before this module
    return text;
  }
  return agent ? PASTE_START + text + PASTE_END : text;
}
