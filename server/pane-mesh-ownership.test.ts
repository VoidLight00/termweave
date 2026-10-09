import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOwnershipStateDir, PaneMeshOwnership, verifyTaskOwner, type TaskOwner, type TaskScope, type VerifiedTaskOwner } from "./pane-mesh-ownership.ts";

let root: string; let project: string; let stateDir: string; let owner: VerifiedTaskOwner; let other: VerifiedTaskOwner;
let stores: PaneMeshOwnership[] = [];
const raw = (workspaceId = "w1"): TaskOwner => ({ backend: "fixture", serverId: "server-1", workspaceId,
  tabId: "t1", paneId: "w1:p1", terminalId: "term-1", agentSession: { agent: "claude", kind: "id", source: "native", value: "session-1" } });
const file = (path: string): TaskScope => ({ kind: "file", path });
const dir = (path: string): TaskScope => ({ kind: "directory", path });
function store(options: { clock?: () => number; busyTimeoutMs?: number } = {}) {
  const result = new PaneMeshOwnership({ stateDir, ...options }); stores = [...stores, result]; return result;
}
function claim(db: PaneMeshOwnership, taskId: string, scopes: TaskScope[], who = owner) { return db.claim({ projectRoot: project, taskId, scopes, owner: who }); }
function mutate(db: PaneMeshOwnership, action: "heartbeat" | "complete" | "release", taskId: string, token: string, who = owner) {
  return db.mutate(action, { projectRoot: project, taskId, token, owner: who });
}
beforeEach(async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "mesh-ownership-test-"));
  project = join(root, "project"); stateDir = join(root, "state");
  mkdirSync(project); mkdirSync(join(project, "src")); writeFileSync(join(project, "src", "a.ts"), "");
  owner = await verifyTaskOwner(raw(), () => true); other = await verifyTaskOwner(raw("w2"), () => true);
});
afterEach(() => { for (const db of stores) db.close(); stores = []; rmSync(root, { recursive: true, force: true }); });

