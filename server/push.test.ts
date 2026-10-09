import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AlertPrefs } from "../shared/notify-policy.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { createPushService, handlePushRequest, parseSubscription, type PushService } from "./push.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";

/**
 * The server half of web push, end to end against a fake push service that decrypts
 * and verifies like a real device would. No herdr needed: panes are handed in the way
 * the collector hands them (seed) and status changes the way it reports them.
 */

function pane(paneId: string, status: AgentStatus, title: string): HerdrPane {
  return {
    pane_id: paneId,
    agent_status: status,
    terminal_title: title,
    focused: false,
    revision: 0,
    tab_id: "t1",
    terminal_id: "term_1",
    workspace_id: "w1",
  };
}

let stateDir: string;
let fake: FakePushService;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-push-"));
  fake = await startFakePushService();
});

afterEach(() => {
  fake.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

/** Alerts go out at once, and each status change is awaited until its alert went out. */
function subscribed(options: Partial<Parameters<typeof createPushService>[0]> = {}): PushService {
  const push = createPushService({ stateDir, timing: { short: 0, long: 0, longTurn: 0 }, ...options });
  push.subscribe(fake.subscription);
  const onStatus = push.onStatus;
  push.onStatus = async (...args) => {
    await onStatus(...args);
    await push.settled();
  };
  return push;
}

describe("parseSubscription", () => {
  it("accepts what a browser's PushSubscription.toJSON() produces", () => {
    const browserJson = { ...fake.subscription, expirationTime: null };
    expect(parseSubscription(browserJson)).toEqual(fake.subscription);
  });

  it("rejects endpoints and keys a push service could never have issued", () => {
    const { endpoint, keys } = fake.subscription;
    expect(parseSubscription({ endpoint: "ftp://push.example/x", keys })).toBeNull();
    expect(parseSubscription({ endpoint: "not a url", keys })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, p256dh: keys.p256dh.slice(0, 40) } })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, auth: "AAAA" } })).toBeNull();
    expect(parseSubscription({ endpoint })).toBeNull();
    expect(parseSubscription("subscription")).toBeNull();
  });
});

