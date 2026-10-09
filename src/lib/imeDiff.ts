const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;
const SPACE_AFTER_HANGUL = /(?<=[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3])\u00a0/g;

/**
 * What a terminal must receive so that the text it was sent turns `before` into `after`:
 * one DEL per character removed from the end of `before`, then the characters added.
 * Used for WebKit's Korean IME, which rewrites the syllable it is building in place.
 */
export function imeEdit(before: string, after: string): string {
  before = before.replace(SPACE_AFTER_HANGUL, " ");
  after = after.replace(SPACE_AFTER_HANGUL, " ");
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) same += 1;
  // a surrogate pair split by the common prefix is removed and resent whole
  if (same > 0 && /[\uD800-\uDBFF]/.test(before[same - 1]!)) same -= 1;
  return "\x7f".repeat([...before.slice(same)].length) + after.slice(same);
}


/**
 * WebKit commits a space typed right after a Hangul syllable as U+00A0 inside the IME text
 * ("씩\u00a0"), and a shell does not split words on it. A lone U+00A0 (Option+Space) is left alone.
 */
export function imeSpaces(data: string): string {
  return data.length > 1 && HANGUL.test(data) ? data.replace(/\u00a0/g, " ") : data;
}
