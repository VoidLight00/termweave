/**
 * OSC 52 (clipboard set): a pane program's "copy" button can only emit an escape
 * sequence down the pty - it cannot reach the browser clipboard by itself. xterm
 * hands the sequence to an addOscHandler(52) callback (PaneTerminal), and this
 * module turns the raw payload into text for navigator.clipboard.
 *
 * Payload shape: `<selection>;<base64>` - the selection char (c/p/s) is accepted and
 * ignored (one browser clipboard); an empty or `?` payload is a clipboard QUERY,
 * which we do not answer. Anything above MAX_OSC52_BYTES is dropped: clipboard
 * writes are user-visible side effects and a runaway paste loop must not wedge the
 * tab. Pure logic, DOM-free (see osc52.test.ts).
 */

export const MAX_OSC52_BYTES = 100 * 1024;

/** The decoded text, or null when the payload is a query, malformed or oversized. */
export function parseOsc52(payload: string): string | null {
  const separator = payload.indexOf(";");
  if (separator < 0) return null;
  const encoded = payload.slice(separator + 1);
  if (encoded === "" || encoded === "?") return null;
  // cheap pre-check on the encoded length before allocating the decode buffer
  if (encoded.length > ((MAX_OSC52_BYTES / 3) | 0) * 4 + 4) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    return null; // invalid base64
  }
  if (bytes.byteLength > MAX_OSC52_BYTES) return null;
  return new TextDecoder().decode(bytes);
}
