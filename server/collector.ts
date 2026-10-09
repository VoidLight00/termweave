import type { AgentStatus, HerdrPane } from "../shared/protocol.ts";
import { HerdrError, sessionSnapshot, subscribeEvents, type EventFrame, type Subscription } from "./herdr/client.ts";

/**
 * Collects agent status for EVERY pane in the session, not just the attached ones.
 *
 * herdr's subscription surface (verified against protocol 22):
 * - `pane.agent_status_changed` REQUIRES a pane_id, but one connection carries any
 *   number of per-pane subscriptions, so all panes share a single status connection.
 * - A second `events.subscribe` request on an already-open connection is silently
 *   ignored: when the pane set changes the status connection must be re-opened with
 *   the full set (see `reconcile`).
 * - `pane.created` / `pane.closed` / `pane.exited` subscribe globally (no pane_id)
 *   and drive both the pane-set reconciliation and the structure broadcasts.
 * - `pane.focused` subscribes globally too, and fires for a tab or workspace brought to the
 *   front as well (`{event:"pane_focused", data:{type, pane_id, workspace_id}}`).
 *
 * - herdr (0.9.2+) closes a subscription that fell behind, after an `events_lost` error
 *   that never arrives when the socket's buffer is full (seen on 0.9.3): every connection
 *   here reopens itself on the close alone, and whatever it missed is read back from a
 *   snapshot taken once the new subscription has started (herdr's documented order).
 *
 * - A status that changed while no subscription was listening for the pane is never sent
 *   again: the pane set changed (a pane opened or closed elsewhere) and the status connection
 *   was being reopened with the new set, herdr refused a batch for a pane that had gone, or
 *   the server had only just started. A finish in that gap cost its done alert (#245: with
 *   panes opening and closing beside it, a pane's one status change was lost in 5 of 10
 *   runs). Such a gap is short and known, so the first snapshot after the new subscription
 *   started is measured against each pane's status as last told (by an event, or by an
 *   earlier replay), and a difference is told as that event (`replay`). Nothing else is,
 *   and no other snapshot moves what a pane was last told as: a snapshot at any other time
 *   may differ from the last event for reasons that are no change (herdr reads a finish
 *   nobody saw as `done` here and `idle` there), or be ahead of an event still on its way,
 *   and what was missed over an outage of unknown length (`events_lost`, a herdr that could
 *   not be reached) is corrected without alerts (`onResync`).
 *   The snapshot that shows the pane set changed is such evidence too: the connection is
 *   closed on its account, and an event herdr had sent but this side had not read yet goes
 *   with it (traced: the snapshot already showed `unknown`, the event for it never came).
 *
 * Status frames are flat (`{event:"pane.agent_status_changed", data:{pane_id, agent_status, ...}}`)
 * while structure frames carry a snake_case `data.type` - both shapes below parse only
 * what the live server actually sends.
 */

/** first retry after a subscription closed; doubles per closure that never started */
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;
const BACKSTOP_INTERVAL_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 500;
/** retry delay when a reconcile's snapshot call fails (herdr busy/restarting) */
const SNAPSHOT_RETRY_MS = 5_000;
/**
 * A snapshot is answered on its own connection and can overtake events herdr sent before it
 * (working, then idle, both still unread when the snapshot already said idle). What a
 * snapshot is about to replay waits this long first, and an event that came in meanwhile wins.
 */
const REPLAY_SETTLE_MS = 150;

export interface StatusCollectorHandlers {
  /**
   * `agent` is the agent herdr now sees in the pane (null: none). `replay`: no event said
   * so; a snapshot did, around a gap between two subscriptions, and this is what the pane
   * was last heard as before it. herdr reads a finish nobody saw as `done` in one place and
   * `idle` in another, so a replay between two statuses at rest may be no change at all:
   * whoever keeps what the pane is shown as decides (CompletionTracker.replayed).
   */
  onStatus: (paneId: string, status: AgentStatus, agent: string | null, replay?: { before: AgentStatus; agent: string | null }) => void;
  /**
   * Every pane as of each reconcile's snapshot. Status events only report changes, so
   * this is where a consumer learns the status a later change is measured against -
   * right after a restart, the first event of a pane would otherwise have no baseline.
   */
  onBaseline: (panes: readonly HerdrPane[]) => void;
  /**
   * Status events were lost (the status connection closed under us, e.g. herdr's
   * `events_lost`): this snapshot, taken after the new subscription started, is the
   * truth for every pane but the `newer` ones, which had an event since it was asked for.
   */
  onResync?: (panes: readonly HerdrPane[], newer: ReadonlySet<string>) => void;
  onPaneEnded: (paneId: string) => void;
  onStructureChange: () => void;
  /** a pane opened (from a `pane_created` frame that names it; panes opened during an outage are not told) */
  onPaneCreated?: (pane: CreatedPane) => void;
  /** herdr's focus moved onto this pane: whoever is at its terminal has it in front */
  onFocus?: (paneId: string) => void;
}

