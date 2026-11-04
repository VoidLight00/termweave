import { expect, test } from "bun:test";
import { TmuxClient } from "./client.ts";
// every case is refused before tmux would run, so no tmux binary is needed (a runner may have none)
const binary = "tmux-is-never-spawned";
const client = new TmuxClient({ binary, approvedSockets: ["/nonexistent/tmux.sock"] });
const invalid = { socket: "/nonexistent/tmux.sock", generation: "a".repeat(64), paneId: "%1" };

test("rejects controls, multiline, empty and oversized literal input before connecting", async () => {
  for (const text of ["", "a\nb", "a\rb", "\x1b[2J", "\x00", "\x7f", "\x85", " ", "x".repeat(8193)])
    await expect(client.send(invalid, text)).rejects.toThrow("invalid_literal_text");
});
test("rejects malformed, relative, incomplete and stale-address-shaped targets", async () => {
  for (const paneId of ["1", "pane 1", "%1;kill-server", "%", "%-1"])
    await expect(client.read({ ...invalid, paneId })).rejects.toThrow("invalid_target");
  await expect(client.read({ ...invalid, generation: "" })).rejects.toThrow("invalid_target");
  await expect(client.list("relative.sock")).rejects.toThrow("invalid_socket");
  await expect(client.list(invalid.socket)).rejects.toThrow("missing_socket");
  await expect(new TmuxClient({ binary }).list(invalid.socket)).rejects.toThrow("socket_not_approved");
  await expect(client.read(invalid, 0)).rejects.toThrow("invalid_lines");
});
