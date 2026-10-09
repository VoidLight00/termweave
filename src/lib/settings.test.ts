import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FONT_FAMILY_MAX_CHARS } from "./fontFamily.ts";
import { alertPrefs, CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, DEFAULT_SETTINGS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, quickReplyButtons, sanitizeSettings, terminalTheme, forgetPaneViews } from "./settings.ts";

it("keeps the screen wake lock off until this device explicitly enables it", () => {
  expect(DEFAULT_SETTINGS.keepScreenOn).toBe(false);
  expect(sanitizeSettings({}).keepScreenOn).toBe(false);
  expect(sanitizeSettings({ keepScreenOn: true }).keepScreenOn).toBe(true);
  expect(sanitizeSettings({ keepScreenOn: "true" }).keepScreenOn).toBe(false);
  // the terminal's wheel speed: one report per wheel event unless chosen, whole and bounded
  expect(sanitizeSettings({}).terminalWheelSpeed).toBe(1);
  expect(sanitizeSettings({ terminalWheelSpeed: 3 }).terminalWheelSpeed).toBe(3);
  expect(sanitizeSettings({ terminalWheelSpeed: 2.6 }).terminalWheelSpeed).toBe(3);
  expect(sanitizeSettings({ terminalWheelSpeed: 99 }).terminalWheelSpeed).toBe(10);
  expect(sanitizeSettings({ terminalWheelSpeed: 0 }).terminalWheelSpeed).toBe(1);
  expect(sanitizeSettings({ terminalWheelSpeed: "3" }).terminalWheelSpeed).toBe(1);
});

it("defaults legacy records to workspace grouping and accepts only supported modes", () => {
  expect(sanitizeSettings({}).sidebarGrouping).toBe("workspace");
  expect(sanitizeSettings({ sidebarGrouping: "workspace" }).sidebarGrouping).toBe("workspace");
  expect(sanitizeSettings({ sidebarGrouping: "directory" }).sidebarGrouping).toBe("directory");
  for (const sidebarGrouping of [null, true, "folder", 1]) {
    expect(sanitizeSettings({ sidebarGrouping }).sidebarGrouping).toBe("workspace");
  }
});

describe("chat font size", () => {
  it("follows the density until one is chosen, and keeps a chosen one within bounds", () => {
    expect(chatFontSize(DEFAULT_SETTINGS)).toBe(14);
    expect(chatFontSize(sanitizeSettings({ density: "compact" }))).toBe(13);
    expect(chatFontSize(sanitizeSettings({ density: "compact", chatFontSize: 17 }))).toBe(17);
    expect(sanitizeSettings({ chatFontSize: 99 }).chatFontSize).toBe(CHAT_FONT_MAX);
    expect(sanitizeSettings({ chatFontSize: 2 }).chatFontSize).toBe(CHAT_FONT_MIN);
    expect(sanitizeSettings({ chatFontSize: 15.6 }).chatFontSize).toBe(16);
    expect(sanitizeSettings({ chatFontSize: "18" }).chatFontSize).toBeNull();
    expect(sanitizeSettings({ terminalFontSize: 15 }).chatFontSize).toBeNull();
  });
});

