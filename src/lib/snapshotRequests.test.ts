import { expect, it } from "bun:test";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { applyPaneStatus } from "./snapshot.ts";
import { SnapshotRequests } from "./snapshotRequests.ts";

function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("keeps a status event when an older machines poll resolves afterwards", async () => {
  const requests = new SnapshotRequests();
  const old = { panes: [{ pane_id: "p1", agent_status: "blocked" }], agents: [] } as unknown as SessionSnapshot;
  let state = old;
  const response = pending<SessionSnapshot>();
  const poll = requests.read(() => response.promise, (next) => { state = next; });
  requests.invalidate();
  state = applyPaneStatus(state, "p1", "working");
  response.resolve(old);
  await poll;
  expect(state.panes[0]!.agent_status).toBe("working");
  // A later poll still catches up normally when the stream is silent.
  await requests.read(async () => applyPaneStatus(state, "p1", "done"), (next) => { state = next; });
  expect(state.panes[0]!.agent_status).toBe("done");
});

it("does not replace an SSE roster or a newer poll with a slow older poll", async () => {
  const requests = new SnapshotRequests();
  let machines = ["local"];
  const old = pending<string[]>();
  const first = requests.read(() => old.promise, (next) => { machines = next; });
  await requests.read(async () => ["local", "remote"], (next) => { machines = next; });
  old.resolve(["local"]);
  await first;
  expect(machines).toEqual(["local", "remote"]);
  const stale = pending<string[]>();
  const poll = requests.read(() => stale.promise, (next) => { machines = next; });
  requests.invalidate();
  machines = ["remote"];
  stale.resolve(["local", "remote"]);
  await poll;
  expect(machines).toEqual(["remote"]);
});

it("ignores superseded request failures but reports current failures", async () => {
  const requests = new SnapshotRequests();
  const stale = pending<string>();
  const poll = requests.read(() => stale.promise, () => { throw new Error("unexpected commit"); });
  requests.invalidate();
  stale.reject(new Error("stale unauthorized"));
  await poll;
  await expect(requests.read(async () => { throw new Error("current failure"); }, () => {})).rejects.toThrow("current failure");
});