/** What the collector talks to, and how long it waits: tests swap both. */
export interface StatusCollectorDeps {
  subscribe: typeof subscribeEvents;
  snapshot: () => Promise<{ panes: HerdrPane[] }>;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  backstopMs: number;
  debounceMs: number;
  snapshotRetryMs: number;
  /** how long a replay waits for events already on their way: one that arrives is newer than the snapshot */
  replaySettleMs: number;
}

const DEFAULT_DEPS: StatusCollectorDeps = {
  subscribe: subscribeEvents,
  snapshot: () => sessionSnapshot(),
  reconnectMinMs: RECONNECT_MIN_MS,
  reconnectMaxMs: RECONNECT_MAX_MS,
  backstopMs: BACKSTOP_INTERVAL_MS,
  debounceMs: RECONCILE_DEBOUNCE_MS,
  snapshotRetryMs: SNAPSHOT_RETRY_MS,
  replaySettleMs: REPLAY_SETTLE_MS,
};

export interface StatusCollector {
  stop: () => void;
}

/** A status frame's payload: flat fields, no wrapper object. */
export function parseStatusFrame(frame: EventFrame): { paneId: string; status: AgentStatus; agent: string | null } | null {
  if (frame.event !== "pane.agent_status_changed") return null;
  const data = frame.data as { pane_id?: unknown; agent_status?: unknown; agent?: unknown } | undefined;
  if (typeof data?.pane_id !== "string" || typeof data.agent_status !== "string") return null;
  return { paneId: data.pane_id, status: data.agent_status as AgentStatus, agent: typeof data.agent === "string" ? data.agent : null };
}

/** The pane a `pane_created` frame carries (`data.pane`); `label` is null until someone names it. */
export interface CreatedPane { paneId: string; workspaceId: string; label: string | null }

export type StructureEvent =
  | { kind: "pane-ended"; paneId: string }
  /** `closed`: the pane a `pane_closed` frame names; `created`: the one a `pane_created` frame carries */
  | { kind: "structure-changed"; closed?: string; created?: CreatedPane };

/** The pane a focus frame (`{data:{type:"pane_focused", pane_id}}`) brought to the front. */
export function parseFocusFrame(frame: EventFrame): string | null {
  const data = frame.data as { type?: unknown; pane_id?: unknown } | undefined;
  return data?.type === "pane_focused" && typeof data.pane_id === "string" ? data.pane_id : null;
}

/** Structure frames: `{event:"pane_exited"|"pane_created"|"pane_closed", data:{type, pane_id?}}`. */
export function parseStructureFrame(frame: EventFrame): StructureEvent | null {
  const data = frame.data as { type?: unknown; pane_id?: unknown } | undefined;
  switch (data?.type) {
    case "pane_exited":
      return typeof data.pane_id === "string" ? { kind: "pane-ended", paneId: data.pane_id } : null;
    case "pane_closed":
      return typeof data.pane_id === "string" ? { kind: "structure-changed", closed: data.pane_id } : { kind: "structure-changed" };
    case "pane_created": {
      const pane = (frame.data as { pane?: { pane_id?: unknown; workspace_id?: unknown; label?: unknown } } | undefined)?.pane;
      return typeof pane?.pane_id === "string" && typeof pane.workspace_id === "string"
        ? { kind: "structure-changed", created: { paneId: pane.pane_id, workspaceId: pane.workspace_id, label: typeof pane.label === "string" ? pane.label : null } }
        : { kind: "structure-changed" };
    }
    default:
      return null;
  }
}

/**
 * A subscription that reopens itself when herdr closes it: at once, then backing off
 * while it keeps closing before it starts (herdr restarting). herdr closes a subscriber
 * that fell behind (`events_lost`, 0.9.2+) as well, and events sent meanwhile are gone:
 * `onRestart` runs once a connection opened after the first attempt is live, including
 * when the first never started (events since the caller's snapshot may be missed).
 */