describe("atomic task ownership", () => {
  test("task ID is exclusive across workspaces; disjoint scopes can coexist", () => {
    const db = store(); claim(db, "one", [file("src/a.ts")]);
    expect(() => claim(db, "one", [file("src/b.ts")], other)).toThrow("task_conflict");
    claim(db, "two", [file("src/b.ts")], other);
    expect(db.list(project)).toHaveLength(2);
  });
  test("directory descendants conflict, sibling prefixes do not", () => {
    const db = store(); claim(db, "one", [dir("src")]);
    expect(() => claim(db, "two", [file("src/deep/new.ts")], other)).toThrow("scope_conflict");
    claim(db, "three", [file("src-other/new.ts")], other);
    expect(db.list(project)).toHaveLength(2);
  });
  test("parent directory conflicts with an existing descendant file", () => {
    const db = store(); claim(db, "one", [file("src/a.ts")]);
    expect(() => claim(db, "two", [dir("src")], other)).toThrow("scope_conflict");
  });
  test("a later conflicting scope leaves neither task nor earlier scope claimed", () => {
    const db = store(); claim(db, "held", [file("src/a.ts")]);
    expect(() => claim(db, "failed", [file("src/free.ts"), file("src/a.ts")], other)).toThrow("scope_conflict");
    expect(db.list(project).map((r) => r.taskId)).toEqual(["held"]);
    claim(db, "free", [file("src/free.ts")], other);
  });
  test("owner and token both match for every mutation", async () => {
    const db = store(); const held = claim(db, "one", [file("src/a.ts")]);
    const variants: TaskOwner[] = [ { ...raw(), backend: "other" }, { ...raw(), serverId: "server-2" },
      { ...raw(), terminalId: "term-2" },
      { ...raw(), agentSession: { ...raw().agentSession, value: "session-2" } } ];
    for (const variant of variants) {
      const wrong = await verifyTaskOwner(variant, () => true);
      for (const action of ["heartbeat", "complete", "release"] as const) expect(() => mutate(db, action, "one", held.token, wrong)).toThrow("owner_mismatch");
    }
    for (const action of ["heartbeat", "complete", "release"] as const) expect(() => mutate(db, action, "one", "0".repeat(64))).toThrow("owner_mismatch");
    expect(mutate(db, "heartbeat", "one", held.token).status).toBe("active");
  });
  test("native moves preserve ownership; reused routing and replacement sessions cannot release", async () => {
    const db = store(); const held = claim(db, "one", [file("src/a.ts")]);
    const moved = await verifyTaskOwner({ ...raw(), workspaceId: "w2", tabId: "t2", paneId: "w2:p9" }, () => true);
    expect(mutate(db, "heartbeat", "one", held.token, moved).owner.paneId).toBe("w2:p9");
    const reused = await verifyTaskOwner({ ...raw(), terminalId: "replacement-terminal" }, () => true);
    expect(() => mutate(db, "release", "one", held.token, reused)).toThrow("owner_mismatch");
    const replacement = await verifyTaskOwner({ ...moved, agentSession: { ...moved.agentSession, value: "new-session" } }, () => true);
    expect(() => mutate(db, "release", "one", held.token, replacement)).toThrow("owner_mismatch");
    expect(mutate(db, "release", "one", held.token, moved).status).toBe("released");
  });
  test("completed record is retained, ID cannot reopen, scopes become free", () => {
    const db = store(); const held = claim(db, "one", [file("src/a.ts")]);
    mutate(db, "complete", "one", held.token);
    expect(() => claim(db, "one", [file("src/b.ts")])).toThrow("task_completed");
    expect(() => mutate(db, "release", "one", held.token)).toThrow("task_completed");
    claim(db, "two", [file("src/a.ts")], other);
    expect(db.list(project).find((r) => r.taskId === "one")?.completedAt).not.toBeNull();
    expect(JSON.stringify(db.list(project))).not.toContain(held.token);
  });
  test("expired ownership stays exclusive; only original owner can revive or release", () => {
    let now = 100; const db = store({ clock: () => now });
    const held = db.claim({ projectRoot: project, taskId: "one", scopes: [file("src/a.ts")], owner, ttlMs: 5 });
    now = 110; expect(db.list(project)[0]?.stale).toBe(true);
    expect(() => claim(db, "one", [file("src/b.ts")], other)).toThrow("task_conflict");
    expect(() => claim(db, "two", [file("src/a.ts")], other)).toThrow("scope_conflict");
    expect(mutate(db, "heartbeat", "one", held.token).stale).toBe(false);
    mutate(db, "release", "one", held.token); const next = claim(db, "one", [file("src/a.ts")], other);
    expect(next.token).not.toBe(held.token);
    expect(() => mutate(db, "release", "one", held.token)).toThrow("owner_mismatch");
  });
  test("canonical project and internal symlink aliases share conflicts", () => {
    symlinkSync(project, join(root, "alias")); symlinkSync(join(project, "src"), join(project, "alias-src"));
    const db = store(); claim(db, "one", [file("alias-src/a.ts")]);
    expect(() => db.claim({ projectRoot: join(root, "alias"), taskId: "two", scopes: [file("src/a.ts")], owner: other })).toThrow("scope_conflict");
  });
  test("reject traversal, glob ambiguity, symlink escape and dangling links", () => {
    symlinkSync(root, join(project, "escape")); symlinkSync(join(root, "missing"), join(project, "dangling"));
    const db = store();
    for (const path of ["../outside", "src/../a.ts", "src/*.ts", "src/a?.ts", "src/[ab].ts", "src/{a,b}.ts", "escape/new.ts", "dangling/new.ts"]) {
      expect(() => claim(db, "bad", [file(path)])).toThrow();
    }
    expect(db.list(project)).toHaveLength(0);
  });
  test("reject unknown identity and invalid claims without writes", async () => {
    const db = store();
    expect(() => claim(db, "one", [file("src/a.ts")], raw() as VerifiedTaskOwner)).toThrow("unknown_identity");
    await expect(verifyTaskOwner(raw(), () => false)).rejects.toThrow("unknown_identity");
    await expect(verifyTaskOwner({ ...raw(), terminalId: "" }, () => true)).rejects.toThrow("unknown_identity");
    expect(() => claim(db, "one", [])).toThrow("invalid_claim");
    expect(() => db.claim({ projectRoot: project, taskId: "one", scopes: [file("src/a.ts")], owner, ttlMs: NaN })).toThrow("invalid_ttl");
  });
  test("reject malformed state and insecure state location", () => {
    const db = store(); claim(db, "one", [file("src/a.ts")]);
    const corrupt = new Database(join(stateDir, "ownership.sqlite"));
    corrupt.query("UPDATE tasks SET scopes='not-json'").run(); corrupt.close();
    expect(() => db.list(project)).toThrow("malformed_state");
    expect(() => new PaneMeshOwnership({ stateDir })).toThrow("malformed_state");
    mkdirSync(join(project, ".git")); expect(() => new PaneMeshOwnership({ stateDir: join(project, "state") })).toThrow("state_in_git");
    const shared = join(root, "shared"); mkdirSync(shared); chmodSync(shared, 0o755);
    expect(() => new PaneMeshOwnership({ stateDir: shared })).toThrow("unsafe_state");
    symlinkSync(stateDir, join(root, "link-state")); expect(() => new PaneMeshOwnership({ stateDir: join(root, "link-state") })).toThrow("unsafe_state");
  });
});

