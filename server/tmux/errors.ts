export class TmuxError extends Error {
  constructor(readonly code: string) { super(`tmux adapter: ${code}`); this.name = "TmuxError"; }
}
