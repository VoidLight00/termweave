import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JA } from "./i18n.ja.ts";
import { KO } from "./i18n.ko.ts";
import { ZH } from "./i18n.zh.ts";
import { resolveLanguage, translate } from "./i18n.ts";

const root = join(import.meta.dir, "..");

/**
 * Every string literal in the first argument of a `t(…)` / `tt(…)` call in the client, ternaries
 * included (`t(open ? "Hide" : "Show")`). A key built any other way is not allowed: label maps
 * are listed below instead.
 */
function keysInCode(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) {
    if (file.endsWith(".test.ts") || /i18n\.\w+\.ts$/.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(/(?<![\w.])(?:t|tt)\(/g)) {
      const firstArg = firstArgument(text, match.index + match[0].length);
      for (const literal of firstArg.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        // a literal a condition compares against (`kind === "here" ? …`) is not shown to anyone
        if (/[=!]==?\s*$/.test(firstArg.slice(0, literal.index))) continue;
        const key = literal[1]!.replace(/\\"/g, '"').replace(/\\'/g, "'");
        found.set(key, [...(found.get(key) ?? []), file]);
      }
    }
  }
  return found;
}

/** The text of a call's first argument: up to the first comma or the closing paren at depth zero, strings and nesting respected. */
function firstArgument(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) return text.slice(from, i); depth -= 1; }
    else if (ch === "," && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

/** Label maps the UI translates at the display site (`t(MAP[x])`): their values are keys too. */
function labelMapKeys(): string[] {
  const grab = (file: string, name: string, valuePattern: RegExp): string[] => {
    const text = readFileSync(join(root, file), "utf8");
    const start = text.indexOf(`const ${name}`);
    if (start < 0) throw new Error(`${name} not found in ${file}`);
    const end = text.indexOf("\n};", start) > 0 && (text.indexOf("\n];", start) < 0 || text.indexOf("\n};", start) < text.indexOf("\n];", start)) ? text.indexOf("\n};", start) : text.indexOf("\n];", start);
    return [...text.slice(start, end).matchAll(valuePattern)].flatMap((m) => m.slice(1).filter((v): v is string => v !== undefined));
  };
  const value = /^\s+\w+: "([^"]*)",?$/gm;
  return [
    ...grab("lib/status.ts", "STATUS_WORD", value),
    ...grab("lib/sessionColor.ts", "SESSION_COLORS", /name: "([^"]+)"/g),
    ...grab("components/MachineSidebar.tsx", "STATE_WORD", value),
    ...grab("components/Composer.tsx", "SOURCE_LABEL", value),
    ...grab("components/DevicesPanel.tsx", "VIA", value),
    ...grab("components/KeyBar.tsx", "ARROWS", /label: "([^"]+)"/g),
    ...grab("lib/shortcuts.ts", "SHORTCUTS", /label: "([^"]+)"/g),
    ...grab("lib/bridgeProgress.ts", "STAGES", /label: "([^"]+)"/g),
    ...grab("lib/workBlocks.ts", "CATEGORY_LABEL", /\["([^"]+)", "([^"]+)"\]/g),
    ...grab("lib/usage.ts", "WINDOW_LABEL", value),
  ];
}

const DICTIONARIES = { Korean: KO, Japanese: JA, Chinese: ZH };

describe.each(Object.entries(DICTIONARIES))("%s dictionary", (_name, dictionary) => {
  const inCode = keysInCode();
  const keys = new Set([...inCode.keys(), ...labelMapKeys()]);

  it("has every string the code asks for", () => {
    const missing = [...keys].filter((key) => !(key in dictionary)).sort();
    expect(missing).toEqual([]);
  });

  it("keeps no entry the code no longer uses", () => {
    const stale = Object.keys(dictionary).filter((key) => !keys.has(key)).sort();
    expect(stale).toEqual([]);
  });

  it("keeps every placeholder of the English in the translation", () => {
    const broken = Object.entries(dictionary).filter(([en, text]) => {
      const want = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const have = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      return want.join() !== have.join();
    }).map(([en]) => en);
    expect(broken).toEqual([]);
  });

  it("is not just the English repeated", () => {
    // names and key caps read the same in every language; Chinese UIs leave "Shell" and "Agent" in English
    const sameOnPurpose = new Set(["PC {name}", "Control C", "Shell", "Agent"]);
    const same = Object.entries(dictionary).filter(([en, text]) => en === text && /[a-z]{3}/i.test(en) && !sameOnPurpose.has(en));
    expect(same.map(([en]) => en)).toEqual([]);
  });
});

describe("translate", () => {
  it("fills placeholders, falls back to English, and leaves unknown placeholders alone", () => {
    expect(translate("en", "Worked for {duration}", { duration: "7s" })).toBe("Worked for 7s");
    expect(translate("ko", "Worked for {duration}", { duration: "7초" })).toBe(KO["Worked for {duration}"]!.replace("{duration}", "7초"));
    expect(translate("ko", "not a key", { x: 1 })).toBe("not a key");
    expect(translate("ja", "Settings")).toBe(JA["Settings"]!);
    expect(translate("zh", "Settings")).toBe(ZH["Settings"]!);
    expect(translate("en", "{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });

  it("follows the browser only when asked to", () => {
    expect(resolveLanguage("system", ["ko-KR", "en-US"])).toBe("ko");
    expect(resolveLanguage("system", ["en-US", "ko"])).toBe("ko");
    expect(resolveLanguage("system", ["en-US"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
    expect(resolveLanguage("en", ["ko-KR"])).toBe("en");
    expect(resolveLanguage("ko", ["en-US"])).toBe("ko");
    expect(resolveLanguage("system", ["ja-JP"])).toBe("ja");
    expect(resolveLanguage("system", ["en-US", "zh-CN", "ko"])).toBe("zh");
    expect(resolveLanguage("system", ["zh-TW"])).toBe("zh");
    expect(resolveLanguage("ja", ["zh-CN"])).toBe("ja");
  });
});
