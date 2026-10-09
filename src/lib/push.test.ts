import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ensurePushSubscription, removePushSubscription, testDevicePush } from "./push.ts";
import { ApiError } from "./api.ts";

/**
 * The device-side subscription flow against a stand-in browser whose PushManager, like
 * real Chrome (observed through FCM in .omo/evidence/push-qa/real-fcm.ts), issues a NEW
 * subscription on every subscribe() call and keeps only the latest one.
 */

const SERVER_KEY = Buffer.from(new Uint8Array(65).fill(4)).toString("base64url");
const OTHER_KEY = new Uint8Array(65).fill(7).buffer;

interface StandInSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer };
  unsubscribed: boolean;
  unsubscribe(): Promise<boolean>;
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
}

let live: StandInSubscription | null;
let issued: number;
let registered: string[];
const saved = {
  fetch: globalThis.fetch,
  PushManager: (globalThis as { PushManager?: unknown }).PushManager,
  Notification: (globalThis as { Notification?: unknown }).Notification,
};

function standIn(endpoint: string, key: ArrayBuffer): StandInSubscription {
  return {
    endpoint,
    options: { applicationServerKey: key },
    unsubscribed: false,
    async unsubscribe() {
      this.unsubscribed = true;
      if (live === this) live = null;
      return true;
    },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  };
}

beforeEach(() => {
  live = null;
  issued = 0;
  registered = [];
  const pushManager = {
    getSubscription: async () => live,
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      issued += 1;
      const key = options.applicationServerKey;
      live = standIn(`https://push.example/${issued}`, key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer);
      return live;
    },
  };
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }), getRegistration: async () => ({ pushManager }) },
  });
  Object.assign(globalThis, { PushManager: class {}, Notification: { permission: "granted" } });
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === "/api/push") return Response.json({ public_key: SERVER_KEY });
    if (url === "/api/push/subscribe" && init?.method === "POST") {
      registered.push((JSON.parse(String(init.body)) as { subscription: { endpoint: string } }).subscription.endpoint);
      return new Response(null, { status: 204 });
    }
    if (url === "/api/push/subscribe" && init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
  Object.assign(globalThis, { PushManager: saved.PushManager, Notification: saved.Notification, fetch: saved.fetch });
});

describe("ensurePushSubscription", () => {
  it("gives overlapping callers one subscription, not two where only the later survives", async () => {
    // the bell's first tap: its own call plus the load-time registration the grant starts
    const [fromClick, fromEffect] = await Promise.all([ensurePushSubscription(), ensurePushSubscription()]);
    expect(issued).toBe(1);
    expect(fromClick).toBe(fromEffect);
    expect(fromClick).toBe(live!.endpoint);
    expect(registered).toEqual([live!.endpoint]);
  });

  it("reuses the live subscription on a later load and registers it again", async () => {
    const first = await ensurePushSubscription();
    const again = await ensurePushSubscription();
    expect(issued).toBe(1);
    expect(again).toBe(first);
    expect(registered).toEqual([first!, first!]);
  });

  it("replaces a subscription made for another server key", async () => {
    const stale = standIn("https://push.example/stale", OTHER_KEY);
    live = stale;
    const endpoint = await ensurePushSubscription();
    expect(stale.unsubscribed).toBe(true);
    expect(endpoint).toBe("https://push.example/1");
    expect(registered).toEqual(["https://push.example/1"]);
  });

  it("does nothing until notifications are allowed", async () => {
    Object.assign(globalThis, { Notification: { permission: "default" } });
    expect(await ensurePushSubscription()).toBeNull();
    expect(issued).toBe(0);
    expect(registered).toEqual([]);
  });
});

describe("testDevicePush", () => {
  it("tests only this browser's current endpoint without registering it again", async () => {
    live = standIn("https://push.example/existing", OTHER_KEY);
    const calls: Array<[string, RequestInit | undefined]> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    expect(await testDevicePush()).toBe("sent");
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBe("/api/push/test");
    expect(calls[0]![1]?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ endpoint: live.endpoint });
    expect(issued).toBe(0);
    expect(registered).toEqual([]);
  });

  it("reports a missing browser subscription without creating a replacement", async () => {
    expect(await testDevicePush()).toBe("missing");
    expect(issued).toBe(0);
    expect(registered).toEqual([]);
  });

  it.each([[404, "subscription_not_found"], [502, "push_failed"]] as const)("preserves the server's %s %s result", async (status, code) => {
    live = standIn("https://push.example/stale", OTHER_KEY);
    globalThis.fetch = (async (_url: string) => Response.json({ error: { code, message: code } }, { status })) as typeof fetch;
    try {
      await testDevicePush();
      throw new Error("expected the test to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(code);
    }
    expect(issued).toBe(0);
  });

  it("does not ask for permission or send a push after permission is revoked", async () => {
    Object.assign(globalThis, { Notification: { permission: "denied" } });
    expect(await testDevicePush()).toBe("permission");
    expect(issued).toBe(0);
  });

  it("handles a browser without push support", async () => {
    delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
    expect(await testDevicePush()).toBe("unsupported");
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

it("removes a registration still in flight when the bell is turned off", async () => {
  const entered = deferred(), release = deferred();
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (args[0] === "/api/push") { entered.resolve(); await release.promise; }
    return fetch(...args);
  }) as typeof fetch;
  const enable = ensurePushSubscription();
  await entered.promise;
  const disable = removePushSubscription();
  release.resolve();
  await Promise.all([enable, disable]);
  expect(registered).toEqual(["https://push.example/1"]);
  expect(live).toBeNull();
});

it("still cleans up the browser subscription when registration fails", async () => {
  const entered = deferred(), release = deferred();
  const fetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    if (args[0] === "/api/push/subscribe" && args[1]?.method === "POST") {
      entered.resolve(); await release.promise; return new Response(null, { status: 503 });
    }
    return fetch(...args);
  }) as typeof fetch;
  const enable = ensurePushSubscription().catch(() => null);
  await entered.promise;
  const subscription = live!;
  const disable = removePushSubscription();
  release.resolve();
  await Promise.all([enable, disable]);
  expect(subscription.unsubscribed).toBe(true);
  expect(live).toBeNull();
});

it("preserves a rapid on-off-on sequence instead of reusing a subscription being removed", async () => {
  const enable = ensurePushSubscription();
  const disable = removePushSubscription();
  const reenable = ensurePushSubscription();
  await Promise.all([enable, disable, reenable]);
  expect(issued).toBe(2);
  expect(await reenable).toBe(live!.endpoint);
  expect(live!.unsubscribed).toBe(false);
});
