import { describe, expect, it } from "bun:test";
import { DEVICE_COOKIE, TOKEN_COOKIE } from "./auth.ts";
import { sameOrigin } from "./machine-security.ts";

describe("sameOrigin with no Origin", () => {
  const session = { cookie: `${TOKEN_COOKIE}=abc; ${DEVICE_COOKIE}=def` };
  const post = (path: string, headers: Record<string, string>, method = "POST") => sameOrigin(new Request(`http://host${path}`, { method, headers }));

  it("lets a CLI client without cookies through, so it can use the custom mutation header", () => {
    expect(post("/api/pane/close", { "x-herdr-machine": "1" })).toBe(true);
    expect(post("/api/pane/close", {})).toBe(true);
  });

  it("reads a session cookie with no Origin on a mutation as cross-site", () => {
    expect(post("/api/pane/close", session)).toBe(false);
    expect(post("/api/workspace/create", session)).toBe(false);
    expect(post("/api/machines/local/workspace/create", session)).toBe(false);
    // either cookie alone marks it session-bearing
    expect(post("/api/pane/close", { cookie: `${DEVICE_COOKIE}=def` })).toBe(false);
    expect(post("/api/pane/close", { cookie: `${TOKEN_COOKIE}=abc` })).toBe(false);
    // the exemption is the path, not the method: a neighbouring mutation is refused
    expect(post("/api/push/test", session)).toBe(false);
  });

  it("admits the custom mutation headers and the sender's own session paths", () => {
    expect(post("/api/pane/close", { ...session, "x-herdr-machine": "1" })).toBe(true);
    expect(post("/api/updates/check", { ...session, "x-herdr-update": "1" })).toBe(true);
    expect(post("/api/auth", session, "DELETE")).toBe(true);
    expect(post("/api/push/subscribe", session)).toBe(true);
  });

  it("lets a read through, which a browser sends without Origin", () => {
    const page = { ...session, "sec-fetch-site": "same-origin" };
    expect(post("/ws", session, "GET")).toBe(true);
    expect(post("/api/machines/events", page, "GET")).toBe(true);
    expect(post("/api/machines/local/session", page, "HEAD")).toBe(true);
    expect(post("/api/machines/local/workspace/create", page)).toBe(false);
  });
});
