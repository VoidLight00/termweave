import { TMUX_LAYOUTS, type TmuxAction } from "../../shared/tmux.ts";
import { TmuxError } from "./errors.ts";

const paneID = (id: unknown): id is string => typeof id === "string" && /^%[0-9]+$/.test(id) && id.trim() === id;
export function validTmuxName(name: unknown): name is string {
  return typeof name === "string" && name.length >= 1 && name.length <= 80 && !/[^A-Za-z0-9_-]/.test(name);
}

/** Output contains only validated IDs, bounded numbers and fixed tokens. No shell strings. */
export function actionCommand(paneId: string, action: TmuxAction, sessionId = "$0", windowId = "@0"): string {
  if (!paneID(paneId) || !action || typeof action !== "object") throw new TmuxError("invalid_action");
  if (!/^\$[0-9]+$/.test(sessionId)) throw new TmuxError("invalid_session");
  if (!/^@[0-9]+$/.test(windowId)) throw new TmuxError("invalid_window");
  const target = `-t ${paneId}`;
  switch (action.type) {
    case "split":
      if (!["horizontal", "vertical"].includes(action.direction)) break;
      return `split-window -${action.direction === "horizontal" ? "h" : "v"} -d ${target}`;
    case "resize":
      if (!["L", "R", "U", "D"].includes(action.direction) || !Number.isInteger(action.cells) || action.cells < 1 || action.cells > 1000) break;
      return `resize-pane ${target} -${action.direction} ${action.cells}`;
    case "layout":
      if (!TMUX_LAYOUTS.includes(action.layout)) break;
      return `select-layout ${target} ${action.layout}`;
    case "swap": case "join":
      if (!paneID(action.otherPaneId) || action.otherPaneId === paneId) break;
      return `${action.type === "swap" ? "swap-pane" : "join-pane -h"} -d -s ${action.otherPaneId} ${target}`;
    case "synchronize":
      if (typeof action.enabled !== "boolean") break;
      return `set-window-option ${target} synchronize-panes ${action.enabled ? "on" : "off"}`;
    case "rename-window": case "rename-session":
      if (!validTmuxName(action.name)) break;
      return `${action.type} -t ${action.type === "rename-session" ? `'${sessionId}'` : paneId} ${action.name}`;
    case "select": return `select-window -t '${sessionId}:${windowId}' ; select-pane ${target}`;
    case "zoom": return `resize-pane ${target} -Z`;
    case "break": return `break-pane -d -s ${paneId}`;
    case "close": return `kill-pane ${target}`;
    case "new-window": return `new-window -d -t '${sessionId}:'`;
    case "copy-mode": return `copy-mode ${target}`;
    case "paste-buffer": return `paste-buffer -p ${target}`;
  }
  throw new TmuxError("invalid_action");
}
