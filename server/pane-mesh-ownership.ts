import { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface TaskOwner {
  backend: string;
  serverId: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  agentSession: { agent: string; kind: string; source: string; value: string };
}
export interface TaskScope { kind: "file" | "directory"; path: string; fileIdentity?: string }
function caseInsensitive(path: string): boolean {
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  for (let cursor = existing; dirname(cursor) !== cursor; cursor = dirname(cursor)) {
    const name = cursor.slice(dirname(cursor).length + 1);
    if (!/[a-zA-Z]/.test(name)) continue;
    const alternate = name.replace(/[a-zA-Z]/, (letter) => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
    const alias = join(dirname(cursor), alternate);
    if (!existsSync(alias)) return false;
    const a = statSync(cursor); const b = statSync(alias);
    return a.dev === b.dev && a.ino === b.ino;
  }
  fail("unknown_filesystem_case");
}
function comparePath(path: string): string { return caseInsensitive(path) ? path.normalize("NFD").toLowerCase() : path; }
export interface TaskRecord {
  project: string; taskId: string; owner: TaskOwner; scopes: readonly TaskScope[];
  status: "active" | "completed" | "released";
  claimedAt: number; heartbeatAt: number; expiresAt: number; completedAt: number | null;
  stale: boolean;
}
/** Only adapters which check live native metadata may supply this verification. */
export type IdentityVerifier = (owner: TaskOwner) => boolean | Promise<boolean>;
const verified = new WeakSet<object>();
export type VerifiedTaskOwner = TaskOwner & { readonly __verifiedOwner: unique symbol };

export class OwnershipError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OwnershipError"; }
}
function fail(code: string): never { throw new OwnershipError(code); }
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
}
function ownerKey(owner: TaskOwner): string {
  if (!owner || ![owner.backend, owner.serverId, owner.workspaceId, owner.tabId, owner.paneId, owner.terminalId].every(text)) fail("unknown_identity");
  const session = owner.agentSession;
  if (!session || ![session.agent, session.kind, session.source, session.value].every(text)) fail("unknown_identity");
  // Placement is informational: native moves change workspace/tab/pane, not the terminal's owner.
  return JSON.stringify([owner.backend, owner.serverId, owner.terminalId,
    session.agent, session.kind, session.source, session.value]);
}
export async function verifyTaskOwner(owner: TaskOwner, verifier: IdentityVerifier): Promise<VerifiedTaskOwner> {
  ownerKey(owner);
  const copy = Object.freeze({ ...owner, agentSession: Object.freeze({ ...owner.agentSession }) });
  if (!(await verifier(copy))) fail("unknown_identity");
  verified.add(copy);
  return copy as VerifiedTaskOwner;
}
function requireOwner(owner: VerifiedTaskOwner): string {
  if (!verified.has(owner)) fail("unknown_identity");
  return ownerKey(owner);
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function exactPath(path: string): void {
  if (!text(path) || /[*?\[\]{}\\]/.test(path) || path.split(/[\/]/).includes("..")) fail("invalid_scope");
}
export function canonicalProject(root: string): string {
  exactPath(root);
  const canonical = realpathSync(root);
  if (!statSync(canonical).isDirectory()) fail("invalid_project");
  return canonical;
}
export function canonicalScope(project: string, scope: TaskScope): TaskScope {
  if (!scope || !["file", "directory"].includes(scope.kind)) fail("invalid_scope");
  exactPath(scope.path);
  const candidate = resolve(project, scope.path);
  if (!inside(project, candidate)) fail("scope_escape");
  // Resolve every existing ancestor. Missing leaf paths are allowed for new files.
  const canonicalize = (path: string): string => {
    try { return realpathSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink must not be treated as a missing file.
      try { if (lstatSync(path).isSymbolicLink()) fail("invalid_symlink"); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (dirname(path) === path) fail("invalid_scope");
      return join(canonicalize(dirname(path)), path.slice(dirname(path).length + 1));
    }
  };
  const path = canonicalize(candidate);
  if (!inside(project, path)) fail("symlink_escape");
  if (existsSync(path)) {
    const info = statSync(path);
    if (scope.kind === "directory" ? !info.isDirectory() : !info.isFile()) fail("scope_kind_mismatch");
  }
  const info = scope.kind === "file" && existsSync(path) ? statSync(path) : null;
  return { kind: scope.kind, path, ...(info ? { fileIdentity: `${info.dev}:${info.ino}` } : {}) };
}
export function scopesOverlap(a: TaskScope, b: TaskScope): boolean {
  if (a.fileIdentity && b.fileIdentity && a.fileIdentity === b.fileIdentity) return true;
  // Also check current inode, including hardlinks created after the original claim.
  if (a.kind === "file" && b.kind === "file" && existsSync(a.path) && existsSync(b.path)) {
    const x = statSync(a.path); const y = statSync(b.path);
    if (x.dev === y.dev && x.ino === y.ino) return true;
  }
  const x = comparePath(a.path); const y = comparePath(b.path);
  return x === y || (a.kind === "directory" && inside(x, y)) || (b.kind === "directory" && inside(y, x));
}

export function defaultOwnershipStateDir(): string {
  return join(process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? homedir(), ".local", "state"), "termweave-pane-mesh");
}
/** State must not be tracked by Git, symlinked, shared, or owned by another uid. */
export function protectOwnershipState(directory: string): string {
  if (!isAbsolute(directory)) fail("unsafe_state");
  const path = resolve(directory);
  for (let cursor = path; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      const tracked = spawnSync("git", ["-C", cursor, "ls-files", "--", path], { encoding: "buffer" });
      if (tracked.status !== 0 || tracked.stdout.length > 0) fail("state_in_git");
    }
    try { if (lstatSync(cursor).isSymbolicLink()) fail("unsafe_state"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(cursor) === cursor) break;
  }
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) fail("unsafe_state");
  return realpathSync(path);
}
export function assertPrivateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) fail("unsafe_state");
}
function checkDatabaseHeader(path: string): void {
  const info = statSync(path);
  if (info.size < 100) fail("state_recovery_required");
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    if (readSync(fd, header, 0, 16, 0) !== 16 || header.toString() !== "SQLite format 3\x00") fail("state_recovery_required");
  } finally { closeSync(fd); }
}
interface Row {
  project: string; task_id: string; owner: string; owner_key: string; token: string; scopes: string;
  status: string; claimed_at: number; heartbeat_at: number; expires_at: number; completed_at: number | null;
}
const SCHEMA = `CREATE TABLE tasks (
  project TEXT NOT NULL, task_id TEXT NOT NULL, owner TEXT NOT NULL, owner_key TEXT NOT NULL,
  token TEXT NOT NULL, scopes TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','completed','released')),
  claimed_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, completed_at INTEGER,
  PRIMARY KEY(project, task_id)
) STRICT; PRAGMA user_version=1;`;

