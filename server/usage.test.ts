import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageReport } from "../shared/protocol.ts";
import { FRESH_MS, handleUsageRequest, MAX_READ_BYTES, MIN_REFRESH_MS, RETRY_MS, runCommand, USAGE_PROVIDERS, UsageHttpError, UsageService, type KeychainRead, type UsageContext, type UsageProvider } from "./usage.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const HOUR = 3600_000;

function jwt(claims: Record<string, unknown>): string {
  return ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; gate?: Promise<void> };

let home: string;
let now: number;
let replies: Map<string, Reply>;
let requests: Array<{ url: string; init: RequestInit }>;
let keychain: Map<string, KeychainRead>;
let commands: Map<string, string>;

function context(platform: NodeJS.Platform = "linux"): UsageContext {
  return {
    home, platform, env: { USER: "me" },
    now: () => now,
    async fetch(url, init) {
      requests.push({ url, init });
      const reply = replies.get(url);
      if (!reply) throw new Error(`unexpected request ${url}`);
      await reply.gate;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
    },
    keychain: async (service, account) => keychain.get(`${service}|${account ?? ""}`) ?? { status: "missing" },
    run: async (argv) => commands.get(argv.join(" ")) ?? null,
  };
}

function only(id: string) {
  return USAGE_PROVIDERS.filter((provider) => provider.id === id);
}

