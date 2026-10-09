/**
 * A PowerShell single-quoted literal. PowerShell takes the curly quotes U+2018 to U+201B
 * for a single quote as well (live-verified: `'a\u2019 + 'x' + \u2019b'` runs as three
 * terms), so each is doubled like the ASCII one, or a path holding one would end the
 * literal and run what follows it.
 */
export function psQuote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid characters for a remote path");
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}