describe("push state", () => {
  it("keeps one owner-only VAPID key pair across restarts", () => {
    const key = createPushService({ stateDir }).publicKey();
    expect(Buffer.from(key, "base64url").length).toBe(65);
    expect(createPushService({ stateDir }).publicKey()).toBe(key);
    expect(statSync(join(stateDir, "vapid.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a malformed key file instead of rotating the key under every device", () => {
    writeFileSync(join(stateDir, "vapid.json"), "{}\n");
    expect(() => createPushService({ stateDir }).publicKey()).toThrow("malformed");
    expect(readFileSync(join(stateDir, "vapid.json"), "utf8")).toBe("{}\n");
  });

  it("keeps subscriptions across restarts", async () => {
    subscribed();
    expect(statSync(join(stateDir, "push-subscriptions.json")).mode & 0o777).toBe(0o600);
    const restarted = createPushService({ stateDir });
    expect(await restarted.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received).toHaveLength(1);
  });
});

describe("push delivery", () => {
  it("delivers the real finish after a late unknown snapshot arrives during a new Codex turn", async () => {
    const push = subscribed();
    const completions = new CompletionTracker();
    const id = "w1:p1";
    const atRest = { panes: [{ ...pane(id, "unknown", "Codex regression"), agent: "codex" }], agents: [] } as unknown as SessionSnapshot;
    push.seed(atRest.panes);
    let release!: (value: SessionSnapshot) => void;
    const pending = new Promise<SessionSnapshot>((resolve) => { release = resolve; });
    const reading = completions.readSnapshot(() => pending);
    await push.onStatus(id, completions.observe(id, "working", "codex"));
    release(atRest);
    expect((await reading).panes[0]!.agent_status).toBe("working");
    expect(completions.seen(id)).toBe(false);
    expect(fake.received).toHaveLength(0);

    expect(completions.observe(id, "unknown", "codex")).toBe("done");
    await push.onStatus(id, "done");
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.payload.body).toBe("work finished");
    expect(fake.received[0]!.vapidValid).toBe(true);
  });

  it("delivers one done alert per Codex finish while an agent handoff keeps working", async () => {
    const push = subscribed();
    const completions = new CompletionTracker();
    const id = "w1:p1";
    push.seed([pane(id, "unknown", "Codex regression")]);
    const report = async (status: AgentStatus, agent: string) => {
      const presented = completions.observe(id, status, agent);
      await push.onStatus(id, presented);
      return presented;
    };

    for (let turn = 0; turn < 2; turn++) {
      expect(await report("working", "codex")).toBe("working");
      expect(await report("unknown", "codex")).toBe("done");
      // Repeated raw unknown events must not repeat the completion alert.
      expect(await report("unknown", "codex")).toBe("done");
      expect(fake.received).toHaveLength(turn + 1);
    }
    expect(fake.received.every((message) => message.payload.body === "work finished" && message.vapidValid)).toBe(true);

    await report("working", "pi");
    expect(await report("unknown", "claude")).toBe("working");
    expect(fake.received).toHaveLength(2);
    expect(await report("idle", "claude")).toBe("done");
    expect(fake.received).toHaveLength(3);
  });

  it("sends a status alert the device can decrypt, signed with the server's key", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");

    expect(fake.received).toHaveLength(1);
    const [received] = fake.received;
    expect(received!.payload).toEqual({
      pane_id: "w1:p1",
      title: "claude: fix the build",
      body: "waiting for your input",
      tag: "herdr-pane-w1:p1",
    });
    expect(received!.urgency).toBe("high");
    expect(received!.ttl).toBe(12 * 60 * 60);
    expect(received!.vapidValid).toBe(true);
    expect(received!.vapidKey).toBe(push.publicKey());
    expect(received!.vapidClaims.aud).toBe(new URL(fake.subscription.endpoint).origin);
    expect(received!.vapidClaims.sub).toBe("https://github.com/devswha/herdr-web-ui");
  });

  it("keeps equal pane IDs, titles, status baselines and push links separated by PC", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "alpha")], "pc-a", "Work PC");
    push.seed([pane("w1:p1", "working", "beta")], "pc-b", "Home PC");
    await push.onStatus("w1:p1", "blocked", "pc-a");
    await push.onStatus("w1:p1", "done", "pc-b");
    expect(fake.received.map((r) => r.payload.machine_id)).toEqual(["pc-a", "pc-b"]);
    expect(fake.received.map((r) => r.payload.title)).toEqual(["Work PC · alpha", "Home PC · beta"]);
    expect(fake.received[0]!.payload.tag).not.toBe(fake.received[1]!.payload.tag);
    expect(fake.received.every((r) => r.vapidValid)).toBe(true);
  });

  it("measures the first change after a restart against the seeded baseline", async () => {
    const push = subscribed();
    // never seeded: the first report is a first sighting, not news (same rule as the tab)
    await push.onStatus("w1:p9", "blocked");
    expect(fake.received).toHaveLength(0);
    // seeded from the collector's snapshot: the very first event is already a transition
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.pane_id)).toEqual(["w1:p1"]);
    expect(fake.received[0]!.urgency).toBe("normal");
  });

  it("does not let a later snapshot overwrite a status an event already reported", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // a reconcile that raced the event still says working; blocked -> blocked is not news
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(1);
  });

  it("names the pane by its current title, falling back to the seeded one", async () => {
    let fresh: string | Error = "claude: new task";
    const push = subscribed({
      lookupTitle: async () => {
        if (fresh instanceof Error) throw fresh;
        return fresh;
      },
    });
    push.seed([pane("w1:p1", "working", "claude: old task")]);
    await push.onStatus("w1:p1", "blocked");
    fresh = new Error("herdr busy");
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.title)).toEqual(["claude: new task", "claude: old task"]);
  });

  it("tells the device a pane's terminal ended, under its last known title", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "vim notes.md")]);
    await push.onEnded("w1:p1");
    expect(fake.received[0]!.payload).toEqual({
      pane_id: "w1:p1",
      title: "vim notes.md",
      body: "terminal ended",
      tag: "herdr-pane-w1:p1",
    });
  });

  it("forgets a device its push service reports gone", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
  });

  it("keeps a device through a failure that is not a goodbye", async () => {
    const push = subscribed();
    fake.answerWith(500);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 500, gone: false });
    fake.answerWith(201);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });
});