/** Advisory coordination only: arbitrary shell writes are not intercepted. Expiry never transfers ownership. */
export class PaneMeshOwnership {
  private readonly db: Database;
  private readonly clock: () => number;
  private readonly statePath: string;
  private readonly stateIdentity: string;
  private ready = false;
  constructor(options: { stateDir?: string; busyTimeoutMs?: number; clock?: () => number } = {}) {
    const requestedDirectory = options.stateDir ?? defaultOwnershipStateDir();
    const sentinel = `${requestedDirectory}.initialized`;
    if (existsSync(sentinel)) {
      assertPrivateFile(sentinel);
      if (readFileSync(sentinel, "utf8") !== "pane-mesh-ownership-v1\n") fail("malformed_state");
      if (!existsSync(join(requestedDirectory, "ownership.sqlite"))) fail("state_recovery_required");
    }
    const directory = protectOwnershipState(requestedDirectory);
    const path = join(directory, "ownership.sqlite");
    const timeout = options.busyTimeoutMs ?? 3000;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30000) fail("invalid_timeout");
    const marker = join(directory, "initialized");
    if (existsSync(marker)) {
      assertPrivateFile(marker);
      if (!existsSync(path)) fail("state_recovery_required");
    }
    try { const fd = openSync(path, "wx", 0o600); closeSync(fd); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try { writeFileSync(sentinel, "pane-mesh-ownership-v1\n", { flag: "wx", mode: 0o600 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    assertPrivateFile(sentinel);
    this.statePath = path;
    const stateInfo = lstatSync(path);
    this.stateIdentity = JSON.stringify([stateInfo.dev, stateInfo.ino, stateInfo.birthtimeMs]);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) if (existsSync(path + suffix)) assertPrivateFile(path + suffix);
    const initialized = existsSync(marker) && statSync(path).size > 0;
    if (existsSync(sentinel) && statSync(path).size === 0 && existsSync(marker)) {
      // A zero-byte file is only valid in the first initialization race. The marker is
      // written after schema commit below, never before.
      fail("state_recovery_required");
    }
    if (initialized) checkDatabaseHeader(path);
    this.db = new Database(path, { strict: true, create: false });
    this.clock = options.clock ?? Date.now;
    try {
      this.db.exec(`PRAGMA busy_timeout=${timeout}; PRAGMA foreign_keys=ON;`);
      this.transaction(() => {
        const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
        const tables = this.db.query("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { name: string }[];
        if (version === 0 && tables.length === 0 && !initialized) this.db.exec(SCHEMA);
        else if (version !== 1 || tables.length !== 1 || tables[0]?.name !== "tasks") fail("malformed_state");
        const definition = this.db.query("SELECT sql FROM sqlite_master WHERE name='tasks'").get() as { sql: string };
        const expected = SCHEMA.slice(0, SCHEMA.indexOf(";"));
        if (definition.sql !== expected) fail("malformed_state");
        const integrity = this.db.query("PRAGMA quick_check").get() as { quick_check: string };
        if (integrity.quick_check !== "ok") fail("malformed_state");
        this.readRows();
      });
      this.ready = true;
      try { writeFileSync(marker, "pane-mesh-ownership-v1\n", { flag: "wx", mode: 0o600 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    let begun = false;
    try {
      if (!existsSync(this.statePath)) fail("state_recovery_required");
      assertPrivateFile(this.statePath);
      const info = lstatSync(this.statePath);
      if (JSON.stringify([info.dev, info.ino, info.birthtimeMs]) !== this.stateIdentity) fail("state_recovery_required");
      if (this.ready) checkDatabaseHeader(this.statePath);
      this.db.exec("BEGIN IMMEDIATE"); begun = true;
      const result = fn(); this.db.exec("COMMIT"); return result;
    } catch (error) {
      if (begun) this.db.exec("ROLLBACK");
      if (error instanceof OwnershipError) throw error;
      if (/locked|busy/i.test(String(error))) fail("database_busy");
      fail("malformed_state");
    }
  }
  private record(row: Row): TaskRecord {
    try {
      const owner = JSON.parse(row.owner) as TaskOwner;
      const scopes = JSON.parse(row.scopes) as TaskScope[];
      if (!text(row.project) || !isAbsolute(row.project) || !text(row.task_id) || ownerKey(owner) !== row.owner_key ||
        !/^[a-f0-9]{64}$/.test(row.token) || !["active", "completed", "released"].includes(row.status) ||
        !Array.isArray(scopes) || !scopes.length || scopes.some((scope) => !scope || !["file", "directory"].includes(scope.kind) || !text(scope.path) || !isAbsolute(scope.path) || !inside(row.project, scope.path)) ||
        ![row.claimed_at, row.heartbeat_at, row.expires_at].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        row.heartbeat_at < row.claimed_at || row.expires_at <= row.heartbeat_at ||
        (row.status === "completed" ? !Number.isSafeInteger(row.completed_at) || row.completed_at! < row.claimed_at : row.completed_at !== null)) fail("malformed_state");
      for (const scope of scopes) {
        exactPath(scope.path);
        if (resolve(scope.path) !== scope.path || (scope.fileIdentity !== undefined &&
          (scope.kind !== "file" || typeof scope.fileIdentity !== "string" || !/^\d+:\d+$/.test(scope.fileIdentity)))) fail("malformed_state");
      }
      return { project: row.project, taskId: row.task_id, owner, scopes, status: row.status as TaskRecord["status"],
        claimedAt: row.claimed_at, heartbeatAt: row.heartbeat_at, expiresAt: row.expires_at, completedAt: row.completed_at,
        stale: row.status === "active" && row.expires_at <= this.clock() };
    } catch { fail("malformed_state"); }
  }
  private readRows(): Row[] {
    const rows = this.db.query("SELECT * FROM tasks").all() as Row[];
    const records = rows.map((row) => this.record(row));
    if (records.some((a, index) => a.status === "active" && records.slice(index + 1).some((b) =>
      b.status === "active" && a.scopes.some((x) => b.scopes.some((y) => scopesOverlap(x, y)))))) fail("malformed_state");
    return rows;
  }
  list(projectRoot: string): TaskRecord[] {
    const project = canonicalProject(projectRoot);
    return this.transaction(() => this.readRows().filter((row) => row.project === project).map((row) => this.record(row)));
  }
  claim(input: { projectRoot: string; taskId: string; scopes: readonly TaskScope[]; owner: VerifiedTaskOwner; ttlMs?: number }): { record: TaskRecord; token: string } {
    const key = requireOwner(input.owner);
    if (!text(input.taskId) || input.taskId.length > 256 || !Array.isArray(input.scopes) || !input.scopes.length || input.scopes.length > 256) fail("invalid_claim");
    const ttl = this.ttl(input.ttlMs);
    return this.transaction(() => {
      const project = canonicalProject(input.projectRoot);
      if (inside(project, this.statePath)) fail("state_in_project");
      const scopes = input.scopes.map((scope) => canonicalScope(project, scope));
      const rows = this.readRows();
      const previous = rows.find((row) => row.project === project && row.task_id === input.taskId);
      if (previous?.status === "completed") fail("task_completed");
      if (previous?.status === "active") fail("task_conflict");
      if (rows.some((row) => row.status === "active" && this.record(row).scopes.some((held) => scopes.some((scope) => scopesOverlap(held, scope))))) fail("scope_conflict");
      const now = this.clock();
      const token = randomBytes(32).toString("hex");
      this.db.query(`INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)
        ON CONFLICT(project,task_id) DO UPDATE SET owner=excluded.owner, owner_key=excluded.owner_key, token=excluded.token,
        scopes=excluded.scopes, status='active', claimed_at=excluded.claimed_at, heartbeat_at=excluded.heartbeat_at,
        expires_at=excluded.expires_at, completed_at=NULL`).run(project, input.taskId, JSON.stringify(input.owner), key, token, JSON.stringify(scopes), now, now, now + ttl);
      const row = this.db.query("SELECT * FROM tasks WHERE project=? AND task_id=?").get(project, input.taskId) as Row;
      return { record: this.record(row), token };
    });
  }
  private ttl(value = 60000): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 86400000) fail("invalid_ttl");
    return value;
  }
  mutate(action: "heartbeat" | "complete" | "release", input: { projectRoot: string; taskId: string; owner: VerifiedTaskOwner; token: string; ttlMs?: number }): TaskRecord {
    if (!["heartbeat", "complete", "release"].includes(action)) fail("invalid_action");
    const key = requireOwner(input.owner);
    if (!text(input.taskId) || typeof input.token !== "string" || !/^[a-f0-9]{64}$/.test(input.token)) fail("owner_mismatch");
    const project = canonicalProject(input.projectRoot);
    const ttl = this.ttl(input.ttlMs);
    return this.transaction(() => {
      this.readRows();
      const row = this.db.query("SELECT * FROM tasks WHERE project=? AND task_id=?").get(project, input.taskId) as Row | null;
      if (!row || row.owner_key !== key || !timingSafeEqual(Buffer.from(row.token), Buffer.from(input.token))) fail("owner_mismatch");
      if (row.status !== "active") fail(row.status === "completed" ? "task_completed" : "task_released");
      const now = Math.max(this.clock(), row.heartbeat_at);
      this.db.query("UPDATE tasks SET owner=? WHERE project=? AND task_id=?").run(JSON.stringify(input.owner), project, input.taskId);
      if (action === "heartbeat") this.db.query("UPDATE tasks SET heartbeat_at=?, expires_at=? WHERE project=? AND task_id=?").run(now, now + ttl, project, input.taskId);
      else this.db.query("UPDATE tasks SET status=?, completed_at=? WHERE project=? AND task_id=?").run(action === "complete" ? "completed" : "released", action === "complete" ? now : null, project, input.taskId);
      return this.record(this.db.query("SELECT * FROM tasks WHERE project=? AND task_id=?").get(project, input.taskId) as Row);
    });
  }
}
