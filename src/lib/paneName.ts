/**
 * A pane is known by its project, not by where it sits on disk. A shell's terminal title is
 * usually its working directory written out ("/home/me/dev/api", "~/dev/api", "C:\\work\\api"): // leakscan:allow: test fixture
 * shown whole, it is cut off long before the part that tells panes apart. Such a title shows as
 * its last folder; the full path stays in the row's tooltip. Any other title is left alone.
 */
import { autoPaneNumber } from "../../shared/pane-label.ts";

const PATH_TITLE = /^(?:~(?=$|[\\/])|\/|[A-Za-z]:[\\/])/;

export function shortPathTitle(title: string): string {
  const trimmed = title.trim();
  return PATH_TITLE.test(trimmed) ? folderName(trimmed) : title;
}

/** A path's last folder, split on either platform's separator: "C:\\work\\api" is "api" as "/work/api" is. */
export function folderName(path: string): string {
  const trimmed = path.trim();
  const last = trimmed.split(/[\\/]+/).filter((part) => part !== "").at(-1);
  if (last === undefined) return trimmed; // "/" itself
  // a drive root keeps the separator it was written with, so it still reads as a place
  return /^[A-Za-z]:$/.test(last) ? `${last}${trimmed[2] ?? "\\"}` : last;
}

/**
 * What a tab or row shows for a pane: a name someone chose stands alone, as it always did. An
 * automatic "pane 2" (shared/pane-label.ts) only numbers the live title - "2 · api" - so
 * naming every new terminal does not hide what it is running.
 */
export function composeTitle(label: string | null | undefined, live: string): string {
  const name = label?.trim() ?? "";
  const number = autoPaneNumber(name);
  if (number === null) return name || live;
  return live ? `${number} · ${live}` : name;
}

/** "workspace · folder", without saying the same name twice. */
export function placeLine(workspace: string, folder: string): string {
  return !folder || folder === workspace ? workspace : !workspace ? folder : `${workspace} · ${folder}`;
}
