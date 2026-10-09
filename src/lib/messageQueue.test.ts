import { expect, it } from "bun:test";
import { MessageQueueStore } from "./messageQueue.ts";

function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, storage, queue: new MessageQueueStore(() => storage) };
}

it("persists multiple independent items, including identical text, and individual edits", () => {
  const { queue, storage, data } = fixture();
  queue.add("local:a", "same"); queue.add("local:a", "same");
  const [first, second] = queue.read("local:a");
  expect(first!.id).not.toBe(second!.id);
  queue.edit("local:a", second!.id, "edited");
  expect(new MessageQueueStore(() => storage).read("local:a").map(m => m.text)).toEqual(["same", "edited"]);
  queue.remove("local:a", first!.id);
  expect(queue.read("local:a").map(m => m.text)).toEqual(["edited"]);
  queue.remove("local:a", second!.id);
  expect(data.has("termweave:queue:local:a")).toBe(false);
});

it("an old acknowledgement removes only its captured item and owner", () => {
  const { queue } = fixture();
  queue.add("local:a", "in flight");
  const sent = queue.read("local:a")[0]!;
  queue.add("local:a", "newly queued"); queue.add("remote:a", "other PC"); queue.add("local:b", "other pane");
  queue.remove("local:a", sent.id);
  expect(queue.read("local:a").map(m => m.text)).toEqual(["newly queued"]);
  expect(queue.read("remote:a")[0]!.text).toBe("other PC");
  expect(queue.read("local:b")[0]!.text).toBe("other pane");
});

it("migrates the previous plain-text queue without losing JSON-like messages", () => {
  for (const text of ["legacy", '{"message":"legacy"}']) {
    const { queue, data, storage } = fixture();
    data.set("termweave:queue:a", text);
    expect(queue.read("a")[0]!.text).toBe(text);
    queue.add("a", "next");
    expect(new MessageQueueStore(() => storage).read("a").map(m => m.text)).toEqual([text, "next"]);
  }
});

it("keeps messages in memory when storage is unavailable", () => {
  const queue = new MessageQueueStore(() => { throw new Error("denied"); });
  queue.add("a", "first"); queue.add("a", "second");
  expect(queue.read("a").map(m => m.text)).toEqual(["first", "second"]);
});

it("shares pending sends and notifies a remounted view on acknowledgement", () => {
  const { queue } = fixture();
  queue.add("a", "first");
  const sent = queue.read("a")[0]!;
  expect(queue.beginSend("a", sent.id)).toBe(true);
  expect(queue.beginSend("a", sent.id)).toBe(false);
  let notices = 0;
  const unsubscribe = queue.subscribe(() => { notices++; });
  queue.add("a", "second");
  queue.remove("a", sent.id);
  queue.endSend("a", sent.id);
  expect(queue.isSending(sent.id)).toBe(false);
  expect(queue.read("a").map(m => m.text)).toEqual(["second"]);
  expect(notices).toBe(3);
  unsubscribe();
  queue.add("a", "third");
  expect(notices).toBe(3);
});

it("reads another tab's latest additions before edits or late acknowledgements", () => {
  const { queue, storage } = fixture();
  const other = new MessageQueueStore(() => storage);
  queue.add("a", "first");
  const first = other.read("a")[0]!;
  queue.add("a", "second");
  other.add("a", "third");
  queue.remove("a", first.id);
  other.refresh("a");
  expect(other.read("a").map(m => m.text)).toEqual(["second", "third"]);
});

it("reports failed persistence without throwing away the in-memory queue", () => {
  const queue = new MessageQueueStore(() => { throw new Error("quota"); });
  queue.add("a", "keep me");
  expect(queue.isUnsaved("a")).toBe(true);
  queue.refresh("a");
  expect(queue.read("a")[0]!.text).toBe("keep me");
});
