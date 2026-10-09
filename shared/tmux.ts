/** Short indexes belong to a window. %IDs belong to one server generation. */
export interface TmuxAddress { socket: string; generation: string; paneId: string }
export interface TmuxPaneState extends TmuxAddress {
  sessionId: string; windowId: string; windowIndex: number; paneIndex: number;
  sessionName: string; windowName: string;
  width: number; height: number; left: number; top: number;
  active: boolean; windowActive: boolean; zoomed: boolean; dead: boolean; synchronized: boolean;
}
export interface TmuxState { socket: string; generation: string; panes: TmuxPaneState[] }
export const TMUX_LAYOUTS = ["even-horizontal", "even-vertical", "main-horizontal", "main-vertical", "tiled"] as const;
export type TmuxAction =
  | { type: "split"; direction: "horizontal" | "vertical" }
  | { type: "resize"; direction: "L" | "R" | "U" | "D"; cells: number }
  | { type: "layout"; layout: typeof TMUX_LAYOUTS[number] }
  | { type: "swap" | "join"; otherPaneId: string }
  | { type: "synchronize"; enabled: boolean }
  | { type: "rename-window" | "rename-session"; name: string }
  | { type: "select" | "zoom" | "break" | "close" | "new-window" | "copy-mode" | "paste-buffer" };
