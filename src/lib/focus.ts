/**
 * Where focus goes when the control that had it is gone: Add PC closed Settings behind it, a
 * closed row left the roster. The header's workspace-list toggle is the control nearest the PC
 * list, and one of the two is always shown: the drawer's on a phone, the sidebar's on a desktop.
 * Runs a frame later, once React has taken the vanished control out of the document.
 */
export function focusWorkspaceListToggle(): void {
  window.requestAnimationFrame(() => {
    const toggles = document.querySelectorAll<HTMLElement>(".app-header .drawer-toggle, .app-header .sidebar-toggle");
    [...toggles].find((toggle) => toggle.getClientRects().length > 0)?.focus();
  });
}
