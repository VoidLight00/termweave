import { expect, it } from "bun:test";
import { ComposerDraftStore } from "./composerDraft.ts";
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, store: new ComposerDraftStore(() => storage) };
}
it("settles an unmounted pane's draft and pending send without changing another owner", () => {
  const { store, data } = fixture();
  store.set("local:a", "sent"); store.begin("local:a");
  store.set("remote:a", "other PC");
  expect(store.begin("local:a")).toBe(false);
  store.settle("local:a", "sent"); store.end("local:a");
  expect(store.read("local:a")).toEqual({ text: "", sending: false });
  expect(data.has("local:a")).toBe(false);
  expect(store.read("remote:a").text).toBe("other PC");
});
it("preserves appended text, internal edits and newer edits from another tab", () => {
  const { store, data } = fixture();
  store.set("a", "sent plus next");
  expect(store.settle("a", "sent")).toEqual({ text: " plus next", edited: false });
  store.set("a", "edited sent");
  expect(store.settle("a", "sent")).toEqual({ text: "edited sent", edited: true });
  data.set("a", "another tab's draft");
  expect(store.settle("a", "sent").text).toBe("another tab's draft");
});
it("notifies a remounted composer and keeps a failed send's draft", () => {
  const { store } = fixture();
  store.set("a", "sent"); store.begin("a");
  let updates = 0;
  const off = store.subscribe(() => { updates++; });
  store.end("a");
  expect(store.read("a").text).toBe("sent");
  store.settle("a", "sent");
  expect(updates).toBe(2);
  off();
});
it("retains unsaved edits when browser storage is unavailable", () => {
  const store = new ComposerDraftStore(() => { throw new Error("blocked"); });
  store.set("a", "sent then next");
  expect(store.settle("a", "sent").text).toBe(" then next");
});
it("keeps a draft cleared and retyped while its send was on its way", () => {
  const { store } = fixture();
  store.set("a", "a"); store.begin("a", "a");
  store.set("a", ""); store.set("a", "ab");
  expect(store.settle("a", "a")).toEqual({ text: "ab", edited: true });
  store.end("a");
  // a plain append during the next send still loses only the sent prefix
  store.set("a", "x"); store.begin("a", "x");
  store.set("a", "xy");
  expect(store.settle("a", "x")).toEqual({ text: "y", edited: false });
  store.end("a");
});
it("keeps a draft another tab cleared and retyped while this tab's send was on its way", () => {
  const { store, data } = fixture();
  store.set("a", "sent"); store.begin("a", "sent");
  data.delete("a"); store.refresh("a");
  data.set("a", "sent again"); store.refresh("a");
  expect(store.settle("a", "sent")).toEqual({ text: "sent again", edited: true });
  store.end("a");
});
