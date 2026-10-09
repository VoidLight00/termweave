/**
 * Bookmarkable one-click unlock: `#auth=<token>` in the URL fragment.
 *
 * The fragment never leaves the browser (it is not sent with any request, so
 * it cannot land in server logs), and it is consumed exactly once: the address
 * bar is rewritten without it, and the HttpOnly session cookie stays the only
 * stored credential. A wrong or stale link token simply falls back to the gate.
 */

/** Parses `#auth=<token>`; null for any other fragment (or none at all). */
export function authTokenFromHash(hash: string): string | null {
  const match = /^#auth=(.+)$/.exec(hash);
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null; // a truncated percent-escape: nothing we can offer to the gate
  }
}

/**
 * Consumes the auth link on load: returns the token (if any) after stripping
 * the fragment from the address bar, keeping any `?pane=` search intact.
 */
export function takeAuthTokenFromUrl(): string | null {
  if (!window.location.hash.startsWith("#auth=")) return null;
  const token = authTokenFromHash(window.location.hash);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return token;
}