function write(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";

function signInCodex(exp = NOW / 1000 + HOUR / 1000, dir = ".codex", user = "user-1", email = "me@example.com") {
  write(join(home, dir, "auth.json"), {
    tokens: {
      access_token: jwt({ exp, "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_user_id: `${user}__acct-1` }, "https://api.openai.com/profile": { email } }),
      account_id: "acct-1", refresh_token: "r",
    },
  });
}

function codexReply(used = 77): Reply {
  return {
    body: {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3600 },
        secondary_window: { used_percent: used, limit_window_seconds: 604_800, reset_after_seconds: 7200 },
      },
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "herdr-usage-"));
  now = NOW;
  replies = new Map();
  requests = [];
  keychain = new Map();
  commands = new Map();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("providers", () => {
  it("lists nothing when no CLI is signed in, and asks no one", async () => {
    const report = await new UsageService(context("darwin")).report();
    expect(report).toEqual({ providers: [] });
    expect(requests).toEqual([]);
  });

  it("reads Codex windows with the account header and names them by length", async () => {
    signInCodex();
    replies.set(CODEX_USAGE, codexReply());
    const report = await new UsageService(context(), only("codex")).report();
    expect(report.providers).toEqual([{
      id: "codex", key: "codex:user-1__acct-1", account: "me@example.com", plan: "pro", problem: null, checked_at: new Date(NOW).toISOString(),
      windows: [
        { kind: "session", scope: null, used_percent: 12, resets_at: new Date(NOW + HOUR).toISOString() },
        { kind: "week", scope: null, used_percent: 77, resets_at: new Date(NOW + 2 * HOUR).toISOString() },
      ],
    }]);
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toStartWith("Bearer ");
    expect(headers["chatgpt-account-id"]).toBe("acct-1");
  });

  it("prefers the Claude keychain item on macOS and reads the scoped weekly limits", async () => {
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR, subscriptionType: "max" } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "file", expiresAt: NOW + HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: {
      five_hour: { utilization: 42, resets_at: "2026-09-29T14:00:00.000Z" },
      seven_day: { utilization: 63.44, resets_at: "2026-10-03T00:00:00Z" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 5, resets_at: null },
    } });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    expect(usage!.plan).toBe("max");
    expect(usage!.windows).toEqual([
      { kind: "session", scope: null, used_percent: 42, resets_at: "2026-09-29T14:00:00.000Z" },
      { kind: "week", scope: null, used_percent: 63.4, resets_at: "2026-10-03T00:00:00.000Z" },
      { kind: "week", scope: "Sonnet", used_percent: 5, resets_at: null },
    ]);
  });

  it("reads the Claude credentials file when Claude Code refreshed it but not the keychain item", async () => {
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: NOW - HOUR } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "file", expiresAt: NOW + 8 * HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer file");
    expect(usage!.problem).toBeNull();
  });

  it("keeps the Claude keychain item when the credentials file is older", async () => {
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: NOW + 8 * HOUR } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "old", expiresAt: NOW - HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    await new UsageService(context("darwin"), only("claude")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
  });

  it("reads the later of two unexpired Claude sign-ins, and keeps a keychain item that names no expiry", async () => {
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "file", expiresAt: NOW + 8 * HOUR } });
    await new UsageService(context("darwin"), only("claude")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer file");

    requests.length = 0;
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k" } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "old", expiresAt: NOW - HOUR } });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    expect(usage!.problem).toBeNull();
  });

  it("lists each Codex account once, from ~/.codex and a ~/.codex-* sibling", async () => {
    signInCodex(NOW / 1000 + 3600, ".codex", "user-1", "work@example.com");
    signInCodex(NOW / 1000 + 7200, ".codex-personal", "user-2", "me@example.com");
    // the same account signed in twice is one plan
    signInCodex(NOW / 1000 + 5400, ".codex-copy", "user-1", "work@example.com");
    replies.set(CODEX_USAGE, codexReply());
    const report = await new UsageService(context(), only("codex")).report();
    expect(report.providers.map((usage) => [usage.key, usage.account])).toEqual([
      ["codex:user-1__acct-1", "work@example.com"],
      ["codex:user-2__acct-1", "me@example.com"],
    ]);
  });

  it("finds a second Claude account in a ~/.claude-* config dir, named by its .claude.json", async () => {
    const credentials = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: NOW + HOUR } });
    const dir = join(home, ".claude-work");
    keychain.set("Claude Code-credentials|me", { status: "found", value: credentials("personal") });
    keychain.set(`Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}|me`, { status: "found", value: credentials("work") });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "uuid-1", emailAddress: "me@example.com" } });
    write(join(dir, ".claude.json"), { oauthAccount: { accountUuid: "uuid-2", emailAddress: "work@example.com" } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    const report = await new UsageService(context("darwin"), only("claude")).report();
    expect(report.providers.map((usage) => [usage.key, usage.account])).toEqual([["claude:uuid-1", "me@example.com"], ["claude:uuid-2", "work@example.com"]]);
    expect(requests.map((request) => (request.init.headers as Record<string, string>)["authorization"])).toEqual(["Bearer personal", "Bearer work"]);
  });

  it("reads the Claude credentials file where there is no keychain", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "file", expiresAt: NOW + HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    await new UsageService(context("linux"), only("claude")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer file");
  });

  it("reads Cursor's plan usage from the app's state database", async () => {
    const path = join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new Database(path);
    db.run("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?), ('cursorAuth/stripeMembershipType', 'pro')", [jwt({ exp: NOW / 1000 + 3600 })]);
    db.close();
    replies.set("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", { body: {
      billingCycleEnd: "1790812800000",
      planUsage: { limit: 40000, remaining: 32000, autoPercentUsed: 12.5, apiPercentUsed: 7.5 },
    } });
    const [usage] = (await new UsageService(context("linux"), only("cursor")).report()).providers;
    const resets_at = new Date(1790812800000).toISOString();
    expect(usage).toMatchObject({ plan: "pro", windows: [
      { kind: "month", scope: null, used_percent: 20, resets_at },
      { kind: "month", scope: "Cursor models", used_percent: 12.5, resets_at },
      { kind: "month", scope: "Other models", used_percent: 7.5, resets_at },
    ] });
    expect(requests[0]!.init.method).toBe("POST");
  });

  it("reads Copilot Free from an editor sign-in and leaves unlimited quotas out", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_x" } });
    replies.set("https://api.github.com/copilot_internal/user", { body: {
      copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_reset_date: "2026-10-01",
      quota_snapshots: {
        chat: { entitlement: 200, percent_remaining: 100, unlimited: false },
        completions: { entitlement: 2000, percent_remaining: 97.8, unlimited: false },
        premium_interactions: { entitlement: 0, percent_remaining: 0, unlimited: false },
      },
    } });
    const [usage] = (await new UsageService(context(), only("copilot")).report()).providers;
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("token gho_x");
    expect(usage).toMatchObject({
      plan: "free",
      windows: [
        { kind: "month", scope: "Chat", used_percent: 0, resets_at: "2026-10-01T00:00:00.000Z" },
        { kind: "month", scope: "Completions", used_percent: 2.2, resets_at: "2026-10-01T00:00:00.000Z" },
      ],
    });
  });

  it("tries the GitHub CLI's token when an old editor sign-in is refused, and lists the account once", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_stale", user: "me" } });
    commands.set("gh auth token --hostname github.com", "gho_live");
    const url = "https://api.github.com/copilot_internal/user";
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const live = (init.headers as Record<string, string>)["authorization"] === "token gho_live";
      return new Response(JSON.stringify(live ? { login: "me", copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 90 } } } : {}), { status: live ? 200 : 401 });
    } }, only("copilot"));
    const { providers } = await service.report();
    const [usage] = providers;
    // a CLI too old to name its account: the answer names it, and the refused sign-in of the same login gives way
    expect(providers).toHaveLength(1);
    expect(requests.map((request) => (request.init.headers as Record<string, string>)["authorization"])).toEqual(["token gho_stale", "token gho_live"]);
    expect(requests.every((request) => request.url === url)).toBe(true);
    expect(usage).toMatchObject({ problem: null, windows: [{ kind: "month", scope: "Chat", used_percent: 10 }] });
  });

  it("tries the next Copilot token after a 404, an account without Copilot", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_other_account" } });
    commands.set("gh auth token --hostname github.com", "gho_with_copilot");
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const found = (init.headers as Record<string, string>)["authorization"] === "token gho_with_copilot";
      return new Response(JSON.stringify(found ? { copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 50 } } } : {}), { status: found ? 200 : 404 });
    } }, only("copilot"));
    const [usage] = (await service.report()).providers;
    expect(requests).toHaveLength(2);
    expect(usage).toMatchObject({ problem: null, windows: [{ scope: "Chat", used_percent: 50 }] });
  });

  it("reads every GitHub CLI account with its own token, trying the editor's first, and skips one gh found broken", async () => {
    write(join(home, ".config", "github-copilot", "apps.json"), { "github.com:Iv1.x": { oauth_token: "gho_editor", user: "Alice" } });
    commands.set("gh auth status --hostname github.com --json hosts", JSON.stringify({ hosts: { "github.com": [
      { state: "success", login: "alice" }, { state: "success", login: "bob" }, { state: "error", login: "carol" },
    ] } }));
    commands.set("gh auth token --hostname github.com --user alice", "gho_alice");
    commands.set("gh auth token --hostname github.com --user bob", "gho_bob");
    commands.set("gh auth token --hostname github.com --user carol", "gho_carol");
    const service = new UsageService({ ...context(), async fetch(target, init) {
      const token = (init.headers as Record<string, string>)["authorization"];
      requests.push({ url: target, init });
      if (token === "token gho_editor") return new Response("{}", { status: 401 });
      const login = token === "token gho_alice" ? "alice" : "Bob";
      return new Response(JSON.stringify({ login, copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 50 } } }));
    } }, only("copilot"));
    const report = await service.report();
    expect(report.providers.map((usage) => [usage.key, usage.account, usage.problem])).toEqual([["copilot:alice", "alice", null], ["copilot:bob", "Bob", null]]);
    expect(requests.map((request) => (request.init.headers as Record<string, string>)["authorization"])).toEqual(["token gho_editor", "token gho_bob", "token gho_alice"]);
  });

  it("leaves out Copilot Free found only through the GitHub CLI, but shows a paid plan there", async () => {
    commands.set("gh auth token --hostname github.com", "gho_cli");
    const free = { login: "me", copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 100 } } };
    replies.set("https://api.github.com/copilot_internal/user", { body: free });
    expect((await new UsageService(context(), only("copilot")).report()).providers).toEqual([]);
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("token gho_cli");
    replies.set("https://api.github.com/copilot_internal/user", { body: { ...free, access_type_sku: "plus_monthly_subscriber", copilot_plan: "individual" } });
    const [paid] = (await new UsageService(context(), only("copilot")).report()).providers;
    expect(paid).toMatchObject({ key: "copilot:me", plan: "individual" });
  });

  it("shows Copilot Free when the same account is also signed in to Copilot in an editor", async () => {
    write(join(home, ".config", "github-copilot", "apps.json"), { "github.com:Iv1.x": { oauth_token: "gho_editor", user: "me" } });
    commands.set("gh auth status --hostname github.com --json hosts", JSON.stringify({ hosts: { "github.com": [{ state: "success", login: "me" }] } }));
    commands.set("gh auth token --hostname github.com --user me", "gho_cli");
    replies.set("https://api.github.com/copilot_internal/user", { body: { login: "me", copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 90 } } } });
    const [usage] = (await new UsageService(context(), only("copilot")).report()).providers;
    expect(usage).toMatchObject({ key: "copilot:me", plan: "free" });
  });

  it("keeps Copilot Free from an unnamed CLI sign-in when it answers for an expired editor account", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_stale", user: "Me" } });
    commands.set("gh auth token --hostname github.com", "gho_cli");
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const live = (init.headers as Record<string, string>)["authorization"] === "token gho_cli";
      return new Response(JSON.stringify(live ? { login: "me", copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 90 } } } : {}), { status: live ? 200 : 401 });
    } }, only("copilot"));
    expect((await service.report()).providers).toMatchObject([{ key: "copilot:me", plan: "free", problem: null, windows: [{ scope: "Chat", used_percent: 10 }] }]);
    expect(requests).toHaveLength(2);
  });

  it("still leaves out an unnamed CLI's Copilot Free when its account differs from the editor's", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_editor", user: "alice" } });
    commands.set("gh auth token --hostname github.com", "gho_cli");
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const editor = (init.headers as Record<string, string>)["authorization"] === "token gho_editor";
      return new Response(JSON.stringify({ login: editor ? "alice" : "bob", copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 90 } } }));
    } }, only("copilot"));
    expect((await service.report()).providers).toMatchObject([{ key: "copilot:alice", plan: "free" }]);
    expect(requests).toHaveLength(2);
  });

  it("says expired when every Copilot token is refused", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_stale" } });
    replies.set("https://api.github.com/copilot_internal/user", { status: 401 });
    const [usage] = (await new UsageService(context(), only("copilot")).report()).providers;
    expect(usage!.problem).toBe("expired");
    expect(requests).toHaveLength(1);
  });

  it("leaves a GitHub account without Copilot out of the report", async () => {
    commands.set("gh auth token --hostname github.com", "gho_x");
    replies.set("https://api.github.com/copilot_internal/user", { status: 404 });
    expect((await new UsageService(context(), only("copilot")).report()).providers).toEqual([]);
  });

  it("reads Grok's credit period, a missing percent being zero", async () => {
    write(join(home, ".grok", "auth.json"), { default: { key: "g", expires_at: new Date(NOW + HOUR).toISOString() } });
    replies.set("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { body: {
      config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-25T00:00:00Z", end: "2026-10-02T00:00:00Z" } },
    } });
    const [usage] = (await new UsageService(context(), only("grok")).report()).providers;
    expect(usage!.windows).toEqual([{ kind: "week", scope: null, used_percent: 0, resets_at: "2026-10-02T00:00:00.000Z" }]);
  });

  it("reads every Grok account signed in", async () => {
    write(join(home, ".grok", "auth.json"), {
      "https://auth.x.ai::a": { key: "ga", user_id: "u-a", email: "a@example.com" },
      "https://auth.x.ai::b": { key: "gb", user_id: "u-b", email: "b@example.com" },
    });
    replies.set("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { body: { config: { creditUsagePercent: 5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } } });
    const report = await new UsageService(context(), only("grok")).report();
    expect(report.providers.map((usage) => [usage.key, usage.account])).toEqual([["grok:u-a", "a@example.com"], ["grok:u-b", "b@example.com"]]);
  });

  it("shows no Grok limit for an answer that states no period and no percent", async () => {
    write(join(home, ".grok", "auth.json"), { default: { key: "g" } });
    replies.set("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { body: { error: "invalid_token" } });
    const [usage] = (await new UsageService(context(), only("grok")).report()).providers;
    expect(usage).toMatchObject({ problem: null, windows: [] });
  });

  it("reads Antigravity's buckets from its go-keyring item, falling back to the second host", async () => {
    const item = { token: { access_token: "ya29", expiry: new Date(NOW + HOUR).toISOString() } };
    keychain.set("gemini|antigravity", { status: "found", value: `go-keyring-base64:${Buffer.from(JSON.stringify(item)).toString("base64")}` });
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { status: 503 });
    replies.set("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [{ buckets: [
      { bucketId: "gemini-5h", remainingFraction: 0.75, resetTime: "2026-09-29T16:00:00Z" },
      { bucketId: "3p-weekly", resetTime: "2026-10-04T00:00:00Z" },
      { bucketId: "3p-5h", remainingFraction: 0, resetTime: "2026-09-29T15:00:00Z" },
      { bucketId: "unknown", remainingFraction: 0.5 },
    ] }] } } });
    const [usage] = (await new UsageService(context("darwin"), only("antigravity")).report()).providers;
    // a bucket without a fraction is left out, never shown as exhausted
    expect(usage!.windows).toEqual([
      { kind: "session", scope: null, used_percent: 25, resets_at: "2026-09-29T16:00:00.000Z" },
      { kind: "session", scope: "Other models", used_percent: 100, resets_at: "2026-09-29T15:00:00.000Z" },
    ]);
  });
});

