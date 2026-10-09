/**
 * tmux counts the panes of a window. The web server counts each workspace's and names a new
 * terminal "pane 1", "pane 2" (server/pane-mesh.ts): the name an agent in a sibling pane is
 * told and can be asked for. Only this exact form is a number; any other label is someone's own.
 */
const AUTO_LABEL = /^pane ([1-9]\d*)$/;

export function autoPaneLabel(number: number): string {
  return `pane ${number}`;
}

/** The number in an automatic "pane N" label, null for a name someone chose. */
export function autoPaneNumber(label: string | null | undefined): number | null {
  const match = AUTO_LABEL.exec(label ?? "");
  return match ? Number(match[1]) : null;
}