function resilientSubscription(
  deps: StatusCollectorDeps,
  subscriptions: Parameters<typeof subscribeEvents>[0],
  onEvent: (frame: EventFrame) => void,
  onRestart: () => void,
  isStopped: () => boolean,
): { close: () => void } {
  let subscription: Subscription | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = deps.reconnectMinMs;
  let attempted = false;

  const open = (): void => {
    retryTimer = null;
    if (isStopped()) return;
    const retry = attempted;
    attempted = true;
    subscription = deps.subscribe(subscriptions, {
      onEvent,
      onStarted: () => {
        delay = deps.reconnectMinMs;
        if (retry) onRestart();
      },
      onError: logSubscriptionError,
      onClose: () => {
        subscription = null;
        if (isStopped()) return;
        retryTimer = setTimeout(open, delay);
        delay = Math.min(delay * 2, deps.reconnectMaxMs);
      },
    });
  };
  open();

  return {
    close() {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      const current = subscription;
      subscription = null;
      current?.close();
    },
  };
}

/** herdr unreachable is expected while it restarts; anything else is worth a line. */
function logSubscriptionError(error: Error): void {
  const code = error instanceof HerdrError ? error.code : "error";
  if (code === "connect_failed" || code === "socket_error") return;
  console.error(`herdr events: ${code}: ${error.message}`);
}