describe("alert timing and each device's choice", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** real timers, short enough for a test; the clock that measures turns is ours to move */
  function timed(alerts?: AlertPrefs) {
    let clock = 0;
    const push = createPushService({ stateDir, timing: { short: 40, long: 80, longTurn: 1_000 }, now: () => clock });
    push.subscribe(fake.subscription, alerts);
    push.seed([pane("w1:p1", "idle", "claude")]);
    return { push, advance: (ms: number) => { clock += ms; } };
  }

  it("calls off a derived Codex finish when it is seen or a new turn begins", async () => {
    const { push } = timed({ input: true, done: "always" });
    const completions = new CompletionTracker();
    const report = (status: AgentStatus) => push.onStatus("w1:p1", completions.observe("w1:p1", status, "codex"));
    await report("working");
    await report("unknown");
    expect(completions.seen("w1:p1")).toBe(true);
    // This is the same onFocus status the server passes to PushService.
    await push.onStatus("w1:p1", "idle");
    await push.settled();
    expect(fake.received).toHaveLength(0);

    await report("working");
    await report("unknown");
    await report("working");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await report("unknown");
    await push.settled();
    expect(fake.received.map((message) => message.payload.body)).toEqual(["work finished"]);
  });

  it("calls off a question answered before it goes out, and sends one left waiting", async () => {
    const { push } = timed();
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    await sleep(10);
    await push.onStatus("w1:p1", "working");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["waiting for your input"]);
  });

  it("tells a finish only after a turn that worked a while, and not one followed by the next prompt", async () => {
    const { push, advance } = timed();
    await push.onStatus("w1:p1", "working");
    advance(500);
    await push.onStatus("w1:p1", "done");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p1", "working");
    advance(2_000);
    await push.onStatus("w1:p1", "done");
    await sleep(10);
    // the next prompt went in before the alert: the user is there
    await push.onStatus("w1:p1", "working");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    advance(2_000);
    await push.onStatus("w1:p1", "done");
    await push.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
  });

  it("follows what the device chose: no questions, every finish, or no finish at all", async () => {
    const quiet = timed({ input: false, done: "always" });
    await quiet.push.onStatus("w1:p1", "blocked");
    await quiet.push.onStatus("w1:p1", "done");
    await quiet.push.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
    fake.received.length = 0;
    const none = timed({ input: true, done: "off" });
    await none.push.onStatus("w1:p1", "working");
    none.advance(5_000);
    await none.push.onStatus("w1:p1", "done");
    await none.push.onEnded("w1:p1");
    await none.push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("keeps a device's choice through a re-registration without one, and a restart", async () => {
    const push = createPushService({ stateDir });
    push.subscribe(fake.subscription, { input: false, done: "off" });
    push.subscribe(fake.subscription);
    const stored = JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8")) as Array<{ alerts?: AlertPrefs }>;
    expect(stored[0]!.alerts).toEqual({ input: false, done: "off" });
    const restarted = createPushService({ stateDir, timing: { short: 0, long: 0, longTurn: 0 } });
    restarted.seed([pane("w1:p1", "working", "claude")]);
    await restarted.onStatus("w1:p1", "blocked");
    await restarted.settled();
    expect(fake.received).toHaveLength(0);
  });
});

