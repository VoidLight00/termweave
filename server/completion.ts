import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import { herdrSocketPath } from "./herdr/client.ts";

/**
 * `done` for agents herdr loses track of on the way, and for the pane herdr has focused.
 *
 * herdr reports `done` for an agent that went back to idle while its pane was not being
 * looked at (not focused), and `idle` once it is. It follows the agent it saw working, so
 * an agent recognised from its screen and processes rather than an integration can
 * finish as plain `idle`: an omo pane reads `pi/working`, then `claude/unknown` while
 * omo's claude child runs, then `claude/idle` (live-traced with omo 5.0), and the
 * working agent herdr knew never finished. The sidebar said READY, and no alert came.
 *
 * herdr's focus is also no sign that anyone saw a finish. It is the pane its terminal
 * last had in front, and it stays there while the user works from a browser or a phone,
 * which never move it: an agent finishing in that pane finished as plain `idle`, READY
 * and no alert, whoever was looking.
 *
 * So each pane's "worked since it was last idle" is kept here, and an idle that follows
 * work is reported as `done` until the pane works again or focus moves onto it (`seen`):
 * what herdr itself reports for an agent it did not lose in a pane it has not in front.
 * And the `unknown` in between, while another agent is there, is reported as `working`
 * (omo's whole turn read `claude/unknown` after `pi/working`, and the sidebar showed no RUN).
 *
 * The agent that worked reading `unknown` itself is a finish, not more work: Codex, which
 * herdr follows through its integration, reads `codex/working` for a turn and then
 * `codex/unknown` at rest (live, herdr 0.9.3). Reported as working, every Codex pane that
 * ever worked read RUN for good, and no done alert came.
 *
 * herdr keeps its own `done` across a restart of this server; what is kept here was lost
 * with it, and every omo or gjc pane that had finished read READY again after an update.
 * So the finished panes are kept in a file too, for the herdr they were seen in: a herdr
 * started anew reuses pane ids for other panes, and its socket is then another file. The
 * panes still working are not: what became of them while this server was down (finished,
 * and seen at herdr's terminal?) is unknown, and a DONE nobody needs is an alert too.
 */
export class CompletionTracker {
  /** panes that worked (or were blocked) since they were last idle, done or seen, with the agent that did */
  private readonly worked = new Map<string, string | null>();
  /** panes reported here as `done` while herdr says `idle` or `unknown` */
  private readonly finished = new Map<string, string | null>();
  /** Last reported statuses, and changes that must take precedence over an in-flight snapshot. */
  private readonly reported = new Map<string, AgentStatus>();
  private readonly pending = new Map<number, Map<string, AgentStatus | null>>();
  private order = 0;
  /** what the file holds, so it is written only when that changes */
  private saved = "";