test("nested project roots cannot partition absolute file ownership", () => {
  const db = store(); claim(db, "one", [file("src/a.ts")]);
  expect(() => db.claim({ projectRoot: join(project, "src"), taskId: "two", scopes: [file("a.ts")], owner: other })).toThrow("scope_conflict");
});
test("hardlink aliases collide by file identity", () => {
  linkSync(join(project, "src/a.ts"), join(project, "alias.ts"));
  const db = store(); claim(db, "one", [file("src/a.ts")]);
  expect(() => claim(db, "two", [file("alias.ts")], other)).toThrow("scope_conflict");
});
test("missing leaf case aliases collide on a case insensitive volume", () => {
  if (!existsSync(join(project, "SRC"))) return;
  const db = store(); claim(db, "one", [file("src/NewFile.ts")]);
  expect(() => claim(db, "two", [file("src/newfile.ts")], other)).toThrow("scope_conflict");
});
test("missing leaf case variants remain distinct on a case sensitive volume", () => {
  if (existsSync(join(project, "SRC"))) return;
  const db = store(); claim(db, "one", [file("src/NewFile.ts")]); claim(db, "two", [file("src/newfile.ts")], other);
  expect(db.list(project)).toHaveLength(2);
});
test("initialized replacement empty database requires recovery", () => {
  const db = store(); claim(db, "one", [file("src/a.ts")]);
  db.close(); stores = stores.filter((candidate) => candidate !== db);
  rmSync(join(stateDir, "ownership.sqlite")); writeFileSync(join(stateDir, "ownership.sqlite"), "", { mode: 0o600 });
  expect(() => new PaneMeshOwnership({ stateDir })).toThrow("state_recovery_required");
});
test("live truncation cannot make an existing connection discard ownership", () => {
  const db = store(); claim(db, "one", [file("src/a.ts")]);
  writeFileSync(join(stateDir, "ownership.sqlite"), "");
  expect(() => claim(db, "two", [file("src/a.ts")], other)).toThrow("state_recovery_required");
});
test("initialized truncated database requires recovery rather than resetting claims", () => {
  const db = store(); claim(db, "one", [file("src/a.ts")]);
  db.close(); stores = stores.filter((candidate) => candidate !== db);
  writeFileSync(join(stateDir, "ownership.sqlite"), "");
  expect(() => new PaneMeshOwnership({ stateDir })).toThrow("state_recovery_required");
});
test("persistent defaults respect isolated HOME and XDG_STATE_HOME", () => {
  const home = process.env.HOME; const xdg = process.env.XDG_STATE_HOME;
  try {
    process.env.HOME = root; delete process.env.XDG_STATE_HOME;
    expect(defaultOwnershipStateDir()).toBe(join(root, ".local", "state", "termweave-pane-mesh"));
    process.env.XDG_STATE_HOME = join(root, "xdg");
    expect(defaultOwnershipStateDir()).toBe(join(root, "xdg", "termweave-pane-mesh"));
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (xdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = xdg;
  }
});
test("untracked state in a home Git tree is allowed but tracked state is rejected", () => {
  expect(Bun.spawnSync(["git", "init", root]).exitCode).toBe(0);
  const db = store(); claim(db, "one", [file("src/a.ts")]);
  expect(Bun.spawnSync(["git", "-C", root, "add", "state/ownership.sqlite"]).exitCode).toBe(0);
  expect(() => new PaneMeshOwnership({ stateDir })).toThrow("state_in_git");
});
test("a malformed schema and inconsistent active overlaps are rejected", () => {
  const db = store(); claim(db, "one", [file("src/a.ts")]); claim(db, "two", [file("src/b.ts")], other);
  const corrupt = new Database(join(stateDir, "ownership.sqlite"));
  corrupt.query("UPDATE tasks SET scopes=? WHERE task_id='two'").run(JSON.stringify([file(join(project, "src/a.ts"))]));
  expect(() => db.list(project)).toThrow("malformed_state");
  corrupt.exec("DROP TABLE tasks; CREATE TABLE tasks(project TEXT)"); corrupt.close();
  expect(() => new PaneMeshOwnership({ stateDir })).toThrow("malformed_state");
});
test("deleting active state requires recovery in existing and new processes", () => {
  const db = store(); const held = claim(db, "one", [file("src/a.ts")]);
  rmSync(stateDir, { recursive: true });
  expect(() => mutate(db, "heartbeat", "one", held.token)).toThrow("state_recovery_required");
  expect(() => new PaneMeshOwnership({ stateDir })).toThrow("state_recovery_required");
});

const modulePath = join(import.meta.dir, "pane-mesh-ownership.ts");
function child(taskId: string, scope: TaskScope, barrier?: string) {
  const code = `import {PaneMeshOwnership,verifyTaskOwner} from ${JSON.stringify(modulePath)};
    const owner=await verifyTaskOwner(${JSON.stringify(raw(taskId))},()=>true);
    ${barrier ? `await Bun.write(${JSON.stringify(barrier + "." + taskId + ".ready")},'ready'); while(!(await Bun.file(${JSON.stringify(barrier)}).exists())) await Bun.sleep(5);` : ""}
    let db; try {db=new PaneMeshOwnership({stateDir:${JSON.stringify(stateDir)}});
      db.claim({projectRoot:${JSON.stringify(project)},taskId:${JSON.stringify(taskId)},owner,scopes:[${JSON.stringify(scope)}]});
      process.stdout.write('claimed'); } catch(e) {process.stdout.write(e.code??'unexpected'); process.exitCode=2;} finally{db?.close();}`;
  return Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe", stderr: "pipe" });
}
async function results(children: ReturnType<typeof child>[]) {
  return Promise.all(children.map(async (process) => ({ code: await process.exited, out: await new Response(process.stdout).text(), err: await new Response(process.stderr).text() })));
}
test("separate processes race for one task: exactly one winner", async () => {
  const outcomes = await results([child("same", file("src/a.ts")), child("same", file("src/b.ts"))]);
  expect(outcomes.map((r) => r.out).sort()).toEqual(["claimed", "task_conflict"]);
  expect(outcomes.every((r) => r.err === "")).toBe(true);
});
test("separate processes race for overlapping directory scopes", async () => {
  const outcomes = await results([child("a", dir("src")), child("b", file("src/a.ts"))]);
  expect(outcomes.map((r) => r.out).sort()).toEqual(["claimed", "scope_conflict"]);
});
test("separate processes claim disjoint scopes", async () => {
  const outcomes = await results([child("a", file("src/a.ts")), child("b", file("src/b.ts"))]);
  expect(outcomes.map((r) => r.code)).toEqual([0, 0]);
});
test("database contention fails closed then recovers without partial writes", async () => {
  store(); const lock = new Database(join(stateDir, "ownership.sqlite"));
  // COMMIT can briefly overlap the contender's schema read. Let this fixture
  // release its write lock without depending on a zero-timeout scheduling race.
  lock.exec("PRAGMA busy_timeout=3000; BEGIN IMMEDIATE");
  try {
    expect(() => new PaneMeshOwnership({ stateDir, busyTimeoutMs: 20 })).toThrow("database_busy");
    const db = stores[0]!;
    // Use a separate process so SQLite's synchronous wait cannot stop the unlock timer.
    const contender = child("busy", file("src/a.ts"));
    await Bun.sleep(100); lock.exec("COMMIT");
    expect((await results([contender]))[0]?.out).toBe("claimed");
    expect(db.list(project)).toHaveLength(1);
  } finally { if (lock.inTransaction) lock.exec("ROLLBACK"); lock.close(); }
});
