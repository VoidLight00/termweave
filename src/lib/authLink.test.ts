import { describe, expect, it } from "bun:test";

import { authTokenFromHash } from "./authLink.ts";

describe("authTokenFromHash", () => {
  it("reads the token from an auth link fragment", () => {
    expect(authTokenFromHash("#auth=herdr-local-7317")).toBe("herdr-local-7317");
  });

  it("decodes percent-escaped tokens", () => {
    expect(authTokenFromHash("#auth=se%20cret%2Fx")).toBe("se cret/x");
  });

  it("ignores every other shape of fragment", () => {
    expect(authTokenFromHash("")).toBeNull();
    expect(authTokenFromHash("#")).toBeNull();
    expect(authTokenFromHash("#pane=wS1:p1")).toBeNull();
    expect(authTokenFromHash("#auth=")).toBeNull(); // empty link: nothing to offer
    expect(authTokenFromHash("#auth=a&t=other")).toBe("a&t=other"); // token chars, not params
  });

  it("returns null on a truncated percent-escape instead of throwing", () => {
    expect(authTokenFromHash("#auth=bad%2")).toBeNull();
  });
});