describe("font families", () => {
  const family = (value: unknown): string => sanitizeSettings({ terminalFontFamily: value }).terminalFontFamily;

  it("keep today's fonts until a list is typed, and ignore anything that is not text", () => {
    expect(DEFAULT_SETTINGS.terminalFontFamily).toBe("");
    expect(DEFAULT_SETTINGS.chatFontFamily).toBe("");
    expect(sanitizeSettings({}).terminalFontFamily).toBe("");
    expect(sanitizeSettings({}).chatFontFamily).toBe("");
    for (const value of [undefined, null, 7, true, ["D2Coding"], { name: "D2Coding" }]) expect(family(value)).toBe("");
    expect(family("")).toBe("");
    expect(family("   ")).toBe("");
    expect(family(" , ,, ")).toBe("");
  });

  it("trim each name, drop empty ones and join them the CSS way", () => {
    expect(family("  D2Coding  ")).toBe("D2Coding");
    expect(family("D2Coding,,  , monospace,")).toBe("D2Coding, monospace");
    expect(family(",D2Coding")).toBe("D2Coding");
  });

  it("quote names with spaces once, and keep quoted names quoted", () => {
    expect(family("Cascadia Mono")).toBe('"Cascadia Mono"');
    expect(family("  Cascadia    Mono  ")).toBe('"Cascadia Mono"');
    expect(family('D2Coding, "Cascadia Mono", monospace')).toBe('D2Coding, "Cascadia Mono", monospace');
    expect(family("'Cascadia Mono'")).toBe('"Cascadia Mono"');
    expect(family('" Cascadia Mono "')).toBe('"Cascadia Mono"');
    // quoted, a generic name is a font by that name: the user's quotes stay
    expect(family('"monospace"')).toBe('"monospace"');
    // a stray or unbalanced quote cannot end the CSS string early
    expect(family('Cascadia"Mono')).toBe("CascadiaMono");
    expect(family('"Cascadia Mono')).toBe('"Cascadia Mono"');
    expect(family('""')).toBe("");
  });

  it("quote what CSS cannot read bare", () => {
    expect(family("3270 Nerd Font")).toBe('"3270 Nerd Font"');
    expect(family("1942report")).toBe('"1942report"');
    expect(family("inherit, D2Coding")).toBe('"inherit", D2Coding');
    expect(family("나눔고딕코딩")).toBe("나눔고딕코딩");
    expect(family("Sarasa-Mono-K")).toBe("Sarasa-Mono-K");
  });

  it("compose a decomposed name, so it matches the installed font", () => {
    const decomposed = "나눔고딕코딩".normalize("NFD");
    expect(decomposed).not.toBe("나눔고딕코딩");
    expect(family(decomposed)).toBe("나눔고딕코딩");
    expect(family(`D2Coding, ${"나눔 고딕".normalize("NFD")}`)).toBe('D2Coding, "나눔 고딕"');
  });

  it("strip what could leave the declaration", () => {
    expect(family("D2Coding; color: red")).toBe('"D2Coding color: red"');
    expect(family("D2Coding} body { color: red")).toBe('"D2Coding body color: red"');
    expect(family("</style><script>x</script>")).toBe('"/stylescriptx/script"');
    expect(family("D2\\Coding")).toBe("D2Coding");
    expect(family("D2\u0000Coding\nMono\t")).toBe("D2CodingMono");
    for (const unsafe of [";", "{", "}", "<", ">", "\\", "\u0000", "\u001f", "\u007f"]) expect(family(`x${unsafe}y`)).toBe("xy");
  });

  it("stay within the length limit, dropping whole names past it", () => {
    const long = Array.from({ length: 40 }, (_, index) => `Font Name ${index}`).join(", ");
    const kept = family(long);
    expect(kept.length).toBeLessThanOrEqual(FONT_FAMILY_MAX_CHARS);
    expect(kept.startsWith('"Font Name 0", "Font Name 1"')).toBe(true);
    // every name that made it is whole: its quotes pair up
    expect(kept.split(", ").every((name) => /^"Font Name \d+"$/.test(name))).toBe(true);
    expect(family("x".repeat(FONT_FAMILY_MAX_CHARS + 1))).toBe("");
    expect(family("x".repeat(FONT_FAMILY_MAX_CHARS))).toBe("x".repeat(FONT_FAMILY_MAX_CHARS));
  });

  it("are the same list after a second pass, so a saved one never drifts", () => {
    for (const typed of ['D2Coding, "Cascadia Mono", monospace', "'Fira Code' ,  Menlo", "inherit, 3270 Nerd Font"]) {
      const once = family(typed);
      expect(family(once)).toBe(once);
    }
  });

  it("sanitize the chat's list the same way, apart from the terminal's", () => {
    const both = sanitizeSettings({ terminalFontFamily: "D2Coding", chatFontFamily: " Pretendard ; , Noto Sans KR" });
    expect(both.terminalFontFamily).toBe("D2Coding");
    expect(both.chatFontFamily).toBe('Pretendard, "Noto Sans KR"');
  });
});

describe("alert choices", () => {
  it("keep alerts on unless this device turned them off with the bell", () => {
    expect(DEFAULT_SETTINGS.alertsOn).toBe(true);
    expect(sanitizeSettings({}).alertsOn).toBe(true);
    expect(sanitizeSettings({ alertsOn: false }).alertsOn).toBe(false);
    expect(sanitizeSettings({ alertsOn: "no" }).alertsOn).toBe(true);
  });

  it("default to questions and long turns, and drop anything unknown to the default", () => {
    expect(alertPrefs(DEFAULT_SETTINGS)).toEqual({ input: true, done: "long" });
    expect(alertPrefs(sanitizeSettings({ alertInput: false, alertDone: "always" }))).toEqual({ input: false, done: "always" });
    expect(alertPrefs(sanitizeSettings({ alertInput: "no", alertDone: "sometimes" }))).toEqual({ input: true, done: "long" });
  });
});

