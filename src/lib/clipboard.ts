/**
 * Copies text. The clipboard API exists only in secure contexts (HTTPS or localhost), so on a
 * plain-HTTP LAN address it selects the given node instead, ready for a long press or Ctrl+C.
 * Returns whether the text is on the clipboard.
 */
export async function copyText(text: string, fallback?: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* no clipboard API here, or the browser refused */
  }
  if (fallback instanceof HTMLTextAreaElement || fallback instanceof HTMLInputElement) {
    fallback.focus();
    fallback.select();
  } else if (fallback) {
    const range = document.createRange();
    range.selectNodeContents(fallback);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return false;
}
