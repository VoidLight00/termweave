import { describe, expect, it } from "bun:test";
import type { ProviderUsage, UsageWindow } from "../../shared/protocol.ts";
import { formatPercent, formatResetAt, formatResetIn, formatResetShort, leftLevel, meterPercent, meterText, moveInOrder, orderProviders, tightestWindow, usageName, windowLabel } from "./usage.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const window = (used_percent: number, kind: UsageWindow["kind"] = "week", scope: string | null = null): UsageWindow => ({ kind, scope, used_percent, resets_at: null });
const provider = (id: ProviderUsage["id"], windows: UsageWindow[], account: string | null = null): ProviderUsage => ({
  id, key: account ? `${id}:${account}` : id, account, plan: null, windows, problem: null, checked_at: null,
});

describe("usage meters", () => {
  it("shows the limit closest to running out", () => {
    expect(tightestWindow(provider("codex", [window(12, "session"), window(77)]))).toEqual(window(77));
    expect(tightestWindow(provider("claude", []))).toBeNull();
  });

  it("puts the provider nearest a limit first, and one without numbers last", () => {
    const order = orderProviders([provider("claude", []), provider("codex", [window(40)]), provider("copilot", [window(90, "month")])]);
    expect(order.map((usage) => usage.id)).toEqual(["copilot", "codex", "claude"]);
  });

  it("follows the user's order first, then the nearest limit", () => {
    const providers = [provider("claude", [window(10)]), provider("codex", [window(40)], "a@x"), provider("codex", [window(90)], "b@x"), provider("grok", [window(50)])];
    const keys = (order: string[]) => orderProviders(providers, order).map((usage) => usage.key);
    expect(keys([])).toEqual(["codex:b@x", "grok", "codex:a@x", "claude"]);
    expect(keys(["claude", "codex:a@x", "gone"])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
  });

  it("moves an account one place and keeps accounts not reported now", () => {
    expect(moveInOrder(["a", "b", "c"], ["x", "b"], "c", -1)).toEqual(["a", "c", "b", "x"]);
    expect(moveInOrder(["a", "b", "c"], [], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b"], [], "a", 1)).toEqual(["b", "a"]);
  });

  it("counts a meter as used or left, and names the account", () => {
    expect(meterPercent(window(77.4), "used")).toBe(77.4);
    expect(meterPercent(window(77.4), "left")).toBe(22.6);
    expect(meterText(window(77), "used")).toBe("77%");
    expect(meterText(window(77), "left")).toBe("23% left");
    expect(usageName(provider("codex", [], "me@example.com"))).toBe("Codex · me@example.com");
    expect(usageName(provider("grok", []))).toBe("Grok");
  });

  it("formats the time to a reset, and nothing for a past or unknown one", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(formatResetIn(at(12 * 60_000), NOW)).toBe("12m");
    expect(formatResetIn(at(3 * 3600_000 + 5 * 60_000), NOW)).toBe("3h 5m");
    expect(formatResetIn(at(23 * 3600_000 + 59 * 60_000), NOW)).toBe("23h 59m");
    expect(formatResetIn(at(50 * 3600_000), NOW)).toBe("2d 2h");
    expect(formatResetIn(at(-1000), NOW)).toBeNull();
    expect(formatResetIn(null, NOW)).toBeNull();
  });

  it("keeps a sliver above zero visible and rounds the rest", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.4)).toBe("0.4%");
    expect(formatPercent(2.2)).toBe("2%");
    expect(formatPercent(99.6)).toBe("100%");
  });

  it("names a window by its span and its scope", () => {
    expect(windowLabel(window(1, "session"))).toBe("Session");
    expect(windowLabel(window(1, "week", "Sonnet"))).toBe("Weekly · Sonnet");
    expect(windowLabel(window(1, "month", "Premium"))).toBe("Monthly · Premium");
    expect(windowLabel(window(1, "month", "Cursor models"))).toBe("Monthly · Cursor models");
  });
});

describe("the top panel's reset and colour", () => {
  const at = (iso: string) => Date.parse(iso);
  it("says the time left in the same short units in every language", () => {
    const now = at("2026-10-03T10:00:00Z");
    expect(formatResetShort("2026-10-04T13:00:00Z", now)).toBe("1d 3h");
    expect(formatResetShort("2026-10-03T13:12:00Z", now)).toBe("3h 12m");
    expect(formatResetShort("2026-10-03T10:12:00Z", now)).toBe("12m");
    expect(formatResetShort("2026-10-03T09:00:00Z", now)).toBeNull();
  });
  it("names the reset's local time, with the date when it is not today", () => {
    const now = at("2026-10-03T10:00:00");
    expect(formatResetAt("2026-10-03T15:05:00", now)).toBe("15:05");
    expect(formatResetAt("2026-10-04T09:00:00", now)).toBe("10/4 09:00");
    expect(formatResetAt(null, now)).toBeNull();
  });
  it("colours by what is left", () => {
    const window = (used: number) => ({ used_percent: used }) as Parameters<typeof leftLevel>[0];
    expect(leftLevel(window(10))).toBe("ok");
    expect(leftLevel(window(50))).toBe("ok");
    expect(leftLevel(window(51))).toBe("mid");
    expect(leftLevel(window(80))).toBe("mid");
    expect(leftLevel(window(81))).toBe("low");
  });
});
