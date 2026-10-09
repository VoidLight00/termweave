/**
 * A line diff between an edit's old and new text, as a reader wants it on a narrow
 * screen: unchanged lines once, removed and added lines in place between them.
 */

export interface DiffLine {
  kind: "same" | "del" | "add";
  text: string;
}

/** Past this many line pairs the table costs more than it shows: removed, then added. */
const MAX_CELLS = 250_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  // nothing on one side is no line there: an insertion is all added, a removal all removed
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length * b.length > MAX_CELLS) return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  // longest common subsequence, from the end, so the walk below goes forward
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: "same", text: a[i]! }); i++; j++; }
    else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) lines.push({ kind: "del", text: a[i++]! });
    else lines.push({ kind: "add", text: b[j++]! });
  }
  while (i < a.length) lines.push({ kind: "del", text: a[i++]! });
  while (j < b.length) lines.push({ kind: "add", text: b[j++]! });
  return lines;
}
