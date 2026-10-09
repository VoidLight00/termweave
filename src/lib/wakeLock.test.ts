import { describe, expect, it } from "bun:test";
import { holdScreenWakeLock } from "./wakeLock.ts";

function pendingLock() {
  let resolve!: (lock: WakeLockSentinel) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<WakeLockSentinel>((yes, no) => { resolve = yes; reject = no; });
  const requested: WakeLockType[] = [];
  let releases = 0;
  const sentinel = { release: async () => { releases++; } } as unknown as WakeLockSentinel;
  const stop = holdScreenWakeLock({ request: (type = "screen") => { requested.push(type); return promise; } });
  return { stop, resolve: () => resolve(sentinel), reject, requested, releases: () => releases };
}

describe("screen wake lock", () => {
  it("releases an acquired screen lock when viewing ends", async () => {
    const lock = pendingLock();
    expect(lock.requested).toEqual(["screen"]);
    lock.resolve();
    await Promise.resolve();
    expect(lock.releases()).toBe(0);
    lock.stop();
    lock.stop();
    expect(lock.releases()).toBe(1);
  });

  it("releases a late request after disabling or hiding the pane", async () => {
    const lock = pendingLock();
    lock.stop();
    lock.resolve();
    await Promise.resolve();
    expect(lock.releases()).toBe(1);
  });

  it("a late old request cannot release the replacement lock on return", async () => {
    const old = pendingLock();
    old.stop();
    const current = pendingLock();
    current.resolve();
    old.resolve();
    await Promise.resolve();
    expect(old.releases()).toBe(1);
    expect(current.releases()).toBe(0);
    current.stop();
    expect(current.releases()).toBe(1);
  });

  it("accepts browser refusal without retrying in a loop", async () => {
    const lock = pendingLock();
    lock.reject(new Error("NotAllowedError"));
    await Promise.resolve();
    await Promise.resolve();
    lock.stop();
    expect(lock.requested).toEqual(["screen"]);
    expect(lock.releases()).toBe(0);
  });
});
