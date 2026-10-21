import { expect, test } from "bun:test";
import { sessionColorKey, readSessionColor, writeSessionColor, isSessionColor, normalizeHex, resolveSessionColor, readableTextOn, readRecentColors, rememberRecentColor, type ColorStorage } from "./sessionColor.ts";
const memory = (): ColorStorage => {
  let state: Record<string, string> = {};
  return { getItem: key => state[key] ?? null, setItem: (key, value) => { state = { ...state, [key]: value }; }, removeItem: key => { state = Object.fromEntries(Object.entries(state).filter(([candidate]) => candidate !== key)); } };
};
test("color namespaces isolate origin and same workspace IDs on separate machines", () => {
  const local = sessionColorKey("https://one", "local", "w1");
  expect(local).not.toBe(sessionColorKey("https://one", "remote", "w1"));
  expect(local).not.toBe(sessionColorKey("https://two", "local", "w1"));
  expect(sessionColorKey("a", "b:c", "d")).not.toBe(sessionColorKey("a", "b", "c:d"));
});
test("select persists and reset removes only its own key", () => {
  const store = memory(); expect(writeSessionColor(store, "one", "blue")).toBe(true);
  expect(writeSessionColor(store, "two", "rose")).toBe(true);
  expect(readSessionColor(store, "one")).toBe("blue");
  expect(writeSessionColor(store, "one", null)).toBe(true);
  expect(readSessionColor(store, "one")).toBeNull(); expect(readSessionColor(store, "two")).toBe("rose");
});
test("malformed and blocked storage fail safely without rendering raw colors", () => {
  const store = memory(); store.setItem("one", "url(javascript:bad)"); expect(readSessionColor(store, "one")).toBeNull();
  const blocked: ColorStorage = { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } };
  expect(readSessionColor(blocked, "one")).toBeNull(); expect(writeSessionColor(blocked, "one", "blue")).toBe(false);
  expect(writeSessionColor(null, "one", null)).toBe(false); expect(isSessionColor("red")).toBe(false);
});
test("custom hex is accepted, normalized to lowercase 6 digits, and resolved", () => {
  const store = memory();
  expect(writeSessionColor(store, "one", "#FF7A00" as never)).toBe(true);
  expect(store.getItem("one")).toBe("#ff7a00"); expect(readSessionColor(store, "one")).toBe("#ff7a00");
  expect(normalizeHex("ABC")).toBe("#aabbcc"); expect(isSessionColor("#ff7a00")).toBe(true);
  store.setItem("two", "#F0A"); expect(readSessionColor(store, "two")).toBe("#ff00aa");
  expect(resolveSessionColor("#ff7a00")).toBe("#ff7a00"); expect(resolveSessionColor("blue")).toBe("#5688c7"); expect(resolveSessionColor(null)).toBeUndefined();
});
test("invalid hex is rejected and old preset ids stay valid", () => {
  const store = memory();
  for (const bad of ["#12345", "#gggggg", "ff7a00;x", "#ff7a0000", "", "rgb(1,2,3)"]) { expect(normalizeHex(bad)).toBeNull(); expect(writeSessionColor(store, "x", bad as never)).toBe(false); }
  expect(isSessionColor("#FF7A00")).toBe(false);
  for (const id of ["blue", "green", "amber", "rose", "violet", "cyan"]) { store.setItem(id, id); expect(readSessionColor(store, id)).toBe(id as never); }
});
test("text contrast and recent colors", () => {
  expect(readableTextOn("#ffff00")).toBe("#111111"); expect(readableTextOn("#1a1a40")).toBe("#ffffff");
  const store = memory();
  for (const c of ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777", "#222222"]) rememberRecentColor(store, c);
  expect(readRecentColors(store)).toEqual(["#222222", "#777777", "#666666", "#555555", "#444444", "#333333"]);
});
