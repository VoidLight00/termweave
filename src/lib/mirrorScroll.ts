/**
 * A mirrored pane's history, as the wheel and a finger move through it. A mirror repaints herdr's
 * visible screen, so herdr's own viewport is the history: the pane is scrolled through the API
 * (offset_from_bottom, 0 at the bottom), and the mirror's next read shows the rows it moved to.
 * Only the arithmetic lives here; the DOM, timing and requests stay in PaneTerminal.
 */

/** WheelEvent.deltaMode, without the DOM */
export const DELTA_PIXEL = 0;
export const DELTA_LINE = 1;
export const DELTA_PAGE = 2;

export interface WheelStep {
  /** whole lines to move, positive showing older text */
  older: number;
  /** pixels short of a whole line, carried into the next step */
  carried: number;
}

/**
 * One wheel (or finger) delta in whole lines, as a selecting drag's wheel counts them: a line
 * or page delta in pixels of the screen's row height, the remainder carried. A wheel up
 * (negative deltaY) shows older text. Each whole line moves `speed` lines (the wheel speed).
 */
export function wheelStep(carried: number, deltaY: number, deltaMode: number, lineHeight: number, rows: number, speed = 1): WheelStep {
  if (!(lineHeight > 0)) return { older: 0, carried };
  const pixels = carried + (deltaMode === DELTA_LINE ? deltaY * lineHeight : deltaMode === DELTA_PAGE ? deltaY * rows * lineHeight : deltaY);
  const lines = Math.trunc(pixels / lineHeight);
  // a whole -0 is still no line
  return { older: lines === 0 ? 0 : -lines * Math.max(1, Math.round(speed)), carried: pixels - lines * lineHeight };
}

/** Where `older` lines from `offset` land in a history of `max` lines above the bottom. */
export function historyOffset(offset: number, older: number, max: number): number {
  return Math.max(0, Math.min(Math.max(0, max), offset + older));
}
