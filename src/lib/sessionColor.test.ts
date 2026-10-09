import { expect, test } from "bun:test";
import { sessionColorKey, readSessionColor, writeSessionColor, isSessionColor, type ColorStorage } from "./sessionColor.ts";
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