it("cancels the remaining delay group after an earlier device already received its finish", async () => {
  const slower = await startFakePushService();
  try {
    const push = createPushService({ stateDir, timing: { short: 0, long: 10_000, longTurn: 0 } });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.subscribe(slower.subscription, { input: true, done: "long" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await fake.waitFor((message) => message.payload.body === "work finished", "early finish", 2000);
    await push.onStatus("w1:p1", "working");
    await push.settled();
    expect(slower.received).toHaveLength(0);
  } finally { slower.stop(); }
});

it("settles only after a delivery already under way, when a later group is called off", async () => {
  let release!: () => void;
  let asked!: () => void;
  const titleAsked = new Promise<void>((resolve) => { asked = resolve; });
  const push = createPushService({
    stateDir, timing: { short: 0, long: 10_000, longTurn: 0 },
    lookupTitle: () => { asked(); return new Promise((resolve) => { release = () => resolve("claude"); }); },
  });
  const slower = await startFakePushService();
  try {
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.subscribe(slower.subscription, { input: true, done: "long" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await titleAsked;
    await push.onStatus("w1:p1", "working");
    let settled = false;
    const settling = push.settled().then(() => { settled = true; });
    await Bun.sleep(50);
    expect(settled).toBe(false);
    release();
    await settling;
    expect(fake.received).toHaveLength(1);
    expect(slower.received).toHaveLength(0);
  } finally { slower.stop(); }
});


it("persists device ownership and refuses revoked and legacy subscriptions after restart", async () => {
  const active = new Set(["device-a"]);
  const canDeliver = (id: string | null | undefined) => id === null || typeof id === "string" && active.has(id);
  const push = createPushService({ stateDir, canDeliver });
  push.subscribe(fake.subscription, undefined, "device-a");
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0].device_id).toBe("device-a");
  active.clear();
  const restarted = createPushService({ stateDir, canDeliver });
  await restarted.onEnded("w1:p1");
  expect(fake.received).toHaveLength(0);
  restarted.revokeDevice("device-a");
  expect(await restarted.sendTest(fake.subscription.endpoint)).toBeNull();
  // Legacy records cannot identify a revoked device; re-registration supplies an owner.
  push.subscribe(fake.subscription);
  const migrated = createPushService({ stateDir, canDeliver });
  await migrated.onEnded("w1:p1");
  expect(fake.received).toHaveLength(0);
  migrated.subscribe(fake.subscription, undefined, null);
  await migrated.onEnded("w1:p1");
  expect(fake.received).toHaveLength(1);
});

it("keeps a pending alert across re-registration but drops it after device revocation", async () => {
  const active = new Set(["device-a"]);
  const push = createPushService({ stateDir, timing: { short: 20 }, canDeliver: (id) => typeof id === "string" && active.has(id) });
  push.subscribe(fake.subscription, undefined, "device-a");
  push.seed([pane("w1:p1", "working", "claude")]);
  await push.onStatus("w1:p1", "blocked");
  push.subscribe(fake.subscription, undefined, "device-a");
  await push.settled();
  expect(fake.received).toHaveLength(1);
  await push.onStatus("w1:p1", "working");
  await push.onStatus("w1:p1", "blocked");
  active.clear();
  // The registry still blocks delivery if push-file cleanup cannot run.
  await push.settled();
  expect(fake.received).toHaveLength(1);
});

it("keeps a subscription made through the open LAN only while the LAN stays open", async () => {
  let gated = false;
  // the server's rule (index.ts): owners null always, undefined only while ungated
  const push = createPushService({ stateDir, canDeliver: (id) => id === null || (id === undefined ? !gated : false) });
  const request = new Request("http://192.168.1.20:8787/api/push/subscribe", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: fake.subscription }),
  });
  expect((await handlePushRequest(request, "/api/push/subscribe", push, undefined))?.status).toBe(204);
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0]).not.toHaveProperty("device_id");
  await push.onEnded("w1:p1");
  expect(fake.received).toHaveLength(1);
  // pairing a device closes the open LAN: its earlier subscriber hears nothing more
  gated = true;
  await push.onEnded("w1:p2");
  expect(fake.received).toHaveLength(1);
});

describe("push resync after lost status events", () => {
  it("calls off the waiting alert of a pane that closed while events were lost", async () => {
    const push = createPushService({ stateDir, timing: { short: 50, long: 50, longTurn: 0 } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "gone"), pane("w1:p2", "working", "kept"), pane("w1:p3", "working", "new")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p3", "blocked");
    // p1 is gone; p3 is missing from the snapshot too, but was heard of since it was asked for
    push.resync([pane("w1:p2", "working", "kept")], new Set(["w1:p3"]));
    await push.settled();
    expect(fake.received.map((r) => r.payload.title)).toEqual(["new"]);
  });

  it("takes a clean pane's snapshot status as its baseline and announces nothing", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    // it finished and started over while events were lost
    push.resync([pane("w1:p1", "blocked", "claude")], new Set());
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // measured against the resynced baseline: blocked -> blocked is no change
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((r) => r.payload.body)).toHaveLength(1);
  });

  it("calls off an alert still waiting for a pane that is at rest by the snapshot", async () => {
    const push = createPushService({ stateDir, timing: { short: 50, long: 50, longTurn: 0 } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    push.resync([pane("w1:p1", "idle", "claude")], new Set());
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("leaves a pane with a newer event, and done versus idle, as they are", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "a"), pane("w1:p2", "working", "b")]);
    await push.onStatus("w1:p2", "done");
    const sent = fake.received.length;
    push.resync([pane("w1:p1", "idle", "a"), pane("w1:p2", "idle", "b")], new Set(["w1:p1"]));
    // p1 was not clean: still working, so its finish is news
    await push.onStatus("w1:p1", "done");
    expect(fake.received.length).toBe(sent + 1);
    // p2 stayed done (at rest either way): a new turn and its finish are still heard
    await push.onStatus("w1:p2", "working");
    await push.onStatus("w1:p2", "done");
    expect(fake.received.length).toBe(sent + 2);
  });
});
