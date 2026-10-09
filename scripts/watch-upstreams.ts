import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const UPSTREAMS = [
  { name: 'herdr-web-ui', repository: 'devswha/herdr-web-ui' },
  { name: 'herdr', repository: 'herdrdev/herdr' },
  { name: 'cmux', repository: 'manaflow-ai/cmux' },
] as const;
const SHA = /^[a-f0-9]{40}$/;
const MAX_BYTES = 1_048_576;
export function issueKeys(issues: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const issue of issues) {
    const body = (issue as any)?.body;
    if (typeof body !== 'string' || body.length > MAX_BYTES) continue;
    for (const match of body.matchAll(/<!-- (termweave-upstream:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:(?:release|tag|head):[a-f0-9]{40}) -->/g)) keys.add(match[1]!);
  }
  return keys;
}
export function candidateBody(candidate: Candidate): string {
  if (candidate.key !== candidateKey(candidate.repository, candidate.kind, candidate.targetSHA)) throw new Error('Candidate key mismatch');
  return `<!-- ${candidate.key} -->\nObserved upstream candidate (not approved compatibility).\n\nRepository: ${candidate.repository}\nKind: ${candidate.kind}\nTarget: ${candidate.targetSHA}\nLabel: ${safeLabel(candidate.label)}\n\nManual source/license/security review and isolated regression required. Never auto-merge or deploy.`;
}
export type Observation = { repository: string; observedAt: string; refs: Record<string, string>; status: 'success' | 'stale'; error?: string };
export type WatchState = { schema: 1; upstreams: Record<string, Observation> };
export type Candidate = { key: string; repository: string; kind: 'release' | 'tag' | 'head'; targetSHA: string; label: string };
export function candidateKey(repository: string, kind: Candidate['kind'], targetSHA: string) {
  if (!UPSTREAMS.some(upstream => upstream.repository === repository) || !SHA.test(targetSHA)) throw new Error('Invalid candidate identity');
  return `termweave-upstream:${repository}:${kind}:${targetSHA}`;
}
export function safeLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid metadata label');
  return value.replace(/[<>`]/g, '');
}
export function loadState(path: string): WatchState {
  if (!existsSync(path)) return { schema: 1, upstreams: {} };
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.schema !== 1 || typeof state.upstreams !== 'object' || Array.isArray(state.upstreams)) throw new Error('Invalid watcher state');
  for (const upstream of UPSTREAMS) {
    const value = state.upstreams[upstream.repository];
    if (value && (value.repository !== upstream.repository || typeof value.refs !== 'object' || Object.values(value.refs).some(sha => typeof sha !== 'string' || !SHA.test(sha)))) throw new Error('Invalid observation state');
  }
  return state;
}
export function saveState(path: string, state: WatchState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, path);
}
export class GitHubReader {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly token?: string, private readonly pause = (ms: number) => Bun.sleep(ms)) {}
  async get(path: string): Promise<any> {
    if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\//.test(path) || path.includes('..')) throw new Error('Untrusted API path');
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.fetcher(`https://api.github.com${path}`, { headers: { accept: 'application/vnd.github+json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) { await this.pause(Math.min(2000, 250 * 2 ** attempt)); continue; }
      if (!response.ok) throw new Error(`GitHub metadata HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? 0); if (declared > MAX_BYTES) throw new Error('Oversized metadata');
      const reader = response.body?.getReader(); if (!reader) throw new Error('Missing response body');
      const chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) throw new Error('Oversized metadata'); chunks.push(value); } }
      finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    throw new Error('Bounded retries exhausted');
  }
  async pages(path: string): Promise<any[]> {
    const values: any[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await this.get(`${path}${path.includes('?') ? '&' : '?'}per_page=30&page=${page}`);
      if (!Array.isArray(result)) throw new Error('Expected bounded metadata array');
      values.push(...result); if (result.length < 30) return values;
    }
    throw new Error('Metadata pagination exceeds reviewed bound');
  }
  async resolveRef(repository: string, tag: string): Promise<string> {
    let value = await this.get(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
    for (let depth = 0; depth < 3; depth++) {
      const object = value.object; if (!object || !SHA.test(object.sha)) throw new Error('Invalid Git object');
      if (object.type === 'commit') return object.sha;
      if (object.type !== 'tag') throw new Error('Unexpected Git object type');
      value = await this.get(`/repos/${repository}/git/tags/${object.sha}`);
    }
    throw new Error('Annotated tag depth exceeds bound');
  }
}
export async function watch(reader: GitHubReader, previous: WatchState, existingIssueKeys: Set<string> = new Set(), now = new Date().toISOString()) {
  const next: WatchState = { schema: 1, upstreams: { ...previous.upstreams } }; const candidates: Candidate[] = [];
  for (const upstream of UPSTREAMS) {
    const repository = upstream.repository; const old = previous.upstreams[repository];
    try {
      const refs: Record<string, string> = {};
      const releases = await reader.pages(`/repos/${repository}/releases`);
      const tags = await reader.pages(`/repos/${repository}/tags`);
      const repositoryInfo = await reader.get(`/repos/${repository}/commits/HEAD`);
      if (!SHA.test(repositoryInfo.sha)) throw new Error('Invalid head SHA'); refs.head = repositoryInfo.sha;
      for (const tag of tags) {
        const name = safeLabel(tag.name); refs[`tag:${name}`] = await reader.resolveRef(repository, name);
      }
      for (const release of releases) {
        if (release.draft || release.prerelease) continue;
        const name = safeLabel(release.tag_name); refs[`release:${name}`] = await reader.resolveRef(repository, name);
      }
      next.upstreams[repository] = { repository, refs, observedAt: now, status: 'success' };
      for (const [ref, targetSHA] of Object.entries(refs)) {
        if (old?.refs[ref] === targetSHA) continue;
        const kind = ref.startsWith('release:') ? 'release' : ref.startsWith('tag:') ? 'tag' : 'head';
        const key = candidateKey(repository, kind, targetSHA);
        if (existingIssueKeys.has(key) || candidates.some(candidate => candidate.key === key)) continue;
        candidates.push({ key, repository, kind, targetSHA, label: ref === 'head' ? 'HEAD' : ref.slice(ref.indexOf(':') + 1) });
      }
    } catch (error) {
      next.upstreams[repository] = { repository, refs: old?.refs ?? {}, observedAt: old?.observedAt ?? '', status: 'stale', error: String(error).slice(0, 300) };
    }
  }
  return { state: next, candidates };
}
if (import.meta.main) {
  const path = resolve(process.env.WATCH_STATE_PATH ?? 'evidence/watcher/state.json');
  const existing = process.env.WATCH_ISSUE_KEYS_PATH ? new Set<string>(JSON.parse(readFileSync(process.env.WATCH_ISSUE_KEYS_PATH, 'utf8'))) : new Set<string>();
  let previous = loadState(path);
  if (process.env.WATCH_RESTORE_GITHUB === '1') {
    const { GitHubWatchStore } = await import('./watch-github-store.ts');
    if (!process.env.GITHUB_REPOSITORY || !process.env.GITHUB_TOKEN || !process.env.WATCH_STATE_BRANCH) throw new Error('Missing durable state source');
    const restored = await new GitHubWatchStore(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN, process.env.WATCH_STATE_BRANCH).read();
    previous = restored?.state.observation ?? { schema: 1, upstreams: {} };
  }
  const result = await watch(new GitHubReader(fetch, process.env.GITHUB_TOKEN), previous, existing);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(resolve(dirname(path), 'input.json'), JSON.stringify(result, null, 2));
  saveState(path, result.state);
  const candidatePath = resolve(process.env.WATCH_CANDIDATES_PATH ?? 'evidence/watcher/candidates.json'); mkdirSync(dirname(candidatePath), { recursive: true });
  writeFileSync(candidatePath, JSON.stringify(result.candidates, null, 2));
  console.log(JSON.stringify({ candidates: result.candidates.length, stale: Object.values(result.state.upstreams).filter(value => value.status === 'stale').map(value => value.repository) }));
  if (Object.values(result.state.upstreams).some(value => value.status === 'stale')) process.exitCode = 1;
}
