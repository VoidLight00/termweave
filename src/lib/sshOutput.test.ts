import { describe, expect, it } from "bun:test";
import { sshOutputParts } from "./sshOutput.ts";

describe("sshOutputParts", () => {
  it("links the Tailscale SSH check address and keeps the words around it", () => {
    expect(sshOutputParts("# Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/abc123.")).toEqual([
      { type: "text", value: "# Tailscale SSH requires an additional check.\n# To authenticate, visit: " },
      { type: "link", href: "https://login.tailscale.com/a/abc123", value: "https://login.tailscale.com/a/abc123" },
      { type: "text", value: "." },
    ]);
  });

  it("links only https addresses", () => {
    for (const text of ["javascript:alert(1)", "http://example.com/x", "visit example.com/a", "data:text/html,https", "ftp://host/https://", "ftp://host/https://example.com", "x=https://example.com", "http://a/?next=https://example.com"]) {
      expect(sshOutputParts(text).some((part) => part.type === "link")).toBe(false);
    }
    expect(sshOutputParts("javascript:alert(1)")).toEqual([{ type: "text", value: "javascript:alert(1)" }]);
  });

  it("links every address and leaves a bare scheme as text", () => {
    const parts = sshOutputParts("https://a.example/x and (https://b.example/y) then https://");
    expect(parts.filter((part) => part.type === "link").map((part) => part.value)).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(parts.map((part) => part.value).join("")).toBe("https://a.example/x and (https://b.example/y) then https://");
  });

  it("returns nothing for empty output", () => {
    expect(sshOutputParts("")).toEqual([]);
  });
});
