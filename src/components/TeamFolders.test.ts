import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { addTeamFolder, assignTeamPane, emptyTeamFolders, teamFoldersKey, type TeamFolders as FolderState } from "../lib/teamFolders.ts";
import type { PaneInfo } from "../../shared/protocol.ts";
import { TeamFolders } from "./TeamFolders.tsx";

function render(state: FolderState): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const key = teamFoldersKey("local", "project");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: (name: string) => name === key ? JSON.stringify(state) : null },
  } });
  try {
    const panes = [{ pane_id: "p1", terminal_id: "t1" }, { pane_id: "p2", terminal_id: "t2" }] as PaneInfo[];
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(TeamFolders, {
      machineId: "local", workspaceId: "project", panes,
      paneTitle: pane => pane.pane_id,
      renderPane: pane => createElement("button", { "data-test-pane": pane.pane_id }, pane.pane_id),
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

describe("TeamFolders sidebar rendering", () => {
  it("keeps every existing pane without folders or assignments", () => {
    const html = render(emptyTeamFolders());
    expect(html.match(/data-test-pane=/g)).toHaveLength(2);
    expect(html).not.toContain("<select");
    expect(html).toContain('class="team-folder-add"');
  });
  it("renders nested teams, one copy per pane, and assignment controls", () => {
    const nested = addTeamFolder(addTeamFolder(emptyTeamFolders(), "team", "개발팀", null), "sub", "검증팀", "team");
    const html = render(assignTeamPane(nested, "t1", "sub"));
    expect(html.match(/data-test-pane=/g)).toHaveLength(2);
    expect(html.match(/<select/g)).toHaveLength(2);
    expect(html).toContain("개발팀 / 검증팀");
    expect(html).toContain('value="sub" selected=""');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="team-folder-');
  });
  it("does not assign a new shell that reuses an old pane ID", () => {
    const state = assignTeamPane(addTeamFolder(emptyTeamFolders(), "team", "Old team", null), "old-terminal", "team");
    // p1 is the reused slot; its live terminal is now t1, not old-terminal.
    const html = render(state);
    expect(html).toContain('data-test-pane="p1"');
    expect(html.match(/value="" selected=""/g)).toHaveLength(2);
    expect(html).not.toContain('value="team" selected=""');
    expect(html.indexOf('data-test-pane="p1"')).toBeLessThan(html.indexOf('class="team-folder-header"'));
  });
  it("restores collapsed teams without dropping pane markup and escapes folder labels", () => {
    const state = assignTeamPane(addTeamFolder(emptyTeamFolders(), "team", "<script>bad</script>", null), "t1", "team");
    const html = render({ ...state, folders: state.folders.map(f => ({ ...f, collapsed: true })) });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hidden=""');
    expect(html).toContain('data-test-pane="p1"');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