describe("the service", () => {
  it("never sends an expired token, and says the sign-in expired", async () => {
    signInCodex(NOW / 1000 - 60);
    const [usage] = (await new UsageService(context(), only("codex")).report()).providers;
    expect(usage).toEqual({ id: "codex", key: "codex:user-1__acct-1", account: "me@example.com", plan: "plus", windows: [], problem: "expired", checked_at: null });
    expect(requests).toEqual([]);
  });

  it("names a keychain it cannot read instead of hiding the provider", async () => {
    keychain.set("Claude Code-credentials|me", { status: "locked" });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect(usage).toMatchObject({ id: "claude", problem: "locked", windows: [] });
    expect(requests).toEqual([]);
  });

  it("answers from its cache until FRESH_MS, and a forced refresh only after MIN_REFRESH_MS", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    replies.set(CODEX_USAGE, codexReply());
    const service = new UsageService(context(), only("codex"));
    await service.report();
    now += MIN_REFRESH_MS - 1;
    await service.report(true);
    expect(requests).toHaveLength(1);
    now += 1;
    await service.report(true);
    expect(requests).toHaveLength(2);
    now += FRESH_MS - 1;
    await service.report();
    expect(requests).toHaveLength(2);
    now += 1;
    await service.report();
    expect(requests).toHaveLength(3);
  });

  it("shares one pass between concurrent callers", async () => {
    signInCodex();
    replies.set(CODEX_USAGE, codexReply());
    const service = new UsageService(context(), only("codex"));
    const [a, b] = await Promise.all([service.report(), service.report()]);
    expect(a).toBe(b);
    expect(requests).toHaveLength(1);
  });

  it("runs a refresh that arrives during a plain pass after it, so a cached provider is asked again", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "c", expiresAt: NOW + 24 * HOUR } });
    const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";
    replies.set(CODEX_USAGE, codexReply());
    replies.set(CLAUDE_USAGE, { status: 500 });
    const service = new UsageService(context(), [...only("claude"), ...only("codex")]);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await service.report();
      now += RETRY_MS;
      let open!: () => void;
      replies.set(CLAUDE_USAGE, { body: { five_hour: { utilization: 1, resets_at: null } }, gate: new Promise((resolve) => { open = resolve; }) });
      const plain = service.report();
      const forced = service.report(true);
      expect(forced).not.toBe(plain);
      open();
      await plain;
      await forced;
      expect(requests.filter((request) => request.url === CODEX_USAGE)).toHaveLength(2);
    } finally { console.warn = warn; }
  });

  it("keeps the last numbers through a refused token and a rate limit, and waits out Retry-After", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    replies.set(CODEX_USAGE, codexReply(50));
    const service = new UsageService(context(), only("codex"));
    const first = (await service.report()).providers[0]!;

    now += FRESH_MS;
    replies.set(CODEX_USAGE, { status: 401 });
    expect((await service.report()).providers[0]).toEqual({ ...first, problem: "expired" });

    now += RETRY_MS;
    replies.set(CODEX_USAGE, { status: 429, headers: { "retry-after": "600" } });
    expect((await service.report()).providers[0]).toEqual({ ...first, problem: "rate_limited" });
    const asked = requests.length;
    now += 599_000;
    await service.report(true);
    expect(requests).toHaveLength(asked);

    now += 1000;
    replies.set(CODEX_USAGE, codexReply(60));
    const recovered = (await service.report()).providers[0]!;
    expect(recovered.problem).toBeNull();
    expect(recovered.windows[1]!.used_percent).toBe(60);
  });

  it("drops an account whose sign-in is gone, and finds a new one at the next search", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    replies.set(CODEX_USAGE, codexReply());
    const service = new UsageService(context(), only("codex"));
    expect((await service.report()).providers).toHaveLength(1);
    rmSync(join(home, ".codex"), { recursive: true });
    signInCodex(NOW / 1000 + 24 * 3600, ".codex-other", "user-2", "other@example.com");
    now += FRESH_MS;
    expect((await service.report()).providers.map((usage) => usage.account)).toEqual(["other@example.com"]);
  });

  it("marks a failed request and asks again after RETRY_MS", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    replies.set(CODEX_USAGE, { status: 500 });
    const service = new UsageService(context(), only("codex"));
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect((await service.report()).providers[0]!.problem).toBe("failed");
      now += RETRY_MS;
      replies.set(CODEX_USAGE, codexReply());
      expect((await service.report()).providers[0]!.problem).toBeNull();
    } finally { console.warn = warn; }
  });
});

