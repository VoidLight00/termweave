import { describe, expect, it } from "bun:test";
import { buildIdFromHtml, FrontendUpdateController, readDeployedBuildId } from "./frontendUpdate.ts";
import { shouldAutoUpdate } from "./frontendUpdate.ts";
import { frontendInputPending, protectFrontendInput } from "./frontendReloadSafety.ts";
const oldId = "a".repeat(64), newId = "b".repeat(64);
function fixture() {
  let deployed: string | null = oldId, reloads = 0, allowed = true;
  let listener: (() => void) | null = null;
  let registration: ServiceWorkerRegistration | undefined;
  const changes: unknown[] = [];
  const controller = new FrontendUpdateController({ currentId: oldId, readDeployedId: async () => deployed,
    registration: async () => registration,
    onControllerChange: next => { listener = next; return () => { listener = null; }; },
    allowReload: () => allowed && !frontendInputPending(), reload: () => { reloads++; },
  }, next => changes.push(next));
  return { controller, changes, get reloads() { return reloads; }, set deployed(value: string | null) { deployed = value; },
    set allowed(value: boolean) { allowed = value; }, set registration(value: ServiceWorkerRegistration | undefined) { registration = value; },
    controllerChange: () => listener?.() };
}
describe("deployed frontend controls", () => {
  it("no update for the current build; immutable identity rejects missing/version-only HTML", async () => {
    const f = fixture(); await f.controller.check(); expect(f.controller.state.available).toBe(false);
    expect(buildIdFromHtml('<meta name="frontend-build-id" content="0.1.0">')).toBeNull();
    expect(buildIdFromHtml(`<meta name="frontend-build-id" content="${oldId}" />`)).toBe(oldId);
  });
  it("newer/different deployed build only offers a button, repeated detection never reloads", async () => {
    const f = fixture(); f.deployed = newId; await f.controller.check(); await f.controller.check();
    expect(f.controller.state.available).toBe(true); expect(f.changes.length).toBe(1); expect(f.reloads).toBe(0);
    f.controller.dispose(); await f.controller.check(); expect(f.reloads).toBe(0);
  });
  it("Update without SW reloads once, while Refresh works without update availability", async () => {
    const f = fixture(); f.deployed = newId; await f.controller.check(); await f.controller.update(); await f.controller.update(); expect(f.reloads).toBe(1);
    const fresh = fixture(); fresh.controller.refresh(); fresh.controller.refresh(); expect(fresh.reloads).toBe(1);
  });
  it("waiting SW activates only on Update and reloads once on controller change", async () => {
    const f = fixture(); let posts = 0;
    f.registration = { waiting: { postMessage: (data: unknown) => { expect(data).toEqual({ type: "SKIP_WAITING" }); posts++; } } } as unknown as ServiceWorkerRegistration;
    f.deployed = newId; await f.controller.check(); expect(posts).toBe(0); await f.controller.update();
    expect(posts).toBe(1); expect(f.reloads).toBe(0); f.controllerChange(); f.controllerChange(); expect(f.reloads).toBe(1);
  });
  it("pending input and declined draft confirmation prevent both navigation paths", async () => {
    const f = fixture(); f.deployed = newId; await f.controller.check();
    let settle!: () => void; const input = protectFrontendInput(() => new Promise<void>(resolve => { settle = resolve; }));
    f.controller.refresh(); await f.controller.update(); expect(f.reloads).toBe(0); settle(); await input;
    f.allowed = false; f.controller.refresh(); await f.controller.update(); expect(f.reloads).toBe(0);
    f.allowed = true; f.controller.refresh(); expect(f.reloads).toBe(1);
  });
  it("failed check clears stale availability and never authorizes a cached offline update", async () => {
    const f = fixture(); f.deployed = newId; await f.controller.check(); f.deployed = null;
    await f.controller.update(); expect(f.reloads).toBe(0); expect(f.controller.state.available).toBe(false);
  });
  it("403, offline, malformed and failed fetch cannot fabricate build identity", async () => {
    const previousFetch = globalThis.fetch, previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
      globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
      expect(await readDeployedBuildId()).toBeNull();
      globalThis.fetch = (async () => new Response("{}", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
      expect(await readDeployedBuildId()).toBeNull();
      globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
      await expect(readDeployedBuildId()).rejects.toThrow("offline");
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
      expect(await readDeployedBuildId()).toBeNull();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator); else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});

it("a deploy is applied by itself only when idle and nothing can be lost", () => {
  const base = { available: true, busy: false, idleMs: 6_000, quiet: true };
  expect(shouldAutoUpdate(base)).toBe(true);
  expect(shouldAutoUpdate({ ...base, available: false })).toBe(false);
  expect(shouldAutoUpdate({ ...base, busy: true })).toBe(false);
  expect(shouldAutoUpdate({ ...base, idleMs: 4_999 })).toBe(false);
  expect(shouldAutoUpdate({ ...base, quiet: false })).toBe(false);
});
