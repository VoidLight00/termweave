import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Folder colors live on the server, so the app and every browser show the same ones. */
const PRESETS = new Set(["blue", "green", "amber", "rose", "violet", "cyan"]);
export const isWorkspaceColor = (value: unknown): value is string =>
  typeof value === "string" && (PRESETS.has(value) || /^#[0-9a-f]{6}$/.test(value));

export class WorkspaceColors {
  private readonly file: string;
  private colors: Record<string, string>;
  constructor(private readonly dir: string) {
    this.file = join(dir, "workspace-colors.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      this.colors = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => isWorkspaceColor(entry[1])));
    } catch { this.colors = {}; }
  }
  all(): Record<string, string> { return { ...this.colors }; }
  set(workspaceId: string, color: string | null): void {
    const { [workspaceId]: _, ...rest } = this.colors;
    this.colors = color === null ? rest : { ...rest, [workspaceId]: color };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.colors), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