describe("quick replies", () => {
  it("keep replies as typed, bounded, and show only the ones with something to send", () => {
    expect(quickReplyButtons(DEFAULT_SETTINGS)).toEqual(["continue", "yes", "no", "commit and push", "retry"]);
    // a trailing space is the next word being typed: it stays
    const typed = sanitizeSettings({ quickReplies: ["run the ", "", "  ", 7, "ship it"] });
    expect(typed.quickReplies).toEqual(["run the ", "", "  ", "ship it"]);
    expect(quickReplyButtons(typed)).toEqual(["run the ", "ship it"]);
    const many = sanitizeSettings({ quickReplies: Array.from({ length: 20 }, (_, index) => "x".repeat(300) + index) });
    expect(many.quickReplies).toHaveLength(QUICK_REPLIES_MAX);
    expect(many.quickReplies.every((reply) => reply.length === QUICK_REPLY_MAX_CHARS)).toBe(true);
    // an emptied list is a choice, not a broken record
    expect(sanitizeSettings({ quickReplies: [] }).quickReplies).toEqual([]);
    expect(sanitizeSettings({}).quickReplies).toEqual(DEFAULT_SETTINGS.quickReplies);
  });
});

describe("suggestion chip", () => {
  it("stays off until chosen in settings", () => {
    expect(DEFAULT_SETTINGS.showSuggestionChip).toBe(false);
    expect(sanitizeSettings({}).showSuggestionChip).toBe(false);
    expect(sanitizeSettings({ showSuggestionChip: true }).showSuggestionChip).toBe(true);
    expect(sanitizeSettings({ showSuggestionChip: "yes" }).showSuggestionChip).toBe(false);
  });
});

describe("quick replies row", () => {
  it("stays hidden until chosen in settings", () => {
    expect(DEFAULT_SETTINGS.showQuickReplies).toBe(false);
    expect(sanitizeSettings({ showQuickReplies: true }).showQuickReplies).toBe(true);
    expect(sanitizeSettings({ showQuickReplies: "yes" }).showQuickReplies).toBe(false);
    expect(DEFAULT_SETTINGS.showUsage).toBe(false);
    expect(sanitizeSettings({ showUsage: true }).showUsage).toBe(true);
    expect(sanitizeSettings({ showUsage: 1 }).showUsage).toBe(false);
    expect(DEFAULT_SETTINGS.usageCount).toBe("used");
    expect(sanitizeSettings({ usageCount: "left" }).usageCount).toBe("left");
    expect(sanitizeSettings({ usageCount: "half" }).usageCount).toBe("used");
    expect(sanitizeSettings({ usageOrder: ["codex:a", 3, "codex:a", "", "claude:b"] }).usageOrder).toEqual(["codex:a", "claude:b"]);
    expect(sanitizeSettings({ usageHidden: Array.from({ length: 100 }, (_, index) => `k${index}`) }).usageHidden).toHaveLength(64);
    expect(sanitizeSettings({ usageHidden: "codex:a" }).usageHidden).toEqual([]);
  });
});