export function startStatusCollector(handlers: StatusCollectorHandlers, overrides: Partial<StatusCollectorDeps> = {}): StatusCollector {
  const deps: StatusCollectorDeps = { ...DEFAULT_DEPS, ...overrides };
  let stopped = false;
  let statusSubscription: Subscription | null = null;
  let subscribedPaneIds = new Set<string>();
  let reconciling = false;
  let reconcilePending = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let backstopTimer: ReturnType<typeof setInterval> | null = null;
  let lifecycleSubscription: { close: () => void } | null = null;
  let focusSubscription: { close: () => void } | null = null;
  /** status events were lost: the next snapshot after a new subscription starts resyncs */
  let recovering = false;
  /** each status subscription's number: a resync counts only for the one still open */
  let statusGeneration = 0;
  /** the subscription that started while recovering: the next reconcile's snapshot resyncs */
  let resyncFor: number | null = null;
  /** counts status events; each pane keeps the count of its latest */
  let statusEvents = 0;
  const lastEventOf = new Map<string, number>();
  /** each pane's status as last heard, in an event or a snapshot: what the snapshot after a gap is measured against */
  const heard = new Map<string, { status: AgentStatus; agent: string | null }>();
  /** when a pane last ended or closed, counted as events are: a snapshot asked for before that is no news of it */
  const actedOn = new Map<string, number>();
  /** when a pane last came to the front: no replay from a snapshot asked for before that. A resync still corrects it */
  const focusedAt = new Map<string, number>();
  /** the status subscription was closed for another pane set, or refused: a change since then may have had no event */
  let gap = false;
  /** the subscription that started after such a gap: the next reconcile's snapshot replays */
  let replayFor: number | null = null;
  /** the open status subscription has started: until then it has heard nothing */
  let statusStarted = false;

  const STRUCTURE_SUBSCRIPTIONS = [
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.exited" },
  ] as const;

  function closeStatusSubscription(): void {
    statusStarted = false;
    subscribedPaneIds = new Set();
    statusSubscription?.close();
    statusSubscription = null;
  }

  function openStatusSubscription(paneIds: readonly string[]): void {
    if (stopped || paneIds.length === 0) return;
    subscribedPaneIds = new Set(paneIds);
    const generation = ++statusGeneration;
    let started = false;
    /** herdr answered the batch with an error of its own (a pane that had gone), not a connection that failed */
    let refused = false;
    // between the snapshot that chose these panes and this subscription's start nothing listens
    gap = true;
    const subscription = deps.subscribe(
      paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
      {
        onEvent: (frame) => {
          const parsed = parseStatusFrame(frame);
          if (!parsed) return;
          lastEventOf.set(parsed.paneId, ++statusEvents);
          heard.set(parsed.paneId, { status: parsed.status, agent: parsed.agent });
          handlers.onStatus(parsed.paneId, parsed.status, parsed.agent);
        },
        // herdr's contract: subscribe, wait until it started, then snapshot. The snapshot
        // that chose these panes came before: one more closes the gap it leaves.
        onStarted: () => {
          started = true;
          if (statusSubscription !== subscription) return;
          statusStarted = true;
          if (recovering) resyncFor = generation;
          else if (gap) replayFor = generation;
          void reconcile();
        },
        onError: (error) => {
          const code = error instanceof HerdrError ? error.code : "error";
          refused = code !== "connect_failed" && code !== "socket_error" && code !== "timeout" && code !== "error";
          logSubscriptionError(error);
        },
        // herdr answers a bad batch (e.g. a pane that vanished between snapshot and
        // subscribe) with an error frame and closes the socket, and closes a subscriber
        // that fell behind (`events_lost`): the whole set is re-subscribed from a fresh
        // snapshot, now rather than after the debounce, and what was missed is resynced.
        // One herdr refused before it started lost no events of its own: the gap it leaves
        // is the short one between two subscriptions. One that could not connect says
        // nothing of how long nobody listened, and recovers like a lost one
        onClose: () => {
          if (statusSubscription !== subscription || stopped) return;
          closeStatusSubscription();
          if (started || !refused) recovering = true;
          void reconcile();
        },
      },
    );
    statusSubscription = subscription;
  }

  async function reconcile(): Promise<void> {
    if (stopped) return;
    if (reconciling) {
      // a reconcile is in flight: remember the request and re-run when it lands,
      // so an event arriving mid-reconcile can never be lost to the debounce
      reconcilePending = true;
      return;
    }
    reconciling = true;
    const resync = resyncFor;
    resyncFor = null;
    const replay = replayFor;
    replayFor = null;
    const askedAt = statusEvents;
    try {
      const snapshot = await deps.snapshot();
      if (stopped) return;
      handlers.onBaseline(snapshot.panes);
      // a snapshot asked for a subscription that closed meanwhile may predate what the next
      // one misses: recovery waits for that one's own snapshot
      const resynced = resync !== null && resync === statusGeneration && statusSubscription !== null;
      if (resynced) {
        recovering = false;
        // an exit since the snapshot was asked for is newer than it too. A focus is not: work that
        // ended during the loss is still to be settled, or it would read as going on for good
        const newer = new Set([...lastEventOf, ...actedOn].filter(([, seq]) => seq > askedAt).map(([paneId]) => paneId));
        handlers.onResync?.(snapshot.panes, newer);
        // clients learn statuses from events, and some were lost: they fetch again
        handlers.onStructureChange();
      }
      const paneIds = snapshot.panes.map((pane) => pane.pane_id);
      const sameSet =
        paneIds.length === subscribedPaneIds.size && paneIds.every((id) => subscribedPaneIds.has(id));
      // the live subscription is about to be closed for another pane set: what this snapshot
      // shows and no event has said will not be said by one any more
      const leaving = !sameSet && statusStarted && !recovering && !resynced;
      const afterGap = !resynced && !recovering && replay !== null && replay === statusGeneration && statusSubscription !== null;
      const replaying = afterGap || leaving;
      if (resynced || afterGap) gap = false;
      const newerThan = (paneId: string, seq: number): boolean => Math.max(lastEventOf.get(paneId) ?? 0, actedOn.get(paneId) ?? 0, focusedAt.get(paneId) ?? 0) > seq;
      const replays: HerdrPane[] = [];
      for (const pane of snapshot.panes) {
        // an event, an exit or a focus since the snapshot was asked for is newer than it
        const focusOnly = resynced && Math.max(lastEventOf.get(pane.pane_id) ?? 0, actedOn.get(pane.pane_id) ?? 0) <= askedAt;
        if (newerThan(pane.pane_id, askedAt) && !focusOnly) continue;
        const before = heard.get(pane.pane_id);
        // a pane first seen, or corrected by the resync: this is what it is told as from now
        if (before === undefined || resynced) heard.set(pane.pane_id, { status: pane.agent_status, agent: pane.agent ?? null });
        else if (replaying && before.status !== pane.agent_status) replays.push(pane);
      }
      // also with nothing to replay, when the live connection is about to close: an event on its way is read first
      if (replays.length > 0 || leaving) {
        const generation = statusGeneration;
        // the old connection stays open through this: an event it still holds is read, and wins
        await new Promise((resolve) => setTimeout(resolve, deps.replaySettleMs));
        if (stopped) return;
        // the subscription closed under the wait: what was missed is of unknown length now, and the resync speaks
        const still = !recovering && generation === statusGeneration && statusSubscription !== null;
        for (const pane of still ? replays : []) {
          const before = heard.get(pane.pane_id);
          if (newerThan(pane.pane_id, askedAt) || before === undefined || before.status === pane.agent_status) continue;
          const agent = pane.agent ?? null;
          heard.set(pane.pane_id, { status: pane.agent_status, agent });
          handlers.onStatus(pane.pane_id, pane.agent_status, agent, { before: before.status, agent: before.agent });
        }
      }
      // gone before this snapshot; a pane heard of since may be too new for it
      for (const [paneId, seq] of lastEventOf) if (seq <= askedAt && !paneIds.includes(paneId)) lastEventOf.delete(paneId);
      for (const paneId of [...heard.keys()]) if (!paneIds.includes(paneId) && (lastEventOf.get(paneId) ?? 0) <= askedAt) heard.delete(paneId);
      for (const [paneId, seq] of actedOn) if (seq <= askedAt && !paneIds.includes(paneId)) actedOn.delete(paneId);
      for (const [paneId, seq] of focusedAt) if (seq <= askedAt && !paneIds.includes(paneId)) focusedAt.delete(paneId);
      if (sameSet) return;
      closeStatusSubscription();
      openStatusSubscription(paneIds);
      // no pane left to listen for: nothing can have been missed
      if (paneIds.length === 0) gap = false;
    } catch {
      if (resync !== null && resyncFor === null) resyncFor = resync;
      if (replay !== null && replayFor === null) replayFor = replay;
      // a gap with a snapshot that fails in it is no short one any more: nobody knows what
      // was missed, and it is corrected without alerts like any lost stretch
      if (gap && !recovering) {
        recovering = true;
        replayFor = null;
        if (statusStarted) resyncFor = statusGeneration;
      }
      /* herdr unreachable or slow: retry shortly instead of waiting for the backstop */
      if (!stopped && reconcileTimer === null) {
        reconcileTimer = setTimeout(() => {
          reconcileTimer = null;
          void reconcile();
        }, deps.snapshotRetryMs);
      }
    } finally {
      reconciling = false;
      if (reconcilePending && !stopped) {
        reconcilePending = false;
        void reconcile();
      }
    }
  }

  function scheduleReconcile(): void {
    if (stopped || reconcileTimer !== null) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      void reconcile();
    }, deps.debounceMs);
  }

  lifecycleSubscription = resilientSubscription(
    deps,
    [...STRUCTURE_SUBSCRIPTIONS],
    (frame) => {
      const parsed = parseStructureFrame(frame);
      if (!parsed) return;
      if (parsed.kind === "pane-ended") {
        // a snapshot already on its way still holds the pane: it is no news of it
        actedOn.set(parsed.paneId, ++statusEvents);
        heard.delete(parsed.paneId);
        handlers.onPaneEnded(parsed.paneId);
      }
      else {
        // closed with no exit frame: a snapshot on its way that still holds the pane is no news of it either
        if (parsed.closed !== undefined) {
          actedOn.set(parsed.closed, ++statusEvents);
          heard.delete(parsed.closed);
        }
        handlers.onStructureChange();
        if (parsed.created) handlers.onPaneCreated?.(parsed.created);
        scheduleReconcile();
      }
    },
    // panes created or closed meanwhile were not heard of: learn them from a snapshot
    () => {
      handlers.onStructureChange();
      void reconcile();
    },
    () => stopped,
  );

  // Its own connection: a focus type an older herdr refuses must not cost pane exits.
  const onFocus = handlers.onFocus;
  if (onFocus !== undefined) {
    focusSubscription = resilientSubscription(
      deps,
      [{ type: "pane.focused" }],
      (frame) => {
        const paneId = parseFocusFrame(frame);
        if (paneId === null) return;
        focusedAt.set(paneId, ++statusEvents);
        // a finish seen at herdr's terminal is no measure for a later snapshot. Work still going on is:
        // its finish in a gap after this is news
        const told = heard.get(paneId);
        if (told !== undefined && told.status !== "working" && told.status !== "blocked") heard.delete(paneId);
        onFocus(paneId);
      },
      // a focus change missed meanwhile is gone for good: the next one is heard again
      () => {},
      () => stopped,
    );
  }

  void reconcile();
  backstopTimer = setInterval(() => void reconcile(), deps.backstopMs);

  return {
    stop() {
      stopped = true;
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      if (backstopTimer !== null) clearInterval(backstopTimer);
      lifecycleSubscription?.close();
      focusSubscription?.close();
      closeStatusSubscription();
    },
  };
}