describe("bounded reads", () => {
  it("treats a credential file over MAX_READ_BYTES as no sign-in", async () => {
    write(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: jwt({ exp: NOW / 1000 + 3600 }) }, pad: "x".repeat(MAX_READ_BYTES) }));
    expect((await new UsageService(context(), only("codex")).report()).providers).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reads an answer over MAX_READ_BYTES as a failure, not a report", async () => {
    signInCodex();
    replies.set(CODEX_USAGE, { body: { plan_type: "pro", pad: "x".repeat(MAX_READ_BYTES) } });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect((await new UsageService(context(), only("codex")).report()).providers[0]!.problem).toBe("failed");
    } finally { console.warn = warn; }
  });

  it("gives up on a command whose output passes MAX_READ_BYTES", async () => {
    expect(await runCommand(["head", "-c", String(MAX_READ_BYTES + 1), "/dev/zero"])).toBeNull();
    expect(await runCommand(["head", "-c", "3", "/dev/zero"])).toBe("\0\0\0");
  });
});

describe("GET /api/usage", () => {
  it("answers the report uncached and refuses other methods", async () => {
    signInCodex();
    replies.set(CODEX_USAGE, codexReply());
    const service = new UsageService(context(), only("codex"));
    const response = await handleUsageRequest(new Request("http://x/api/usage"), new URL("http://x/api/usage"), service);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await response.json()) as UsageReport).providers[0]!.id).toBe("codex");
    const refused = await handleUsageRequest(new Request("http://x/api/usage", { method: "POST" }), new URL("http://x/api/usage"), service);
    expect(refused.status).toBe(405);
  });
});

