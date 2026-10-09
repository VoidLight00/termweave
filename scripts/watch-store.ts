import type { Candidate, WatchState } from './watch-upstreams.ts';
import { candidateBody } from './watch-upstreams.ts';

export type DurableState = { schema: 1; observation: WatchState; completed: string[]; pending: Candidate[]; uncertain?: string[]; lease?: { owner: string; until: number } };
export interface WatchStore {
  read(): Promise<{ state: DurableState; version: string } | null>;
  compareAndSet(version: string | null, state: DurableState): Promise<string>;
  issueExists(key: string): Promise<boolean>;
  createIssue(candidate: Candidate, body: string): Promise<void>;
}
export function emptyDurableState(): DurableState { return { schema: 1, observation: { schema: 1, upstreams: {} }, completed: [], pending: [] }; }
export function parseDurableState(value: unknown): DurableState {
  const state = value as DurableState;
  if (!state || state.schema !== 1 || state.observation?.schema !== 1 || !Array.isArray(state.completed) || !Array.isArray(state.pending)) throw new Error('Invalid durable watcher state');
  if (state.completed.length > 5000 || state.pending.length > 500 || JSON.stringify(state).length > 1_048_576) throw new Error('Durable state exceeds bound');
  for (const candidate of state.pending) candidateBody(candidate);
  if (state.lease && (typeof state.lease.owner !== 'string' || !Number.isFinite(state.lease.until))) throw new Error('Invalid watcher lease');
  return state;
}
/** CAS lease serializes writers. Uncertain issue writes remain pending; never blindly retry POST. */
export async function publishCandidates(store: WatchStore, observation: WatchState, candidates: Candidate[], owner: string, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(owner)) throw new Error('Invalid writer identity');
  const restored = await store.read();
  const original = restored?.state ?? emptyDurableState();
  if (original.lease && original.lease.until > now && original.lease.owner !== owner) throw new Error('Watcher writer lease is active');
  const pending = [...original.pending];
  for (const candidate of candidates) if (!original.completed.includes(candidate.key) && !pending.some(item => item.key === candidate.key)) pending.push(candidate);
  const state: DurableState = { ...original, observation, pending, lease: { owner, until: now + 600_000 } };
  let version = await store.compareAndSet(restored?.version ?? null, state);
  const errors: string[] = [];
  try {
    for (const candidate of [...state.pending]) {
      try {
        const latest = await store.read();
        if (!latest || latest.version !== version || latest.state.lease?.owner !== owner || latest.state.lease.until <= Date.now()) throw new Error('Writer lease expired or displaced');
        if (!(await store.issueExists(candidate.key))) {
          if (state.uncertain?.includes(candidate.key)) throw new Error('Uncertain issue write requires reconciliation or explicit resolution');
          const beforePost = await store.read();
          if (!beforePost || beforePost.version !== version || beforePost.state.lease?.owner !== owner || beforePost.state.lease.until <= Date.now()) throw new Error('Writer lease expired or displaced');
          state.uncertain = [...new Set([...(state.uncertain ?? []), candidate.key])];
          version = await store.compareAndSet(version, state);
          const fenced = await store.read();
          if (!fenced || fenced.version !== version || fenced.state.lease?.owner !== owner || fenced.state.lease.until <= Date.now()) throw new Error('Writer lease expired or displaced after CAS');
          await store.createIssue(candidate, candidateBody(candidate));
        }
        // Confirm through open+closed issues, including after a successful POST.
        if (!(await store.issueExists(candidate.key))) throw new Error('Issue write unconfirmed');
        const completedLease = await store.read();
        if (!completedLease || completedLease.version !== version || completedLease.state.lease?.owner !== owner || completedLease.state.lease.until <= Date.now()) throw new Error('Stale writer cannot complete state');
        state.uncertain = (state.uncertain ?? []).filter(key => key !== candidate.key);
        state.completed = [...new Set([...state.completed, candidate.key])]; state.pending = state.pending.filter(item => item.key !== candidate.key);
        version = await store.compareAndSet(version, state);
      } catch (error) { errors.push(`${candidate.key}: ${String(error).slice(0,200)}`); break; }
    }
  } finally {
    const finalLease = await store.read();
    if (finalLease && finalLease.version === version && finalLease.state.lease?.owner === owner && finalLease.state.lease.until > Date.now()) {
      delete state.lease;
      version = await store.compareAndSet(version, state);
    }
  }
  return { version, state, errors, restored: restored !== null };
}
