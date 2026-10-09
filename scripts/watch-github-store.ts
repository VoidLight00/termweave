import { GitHubReader, issueKeys, type Candidate } from './watch-upstreams.ts';
import { parseDurableState, type DurableState, type WatchStore } from './watch-store.ts';

/** Dedicated state-branch file uses GitHub Contents SHA CAS, not expiring artifacts. */
export class GitHubWatchStore implements WatchStore {
  private readonly reader: GitHubReader;
  constructor(private readonly repository: string, private readonly token: string,
    private readonly branch: string, private readonly fetcher: typeof fetch = fetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[A-Za-z0-9_-]{1,80}$/.test(branch)) throw new Error('Invalid durable repository/branch');
    this.reader = new GitHubReader(fetcher, token);
  }
  async read() {
    // A missing state is allowed only on an existing reviewed state branch.
    await this.reader.get(`/repos/${this.repository}/git/ref/heads/${this.branch}`);
    try {
      const value = await this.reader.get(`/repos/${this.repository}/contents/upstream-state.json?ref=${this.branch}`);
      if (value.encoding !== 'base64' || typeof value.content !== 'string' || value.content.length > 1_400_000 || !/^[a-f0-9]{40}$/.test(value.sha)) throw new Error('Invalid durable state object');
      return { state: parseDurableState(JSON.parse(Buffer.from(value.content, 'base64').toString('utf8'))), version: value.sha };
    } catch (error) { if (String(error).includes('HTTP 404')) return null; throw error; }
  }
  private async write(path: string, method: 'POST' | 'PUT', body: unknown) {
    const response = await this.fetcher(`https://api.github.com/repos/${this.repository}/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    // Mutations are never retried: a lost response is an uncertain write.
    if (!response.ok) throw new Error(`GitHub mutation HTTP ${response.status}`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing mutation response');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 1_048_576) throw new Error('Oversized mutation response'); chunks.push(value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async compareAndSet(version: string | null, state: DurableState) {
    parseDurableState(state);
    const result = await this.write('contents/upstream-state.json', 'PUT', { message: 'Record upstream observation state', branch: this.branch,
      content: Buffer.from(JSON.stringify(state)).toString('base64'), ...(version ? { sha: version } : {}) });
    if (!/^[a-f0-9]{40}$/.test(result.content?.sha)) throw new Error('State write unconfirmed');
    return result.content.sha;
  }
  async issueExists(key: string) {
    // state=all includes closed candidates. Exhaustion fails closed, never assumes absence.
    const issues = await this.reader.pages(`/repos/${this.repository}/issues?state=all&sort=created&direction=desc`);
    return issueKeys(issues).has(key);
  }
  async createIssue(candidate: Candidate, body: string) {
    await this.write('issues', 'POST', { title: `Upstream candidate: ${candidate.repository} ${candidate.kind} ${candidate.targetSHA.slice(0,12)}`, body });
  }
}