describe("accounts across reads (review fixes)", () => {
  /** a provider whose sign-ins and answers the test sets: `found` by place, `answer` by token */
  function fake(found: () => Array<Record<string, unknown>>, answer: (token: string) => unknown): UsageProvider {
    return {
      id: "codex",
      signIns: async () => found() as never,
      read: async (_ctx, signIn) => {
        const reply = answer(signIn.token);
        if (reply instanceof Error) throw reply;
        return reply as never;
      },
    };
  }
  const window = (used: number) => ({ kind: "session" as const, scope: "5h", used_percent: used, resets_at: null });

  it("does not show the previous account's numbers when the same place now holds another account's failing sign-in", async () => {
    let signIn = { source: "/home/me/.codex", token: "alice-token", expiresAt: null, account: { id: "alice", label: "alice@example.com" } }; // leakscan:allow: test fixture
    const service = new UsageService(context(), [fake(() => [signIn], (token) => token === "alice-token" ? { plan: "plus", windows: [window(40)] } : new UsageHttpError(401, null))]);
    expect((await service.report()).providers.map((u) => [u.key, u.account])).toEqual([["codex:alice", "alice@example.com"]]);
    signIn = { source: "/home/me/.codex", token: "bob-token", expiresAt: null, account: { id: "bob", label: "bob@example.com" } }; // leakscan:allow: test fixture
    now += FRESH_MS;
    const [usage] = (await service.report(true)).providers;
    expect(usage).toMatchObject({ key: "codex:bob", account: "bob@example.com", problem: "expired", windows: [], plan: null });
  });

  it("keeps a 429's wait for the account when its sign-in moves to another place", async () => {
    let place = "/home/me/.codex"; // leakscan:allow: test fixture
    let asked = 0;
    const service = new UsageService(context(), [fake(() => [{ source: place, token: "t", expiresAt: null, account: { id: "acct", label: null } }], () => {
      asked++;
      return new UsageHttpError(429, HOUR);
    })]);
    expect((await service.report()).providers[0]!.problem).toBe("rate_limited");
    place = "/home/me/.codex-work"; // leakscan:allow: test fixture
    now += MIN_REFRESH_MS;
    expect((await service.report(true)).providers[0]!.problem).toBe("rate_limited");
    expect(asked).toBe(1);
  });

  it("numbers sign-ins of one provider that name no account, and never shows where they were found", async () => {
    const service = new UsageService(context(), [fake(() => [
      { source: "/home/me/.codex-a", token: "a", expiresAt: null }, // leakscan:allow: test fixture
      { source: "/home/me/.codex-b", token: "b", expiresAt: null }, // leakscan:allow: test fixture
    ], () => ({ plan: null, windows: [window(10)] }))]);
    const { providers } = await service.report();
    expect(providers.map((u) => u.account).sort()).toEqual(["#1", "#2"]);
    expect(JSON.stringify(providers)).not.toContain("/home/me");
  });

  it("reads a GitHub CLI sign-in that comes from GH_TOKEN without a per-user lookup", async () => {
    const status = JSON.stringify({ hosts: { "github.com": [{ state: "success", login: "alice", tokenSource: "GH_TOKEN" }] } });
    commands.set("gh auth status --hostname github.com --json hosts", status);
    // what a CLI without --hostname would answer too: the account path must be the one taken
    commands.set("gh auth status --json hosts", status);
    commands.set("gh auth token --hostname github.com", "gho_env");
    replies.set("https://api.github.com/copilot_internal/user", { body: { login: "alice", copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 50 } } } });
    const report = await new UsageService(context(), only("copilot")).report();
    expect(report.providers.map((u) => [u.key, u.problem])).toEqual([["copilot:alice", null]]);
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("token gho_env");
  });

  it("asks each editor token of no known login on its own", async () => {
    write(join(home, ".config", "github-copilot", "apps.json"), {
      "github.com:Iv1.a": { oauth_token: "gho_a" }, "github.com:Iv1.b": { oauth_token: "gho_b" },
    });
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const login = (init.headers as Record<string, string>)["authorization"] === "token gho_a" ? "alice" : "bob";
      return new Response(JSON.stringify({ login, copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 50 } } }));
    } }, only("copilot"));
    const keys = (await service.report()).providers.map((u) => u.key).sort();
    expect(keys).toEqual(["copilot:alice", "copilot:bob"]);
  });
});