  /**
   * `file` keeps the state across restarts (none: memory only); `herdr` names the herdr
   * the panes live in, the identity of its socket file by default.
   */
  constructor(private readonly file: string | null = null, private readonly herdr: () => string | null = herdrSocketId) {
    if (file === null) return;
    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as { herdr?: unknown; finished?: unknown; finishedAgents?: unknown };
      const current = herdr();
      if (current === null || state.herdr !== current) return;
      const agents = state.finishedAgents && typeof state.finishedAgents === "object" && !Array.isArray(state.finishedAgents)
        ? state.finishedAgents as Record<string, unknown> : {};
      for (const pane of Array.isArray(state.finished) ? state.finished : []) {
        if (typeof pane === "string") this.finished.set(pane, typeof agents[pane] === "string" ? agents[pane] as string : null);
      }
      this.saved = this.serialize(current);
    } catch { /* none yet, or unreadable: start empty */ }
  }

  /** A status change as herdr sent it, to the status to report. */
  observe(paneId: string, status: AgentStatus, agent: string | null = null): AgentStatus {
    const reported = this.settle(paneId, status, agent);
    this.record(paneId, reported, ++this.order);
    this.save();
    return reported;
  }

  /**
   * Focus moved onto a pane: a finish reported here as `done` has been seen and is
   * `idle` again, as herdr does for its own. True when that changed what the pane reads.
   */
  seen(paneId: string): boolean {
    const changed = this.finished.delete(paneId);
    const current = this.reported.get(paneId);
    if (changed || current !== undefined) this.record(paneId, changed ? "idle" : current!, ++this.order);
    if (changed) this.save();
    return changed;
  }

  /**
   * The pane's agent is now known under another name (an OmO pane herdr called `claude` or
   * `pi`): what it worked on and finished stays its own. A finish is matched by identity, and
   * would otherwise be dropped as another agent's. What another agent did in the pane before
   * (Codex, then OmO started in its place) is not OmO's: that is dropped.
   */
  adopt(paneId: string, agent: string, from: readonly string[]): void {
    let kept = false;
    for (const state of [this.finished, this.worked]) {
      if (!state.has(paneId)) continue;
      const was = state.get(paneId) ?? null;
      if (was === null || was === agent || from.includes(was)) { state.set(paneId, agent); kept = true; }
      else state.delete(paneId);
    }
    if (!kept) {
      // nothing of its own to go on from: what the pane was last reported as may be another
      // agent's, in a snapshot still being read too, and its status is settled anew
      this.reported.delete(paneId);
      for (const changes of this.pending.values()) changes.delete(paneId);
    }
    this.save();
  }

  /**
   * A status the collector read back from a snapshot around a gap between subscriptions,
   * no event having said it: is it news? A pane never reported here (the server just
   * started), or reported only from a snapshot taken once its work had ended, first takes
   * what it was before, so a finish after work is a finish. Between
   * two statuses at rest it is news only while the pane is shown as working (`unknown`
   * under another agent's name reads as work going on): herdr reads a finish nobody saw
   * as `done` in one place and `idle` in another, and that difference must not undo a DONE.
   * A change from work to rest is always news, even where a snapshot served to a browser
   * settled it here first: that told no device.
   */
  replayed(paneId: string, status: AgentStatus, before: { before: AgentStatus; agent: string | null }): boolean {
    const busy = (value: AgentStatus): boolean => value === "working" || value === "blocked";
    const shown = this.reported.get(paneId);
    // never reported, or only from a snapshot taken after the work ended: the work it did is not known here yet
    const unseenWork = busy(before.before) && !busy(status) && !this.worked.has(paneId) && !this.finished.has(paneId) && (shown === undefined || !busy(shown));
    if (shown === undefined || unseenWork) {
      this.observe(paneId, before.before, before.agent);
      return true;
    }
    // a finish a browser's snapshot settled first is still one nobody was alerted of: it goes on, and stays DONE
    return busy(shown) || busy(status) || busy(before.before);
  }

  /**
   * Status events were lost for a stretch of unknown length and this snapshot is the truth
   * now (the collector's resync), but for the `newer` panes, which had an event since. Each
   * pane is settled against it without telling anyone, as the alerts are corrected without
   * alerting: work kept from before the loss would otherwise make a finish of the next
   * change the pane shows, long after it ended.
   */
  resync(panes: readonly { pane_id: string; agent_status: AgentStatus; agent?: string | null }[], newer: ReadonlySet<string>): void {
    const live = new Set(panes.map((pane) => pane.pane_id));
    for (const pane of panes) {
      if (newer.has(pane.pane_id)) continue;
      const agent = pane.agent ?? null;
      // at rest now: the work known from before the loss is over, whoever is in the pane. `unknown`
      // under another agent's name would otherwise read as that work still going on
      if (pane.agent_status !== "working" && pane.agent_status !== "blocked" && this.worked.delete(pane.pane_id) && agent !== null) {
        this.finished.set(pane.pane_id, agent);
      }
      this.record(pane.pane_id, this.settle(pane.pane_id, pane.agent_status, agent), ++this.order);
    }
    // a pane that went during the loss: a snapshot still being read must not bring it back
    for (const paneId of new Set([...this.worked.keys(), ...this.finished.keys(), ...this.reported.keys()])) {
      if (!live.has(paneId) && !newer.has(paneId)) this.drop(paneId, ++this.order);
    }
    this.save();
  }

  /** What the pane was last reported as, if it was. */
  current(paneId: string): AgentStatus | undefined {
    return this.reported.get(paneId);
  }

  /** Read an asynchronous snapshot without undoing statuses or focus changes made while it was pending. */
  async readSnapshot(read: () => Promise<SessionSnapshot>, label?: (snapshot: SessionSnapshot) => Promise<SessionSnapshot>): Promise<SessionSnapshot> {
    const order = ++this.order;
    const newer = new Map<string, AgentStatus | null>();
    this.pending.set(order, newer);
    try {
      const raw = await read();
      // Display labels such as omo must not replace the herdr identity used to match a finish.
      return this.project(raw, newer, order, label ? await label(raw) : raw);
    }
    finally { this.pending.delete(order); }
  }

  /** Present a fresh synchronous snapshot. Async readers must use readSnapshot. */
  present(snapshot: SessionSnapshot): SessionSnapshot {
    return this.project(snapshot, new Map(), ++this.order);
  }

  private project(snapshot: SessionSnapshot, newer: Map<string, AgentStatus | null>, order: number, display = snapshot): SessionSnapshot {
    const statuses = new Map<string, AgentStatus>();
    const ended = new Set<string>();
    for (const pane of snapshot.panes) {
      if (newer.has(pane.pane_id) && newer.get(pane.pane_id) === null) {
        ended.add(pane.pane_id);
        continue;
      }
      const status = newer.has(pane.pane_id) ? newer.get(pane.pane_id)!
        : this.settle(pane.pane_id, pane.agent_status, pane.agent ?? null);
      if (!newer.has(pane.pane_id)) this.record(pane.pane_id, status, order);
      if (status !== pane.agent_status) statuses.set(pane.pane_id, status);
    }
    const live = new Set(snapshot.panes.map((pane) => pane.pane_id));
    for (const pane of new Set([...this.worked.keys(), ...this.finished.keys(), ...this.reported.keys()])) {
      if (!live.has(pane) && !newer.has(pane)) this.drop(pane, order);
    }
    this.save();
    if (statuses.size === 0 && ended.size === 0) return display;
    return {
      ...display,
      panes: display.panes.filter((pane) => !ended.has(pane.pane_id)).map((pane) => statuses.has(pane.pane_id) ? { ...pane, agent_status: statuses.get(pane.pane_id)! } : pane),
      agents: display.agents.filter((agent) => !ended.has(agent.pane_id)).map((agent) => statuses.has(agent.pane_id) ? { ...agent, agent_status: statuses.get(agent.pane_id)! } : agent),
    };
  }

  forget(paneId: string): void {
    this.drop(paneId, ++this.order);
    this.save();
  }

  private drop(paneId: string, order: number): void {
    this.worked.delete(paneId);
    this.finished.delete(paneId);
    this.record(paneId, null, order);
  }

  private record(paneId: string, status: AgentStatus | null, order: number): void {
    if (status === null) this.reported.delete(paneId);
    else this.reported.set(paneId, status);
    for (const [requested, changes] of this.pending) if (requested < order) changes.set(paneId, status);
  }

  private serialize(herdr: string): string {
    const finished = [...this.finished.keys()].sort();
    const finishedAgents = Object.fromEntries(finished.filter((pane) => this.finished.get(pane) !== null).map((pane) => [pane, this.finished.get(pane)]));
    return JSON.stringify({ herdr, finished, finishedAgents });
  }

  /** Written whole, and only on a change: a crash mid-write must not leave half a file. */
  private save(): void {
    if (this.file === null) return;
    const herdr = this.herdr();
    if (herdr === null) return;
    const state = this.serialize(herdr);
    if (state === this.saved) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temporary, state, { mode: 0o600 });
      renameSync(temporary, this.file);
      this.saved = state;
    } catch (error) {
      // a full disk costs the state after a restart, never the status itself
      console.error(`completion state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private settle(paneId: string, status: AgentStatus, agent: string | null): AgentStatus {
    if (this.finished.has(paneId)) {
      const finishedAgent = this.finished.get(paneId);
      // Older state files have no identity: retain their idle finishes, but never apply them to unknown agents.
      if (agent === null || (finishedAgent === null ? status !== "idle" : finishedAgent !== agent)) this.finished.delete(paneId);
    }
    switch (status) {
      case "working":
      case "blocked":
        this.worked.set(paneId, agent);
        this.finished.delete(paneId);
        return status;
      case "done":
        this.worked.delete(paneId);
        this.finished.delete(paneId);
        return status;
      case "idle":
        if (this.worked.delete(paneId)) this.finished.set(paneId, agent);
        return this.finished.has(paneId) ? "done" : status;
      default:
        if (this.worked.has(paneId)) {
          // with no agent left, the pane is a shell again
          if (agent === null) {
            this.worked.delete(paneId);
            return status;
          }
          // `unknown` right after work under another identity is the work going on there
          if (this.worked.get(paneId) !== agent) return "working";
          // the agent that worked is at rest: it finished
          this.worked.delete(paneId);
          this.finished.set(paneId, agent);
        }
        return this.finished.has(paneId) && agent !== null ? "done" : status;
    }
  }
}

/** The herdr server this one talks to, as its socket file: a herdr started anew has another. */
function herdrSocketId(): string | null {
  try {
    const stat = statSync(herdrSocketPath());
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}