describe("palette", () => {
  it("defaults to amber, the look before this setting, and keeps only a known palette", () => {
    expect(DEFAULT_SETTINGS.palette).toBe("amber");
    // settings stored before palettes existed carry no palette key
    expect(sanitizeSettings({ theme: "light" }).palette).toBe("amber");
    expect(sanitizeSettings({ palette: "report" }).palette).toBe("report");
    expect(sanitizeSettings({ palette: "charcoal" }).palette).toBe("charcoal");
    expect(sanitizeSettings({ palette: "pink" }).palette).toBe("amber");
  });

  const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
  const block = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  };
  const paper = '[data-theme="light"]:is([data-palette="report"], [data-palette="charcoal"])';
  // each case lists its blocks from the most specific to the base; the first one naming a token wins
  const cases = [
    { theme: "dark", palette: "amber", layers: [":root"] },
    { theme: "light", palette: "amber", layers: ['[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "report", layers: ['[data-theme="dark"][data-palette="report"]', ":root"] },
    { theme: "light", palette: "report", layers: [paper, '[data-theme="light"]', ":root"] },
    { theme: "dark", palette: "charcoal", layers: ['[data-theme="dark"][data-palette="charcoal"]', ":root"] },
    { theme: "light", palette: "charcoal", layers: ['[data-theme="light"][data-palette="charcoal"]', paper, '[data-theme="light"]', ":root"] },
  ] as const;
  const tokens = (layers: readonly string[]) => (name: string): string =>
    layers.map((selector) => block(selector).match(new RegExp(`--${name}: ([^;]+);`))?.[1]).find((value) => value !== undefined)!;

  it("mirrors each palette's --term-* tokens of styles.css for xterm", () => {
    for (const { theme, palette, layers } of cases) {
      const read = tokens(layers);
      expect(terminalTheme(theme, palette)).toEqual({ background: read("term-bg"), foreground: read("term-fg"), cursor: read("term-cursor"), selectionBackground: read("term-selection") });
    }
  });

  it("keeps text and agent states readable (WCAG AA 4.5:1) on every surface of every palette", () => {
    type Rgb = [number, number, number];
    const rgba = (value: string): [Rgb, number] => {
      const hex = value.match(/^#([0-9a-f]{6})$/);
      if (hex) return [[0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb, 1];
      const parts = value.match(/^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/)!;
      return [[Number(parts[1]), Number(parts[2]), Number(parts[3])], Number(parts[4])];
    };
    const over = (top: string, under: Rgb): Rgb => {
      const [rgb, alpha] = rgba(top);
      return rgb.map((c, i) => c * alpha + under[i]! * (1 - alpha)) as Rgb;
    };
    const luminance = (rgb: Rgb): number => {
      const [r, g, b] = rgb.map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)) as Rgb;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: Rgb, b: Rgb): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    const failures: string[] = [];
    for (const { theme, palette, layers } of cases) {
      const read = tokens(layers);
      const color = (name: string): Rgb => rgba(read(name))[0];
      for (const surface of ["bg", "bg-panel", "bg-elevated", "bg-hover"]) {
        for (const text of ["text", "text-dim"]) {
          if (ratio(color(text), color(surface)) < 4.5) failures.push(`${theme}/${palette} ${text} on ${surface}`);
        }
        // a status badge: its color on its tint, over a (hovered or selected) row
        for (const state of ["working", "blocked", "done"]) {
          const backdrop = over(read(`status-${state}-tint`), color(surface));
          if (ratio(color(`status-${state}`), backdrop) < 4.5) failures.push(`${theme}/${palette} ${state} badge on ${surface}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("paints amber before settings load: the base blocks are the default palette's", () => {
    const css = readFileSync(join(import.meta.dir, "..", "styles.css"), "utf8");
    const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    expect(root).toContain(`--term-bg: ${terminalTheme("dark").background};`);
    expect(root).toContain(`--term-cursor: ${terminalTheme("dark").cursor};`);
    expect(terminalTheme("dark")).toEqual(terminalTheme("dark", "amber"));
  });
});

describe("agent marks", () => {
  it("drops the icon choice 0.3.36 stored, so every pane shows its provider logo", () => {
    const settings = sanitizeSettings({ claudeMark: "mascot", codexMark: "app" });
    expect(settings).not.toHaveProperty("claudeMark");
    expect(settings).not.toHaveProperty("codexMark");
  });
});

describe("plan meter placement", () => {
  it("sits beside Settings until the top of the list is chosen", () => {
    expect(DEFAULT_SETTINGS.usagePlacement).toBe("footer");
    expect(sanitizeSettings({ usagePlacement: "top" }).usagePlacement).toBe("top");
    expect(sanitizeSettings({ usagePlacement: "left" }).usagePlacement).toBe("footer");
  });
});

it("sanitizes input modes and shortcut overrides without accepting arbitrary commands", () => {
  expect(sanitizeSettings({ terminalInputMode: "bad" }).terminalInputMode).toBe("auto");
  expect(sanitizeSettings({ terminalInputMode: "line" }).terminalInputMode).toBe("line");
  expect(sanitizeSettings({ shortcutOverrides: { palette: "p", settings: null, voice: "x", unknown: "x", "next-pane": "rm -rf" } }).shortcutOverrides).toEqual({ palette: "p", settings: null });
});

describe("default lens", () => {
  it("keeps explicit choices and defaults legacy auto to terminal", () => {
    expect(DEFAULT_SETTINGS.defaultView).toBe("terminal");
    expect(sanitizeSettings({ defaultView: "chat" }).defaultView).toBe("chat");
    expect(sanitizeSettings({ defaultView: "split" }).defaultView).toBe("terminal");
    expect(sanitizeSettings({ defaultView: "auto" }).defaultView).toBe("terminal");
  });
  it("forgets every pane's own lens and nothing else", () => {
    const data = new Map<string, string>([["termweave:view:local:w1:p1", "terminal"], ["termweave:view:remote:pc:w2:p1", "chat"], ["termweave:settings", "{}"]]);
    const storage = { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, removeItem: (k: string) => { data.delete(k); } };
    expect(forgetPaneViews(storage)).toBe(2);
    expect([...data.keys()]).toEqual(["termweave:settings"]);
  });
});
