/**
 * UI text in the user's language. The English string is the key: `t("Rename pane")`,
 * `t("Worked for {duration}", { duration })`. A key a dictionary (i18n.ko.ts, i18n.ja.ts,
 * i18n.zh.ts) lacks comes back in English, so a new string is never blank, and
 * src/lib/i18n.test.ts scans the code for every `t("…")` and fails when one is missing from
 * any dictionary.
 *
 * Components take `t` from `useT()`, whose identity changes with the language so memoized
 * work is redone. Helpers outside React (status labels, shortcut labels, work summaries)
 * call the module-level `t`, which reads the language the SettingsProvider last set.
 */
import { useMemo } from "react";
import { JA } from "./i18n.ja.ts";
import { KO } from "./i18n.ko.ts";
import { ZH } from "./i18n.zh.ts";
import { useSettings } from "./settings.ts";

export const LANGUAGE_SETTINGS = ["system", "en", "ko", "ja", "zh"] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];
export type Language = Exclude<LanguageSetting, "system">;

export const LANGUAGE_NAMES: Record<LanguageSetting, string> = { system: "System", en: "English", ko: "한국어", ja: "日本語", zh: "简体中文" };

/** The BCP 47 tag for `<html lang>` and Intl formatting. */
export const LOCALE_TAGS: Record<Language, string> = { en: "en-US", ko: "ko-KR", ja: "ja-JP", zh: "zh-CN" };

const DICTIONARIES: Record<Language, Record<string, string>> = { en: {}, ko: KO, ja: JA, zh: ZH };

/**
 * `system` follows the browser: the first tag in its list for a translated language picks it
 * (`["en-US", "ko"]` is Korean), otherwise English. Any Chinese tag, zh-TW included, picks
 * Simplified Chinese, the only Chinese there is.
 */
export function resolveLanguage(setting: LanguageSetting, languages: readonly string[] = typeof navigator !== "undefined" ? navigator.languages : []): Language {
  if (setting !== "system") return setting;
  for (const tag of languages) {
    const match = /^(ko|ja|zh)\b/i.exec(tag);
    if (match) return match[1]!.toLowerCase() as Language;
  }
  return "en";
}

let current: Language = "en";

export function setCurrentLanguage(language: Language): void {
  current = language;
}

export function currentLanguage(): Language {
  return current;
}

/** The BCP 47 tag of the language the SettingsProvider last set, for Intl outside React. */
export function currentLocale(): string {
  return LOCALE_TAGS[current];
}

export type Vars = Record<string, string | number>;

/** The text for `key` in `language`, placeholders filled; pure, for tests and for both `t`s. */
export function translate(language: Language, key: string, vars?: Vars): string {
  const text = DICTIONARIES[language][key] ?? key;
  return vars === undefined ? text : text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export function t(key: string, vars?: Vars): string {
  return translate(current, key, vars);
}

export type Translate = (key: string, vars?: Vars) => string;

/** `t` bound to the current language, a new function whenever the language changes. */
export function useT(): Translate {
  const { resolvedLanguage } = useSettings();
  return useMemo<Translate>(() => (key, vars) => translate(resolvedLanguage, key, vars), [resolvedLanguage]);
}

/** The BCP 47 tag for Intl formatting in the current language. */
export function useLocale(): string {
  const { resolvedLanguage } = useSettings();
  return LOCALE_TAGS[resolvedLanguage];
}
