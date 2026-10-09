import { afterEach, describe, expect, it } from "bun:test";

import { fetchPaneConversation } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("conversation polling", () => {
  it("asks with the last ETag and reuses the very same answer on a 304", async () => {
    const sent: (string | null)[] = [];
    let version = "\"v1\"";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const asked = new Headers(init?.headers).get("if-none-match");
      sent.push(asked);
      if (asked === version) return new Response(null, { status: 304, headers: { etag: version } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null, v: version }), { status: 200, headers: { etag: version } });
    }) as typeof fetch;
    const first = await fetchPaneConversation("w1:p1");
    const again = await fetchPaneConversation("w1:p1");
    expect(again).toBe(first);
    version = "\"v2\"";
    const changed = await fetchPaneConversation("w1:p1");
    expect(changed).not.toBe(first);
    expect((changed as unknown as { v: string }).v).toBe("\"v2\"");
    // an older page is asked for once: it never sends or keeps an ETag
    await fetchPaneConversation("w1:p1", "local", { before: "c:10" });
    await fetchPaneConversation("w1:p1", "local", { before: "c:10" });
    expect(sent).toEqual([null, "\"v1\"", "\"v1\"", null, null]);
  });

  it("keeps the polled answer however many older pages are read", async () => {
    const sent: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const asked = new Headers(init?.headers).get("if-none-match");
      sent.push(asked);
      if (asked === "\"v\"") return new Response(null, { status: 304, headers: { etag: "\"v\"" } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"v\"" } });
    }) as typeof fetch;
    const polled = await fetchPaneConversation("w9:p1");
    for (let page = 0; page < 40; page++) await fetchPaneConversation("w9:p1", "local", { before: `c:${page}` });
    // other panes polled in between: the one polled again stays the most recent
    for (let pane = 0; pane < 20; pane++) {
      await fetchPaneConversation(`w8:p${pane}`);
      expect(await fetchPaneConversation("w9:p1")).toBe(polled);
    }
    expect(sent.at(-1)).toBe("\"v\"");
  });
});
