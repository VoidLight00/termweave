/**
 * The plan limits of the AI subscriptions this PC's CLIs are signed in to, read with each CLI's
 * own sign-in: how much of the 5-hour session, the week or the billing month is used, and when it
 * starts over.
 *
 * Where each sign-in lives and which endpoint states its limits follows OpenUsage
 * (github.com/robinebers/openusage, MIT, at 2d2eabe).
 *
 * Read only, on purpose: an OAuth token is never refreshed here. Claude, Codex, Cursor and Grok
 * rotate refresh tokens, so a refresh the CLI did not make logs the CLI out. An expired token is
 * reported as `expired` instead; the CLI refreshes its own file the next time it runs.
 *
 * Nothing runs in the background: a provider is asked only when a client asks this server, at
 * most every FRESH_MS unless the client forces it, which is still limited to one ask per
 * MIN_REFRESH_MS. A provider that answered 429 is not asked again before it said to.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderUsage, UsageProblem, UsageProviderId, UsageReport, UsageWindow } from "../shared/protocol.ts";
import { jsonResponse } from "./http.ts";

export const FRESH_MS = 5 * 60_000;
export const MIN_REFRESH_MS = 30_000;
/** after a failure or an expired sign-in: soon enough to pick up the CLI's next refresh */
export const RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 5_000;
const USER_AGENT = "herdr-web-ui";
/** the most a credential file, a command's output or a provider's answer may hold; more is unreadable */
export const MAX_READ_BYTES = 1024 * 1024;

export type KeychainRead = { status: "found"; value: string } | { status: "missing" } | { status: "locked" };

/** Everything a provider touches outside this file, so tests can stand in for it. */
export interface UsageContext {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  fetch(url: string, init: RequestInit): Promise<Response>;
  keychain(service: string, account?: string): Promise<KeychainRead>;
  /** a command's trimmed stdout, or null when it is missing, fails or hangs */
  run(argv: string[]): Promise<string | null>;
  now(): number;
}

/** Who a sign-in belongs to: `id` tells accounts apart, `label` is how its owner knows it (an email, a login). */
interface Account {
  id: string;
  label: string | null;
}

interface SignIn {
  token: string;
  /** epoch ms; null when the sign-in does not say */
  expiresAt: number | null;
  plan?: string | null;
  /** the ChatGPT workspace Codex asks for */
  chatgptAccount?: string | null;
  /** further tokens of the same account, tried in order when the service refuses the one before */
  fallbacks?: string[];
  /** null when the sign-in does not say whose it is */
  account?: Account | null;
  /** Copilot: found only through the GitHub CLI, never signed in to Copilot in an editor */
  cliOnly?: boolean;
  /** Copilot: named editor accounts to match when an older CLI cannot identify its token */
  editorAccounts?: string[];
}

/**
 * A sign-in where it was found. `source` names the place (a directory, a keychain item), stable
 * across reads; one PC can hold several, each of its own account. `locked`: a keychain item this
 * session cannot read.
 */
type Found = { source: string } & (SignIn | { locked: true; account?: Account | null });

interface Reading {
  plan: string | null;
  windows: UsageWindow[];
  /** whose numbers these are, when the answer says and the sign-in did not */
  account?: Account | null;
}

export interface UsageProvider {
  id: UsageProviderId;
  /** every sign-in of this provider on this PC; none when not signed in here */
  signIns(ctx: UsageContext): Promise<Found[]>;
  /** null: signed in, but to an account without this plan */
  read(ctx: UsageContext, signIn: SignIn): Promise<Reading | null>;
}

/** an answer past MAX_READ_BYTES */
class UsageTooLarge extends Error {}

export class UsageHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`HTTP ${status}`);
  }
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
/** a number, or a proto-JSON int64 (sent as a string) */
const number = (value: unknown): number | null => {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
};
const percent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

/** `home`'s directories whose names start with `prefix` (".codex-work"), in name order */
function siblingDirs(home: string, prefix: string): string[] {
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(home, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** a keychain read as found sign-ins: none, the one, or a locked item */
function keychainFound(result: SignIn | "locked" | null, source: string, account: Account | null = null): Found[] {
  if (result === null) return [];
  return [result === "locked" ? { source, locked: true, account } : { ...result, account: result.account ?? account, source }];
}

function parseJson(source: string | null): unknown {
  if (source === null) return null;
  try { return JSON.parse(source); } catch { return null; }
}

function readText(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    let size = 0;
    for (let read = 1; read > 0 && size <= MAX_READ_BYTES; size += read) read = readSync(fd, buffer, size, buffer.length - size, null);
    return size > MAX_READ_BYTES ? null : buffer.toString("utf8", 0, size);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A stream's text up to MAX_READ_BYTES; null past it, the rest left unread. */
async function readCapped(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_READ_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** ISO 8601 from an ISO string or epoch seconds or milliseconds */
function isoTime(value: unknown): string | null {
  const n = number(value);
  if (n !== null && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const s = text(value);
  if (!s) return null;
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function epochMs(value: unknown): number | null {
  const iso = isoTime(value);
  return iso === null ? null : Date.parse(iso);
}

function jwtClaims(token: string): Json {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try { return record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))); } catch { return {}; }
}

function jwtExpiry(token: string): number | null {
  const exp = number(jwtClaims(token)["exp"]);
  return exp === null ? null : exp * 1000;
}

/** The span a limit counts over, from its length in seconds. */
function kindOf(seconds: number | null, fallback: UsageWindow["kind"]): UsageWindow["kind"] {
  if (seconds === null || seconds <= 0) return fallback;
  if (seconds <= 6 * 3600) return "session";
  if (seconds <= 36 * 3600) return "day";
  if (seconds <= 8 * 86400) return "week";
  return "month";
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function requestJson(ctx: UsageContext, url: string, init: RequestInit): Promise<Json> {
  const response = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UsageHttpError(response.status, retryAfter(response.headers.get("retry-after")));
  }
  const body = await readCapped(response.body);
  if (body === null) throw new UsageTooLarge(`${new URL(url).host} answered more than ${MAX_READ_BYTES} bytes`);
  return record(JSON.parse(body));
}

/** The first keychain item that yields a sign-in; "locked" when one exists but could not be read. */
async function fromKeychain(ctx: UsageContext, service: string, accounts: Array<string | undefined>, parse: (value: string) => SignIn | null): Promise<SignIn | "locked" | null> {
  if (ctx.platform !== "darwin") return null;
  for (const account of accounts) {
    const found = await ctx.keychain(service, account);
    if (found.status === "locked") return "locked";
    if (found.status === "found") {
      const signIn = parse(found.value);
      if (signIn) return signIn;
    }
  }
  return null;
}

// ---- Claude Code: keychain `Claude Code-credentials` on macOS, else ~/.claude/.credentials.json ----

/** the account a Claude Code config file says is signed in: `oauthAccount` in .claude.json */
function claudeAccount(path: string): Account | null {
  const oauth = record(record(parseJson(readText(path)))["oauthAccount"]);
  const id = text(oauth["accountUuid"]);
  return id ? { id, label: text(oauth["emailAddress"]) } : null;
}

/**
 * Where Claude Code keeps each sign-in: the default one, then one per config directory it was
 * pointed at (CLAUDE_CONFIG_DIR, and ~/.claude-* for the usual second account). For such a
 * directory it names the keychain item after the directory's hash, and keeps .claude.json in it.
 */
function claudeHomes(ctx: UsageContext): Array<{ source: string; service: string; dir: string; config: string }> {
  const homes = [{ source: "default", service: "Claude Code-credentials", dir: join(ctx.home, ".claude"), config: join(ctx.home, ".claude.json") }];
  const dirs = [ctx.env["CLAUDE_CONFIG_DIR"], ...siblingDirs(ctx.home, ".claude-")].filter((dir): dir is string => Boolean(dir));
  for (const dir of new Set(dirs)) {
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    homes.push({ source: dir, service: `Claude Code-credentials-${hash}`, dir, config: join(dir, ".claude.json") });
  }
  return homes;
}

function claudeSignIn(source: string | null): SignIn | null {
  const oauth = record(record(parseJson(source))["claudeAiOauth"]);
  const token = text(oauth["accessToken"]);
  return token ? { token, expiresAt: number(oauth["expiresAt"]), plan: text(oauth["subscriptionType"]) } : null;
}

function claudeWindow(value: unknown, kind: UsageWindow["kind"], scope: string | null): UsageWindow | null {
  const window = record(value);
  const used = number(window["utilization"]);
  return used === null ? null : { kind, scope, used_percent: percent(used), resets_at: isoTime(window["resets_at"]) };
}

const claude: UsageProvider = {
  id: "claude",
  async signIns(ctx) {
    const user = ctx.env["USER"];
    const found = await Promise.all(claudeHomes(ctx).map(async (home) => {
      const account = claudeAccount(home.config);
      const keychain = await fromKeychain(ctx, home.service, user ? [user, undefined] : [undefined], claudeSignIn);
      const file = claudeSignIn(readText(join(home.dir, ".credentials.json")));
      // Claude Code refreshes the file alone when it cannot write the keychain (started outside the
      // desktop session), so the item can hold a token that expired hours ago: the later one wins.
      // An item that names no expiry is not known to be older, and stays.
      const item = keychain && keychain !== "locked" ? keychain : null;
      const fileIsLater = file != null && item != null && file.expiresAt != null && item.expiresAt != null && file.expiresAt > item.expiresAt;
      if (item && !fileIsLater) return keychainFound(item, home.source, account);
      return file ? [{ ...file, account, source: home.source }] : keychainFound(keychain, home.source, account);
    }));
    return found.flat();
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://api.anthropic.com/api/oauth/usage", {
      headers: { authorization: `Bearer ${signIn.token}`, accept: "application/json", "anthropic-beta": "oauth-2025-04-20", "user-agent": USER_AGENT },
    });
    const windows = [
      claudeWindow(body["five_hour"], "session", null),
      claudeWindow(body["seven_day"], "week", null),
      claudeWindow(body["seven_day_opus"], "week", "Opus"),
      claudeWindow(body["seven_day_sonnet"], "week", "Sonnet"),
    ].filter((window): window is UsageWindow => window !== null);
    return { plan: null, windows };
  },
};

// ---- Codex: auth.json under CODEX_HOME, ~/.config/codex or ~/.codex; keychain `Codex Auth` ----

function codexSignIn(source: string | null): SignIn | null {
  const tokens = record(record(parseJson(source))["tokens"]);
  const token = text(tokens["access_token"]);
  if (!token) return null;
  const claims = jwtClaims(token);
  const auth = record(claims["https://api.openai.com/auth"]);
  const workspace = text(tokens["account_id"]) ?? text(auth["chatgpt_account_id"]);
  const email = text(record(claims["https://api.openai.com/profile"])["email"]) ?? text(jwtClaims(text(tokens["id_token"]) ?? "")["email"]);
  // limits are per person in a workspace: the same email in a team workspace is another plan
  const user = text(auth["chatgpt_user_id"]) ?? text(auth["user_id"]);
  const id = text(auth["chatgpt_account_user_id"]) ?? (user || workspace ? [user, workspace].filter(Boolean).join("__") : email);
  return { token, expiresAt: jwtExpiry(token), plan: text(auth["chatgpt_plan_type"]), chatgptAccount: workspace, account: id ? { id, label: email } : null };
}

function codexWindow(value: unknown, now: number): UsageWindow | null {
  const window = record(value);
  const used = number(window["used_percent"]);
  if (used === null) return null;
  const after = number(window["reset_after_seconds"]);
  return {
    kind: kindOf(number(window["limit_window_seconds"]), "session"),
    scope: null,
    used_percent: percent(used),
    resets_at: isoTime(window["reset_at"]) ?? (after === null ? null : new Date(now + after * 1000).toISOString()),
  };
}

const codex: UsageProvider = {
  id: "codex",
  async signIns(ctx) {
    // CODEX_HOME points Codex elsewhere; ~/.codex-* is where a second account usually lives
    const homes = [ctx.env["CODEX_HOME"], join(ctx.home, ".config", "codex"), join(ctx.home, ".codex"), ...siblingDirs(ctx.home, ".codex-")];
    const found: Found[] = [];
    for (const home of new Set(homes.filter((home): home is string => Boolean(home)))) {
      const signIn = codexSignIn(readText(join(home, "auth.json")));
      if (signIn) found.push({ ...signIn, source: home });
    }
    return found.length ? found : keychainFound(await fromKeychain(ctx, "Codex Auth", [undefined], codexSignIn), "keychain");
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://chatgpt.com/backend-api/wham/usage", {
      headers: {
        authorization: `Bearer ${signIn.token}`, accept: "application/json", "user-agent": USER_AGENT,
        ...(signIn.chatgptAccount ? { "chatgpt-account-id": signIn.chatgptAccount } : {}),
      },
    });
    const limits = record(body["rate_limit"]);
    const now = ctx.now();
    const windows = [codexWindow(limits["primary_window"], now), codexWindow(limits["secondary_window"], now)]
      .filter((window): window is UsageWindow => window !== null);
    return { plan: text(body["plan_type"]), windows };
  },
};

// ---- Cursor: the app's state.vscdb, or the cursor-agent CLI's keychain item ----

function cursorDatabase(ctx: UsageContext): string {
  return ctx.platform === "darwin"
    ? join(ctx.home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : join(ctx.env["XDG_CONFIG_HOME"] || join(ctx.home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorAppSignIn(path: string): SignIn | null {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const value = (key: string) => text(db!.query<{ value: unknown }, [string, number]>("SELECT value FROM ItemTable WHERE key = ? AND length(value) <= ?").get(key, MAX_READ_BYTES)?.value);
    const token = value("cursorAuth/accessToken");
    return token ? { token, expiresAt: jwtExpiry(token), plan: value("cursorAuth/stripeMembershipType"), account: cursorAccount(token, value("cursorAuth/cachedEmail")) } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** a Cursor account by its token's subject, named by the email Cursor keeps beside it */
function cursorAccount(token: string, email: string | null): Account | null {
  const id = text(jwtClaims(token)["sub"]);
  return id ? { id, label: email } : null;
}

const cursor: UsageProvider = {
  id: "cursor",
  async signIns(ctx) {
    const app = cursorAppSignIn(cursorDatabase(ctx));
    const cliEmail = text(record(record(parseJson(readText(join(ctx.home, ".cursor", "cli-config.json"))))["authInfo"])["email"]);
    const cli = await fromKeychain(ctx, "cursor-access-token", [undefined], (value) => {
      const token = text(value);
      return token ? { token, expiresAt: jwtExpiry(token), account: cursorAccount(token, cliEmail) } : null;
    });
    if (!app) return keychainFound(cli, "cli");
    if (!cli || cli === "locked") return [{ ...app, source: "app" }];
    // two accounts are two plans; one account signed in to both is used through the longer-lived token
    if (app.account?.id !== cli.account?.id) return [{ ...app, source: "app" }, { ...cli, source: "cli" }];
    return (cli.expiresAt ?? 0) > (app.expiresAt ?? 0) ? [{ ...cli, plan: app.plan ?? null, account: app.account, source: "cli" }] : [{ ...app, source: "app" }];
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      headers: { authorization: `Bearer ${signIn.token}`, "content-type": "application/json", "connect-protocol-version": "1", "user-agent": USER_AGENT },
      body: "{}",
    });
    const plan = record(body["planUsage"]);
    const limit = number(plan["limit"]);
    const remaining = number(plan["remaining"]);
    const used = number(plan["totalPercentUsed"]) ?? (limit && remaining !== null ? (limit - remaining) / limit * 100 : null);
    const resetsAt = isoTime(body["billingCycleEnd"]);
    // the plan-wide share, then the two allowances inside it: Cursor's own models (Auto) and the rest (API)
    const windows = [[used, null], [number(plan["autoPercentUsed"]), "Cursor models"], [number(plan["apiPercentUsed"]), "Other models"]]
      .filter((entry): entry is [number, string | null] => entry[0] !== null)
      .map(([share, scope]): UsageWindow => ({ kind: "month", scope, used_percent: percent(share), resets_at: resetsAt }));
    return { plan: null, windows };
  },
};

// ---- GitHub Copilot: the editor plugin's sign-in, else the GitHub CLI's ----

interface GitHubToken {
  token: string;
  /** the GitHub login it belongs to, when the file or the CLI says */
  login: string | null;
  /** from an editor's Copilot sign-in, not the GitHub CLI */
  editor: boolean;
}

function copilotFileTokens(source: string | null): GitHubToken[] {
  return Object.entries(record(parseJson(source))).flatMap(([host, entry]) => {
    const token = host.startsWith("github.com") ? text(record(entry)["oauth_token"]) : null;
    return token ? [{ token, login: text(record(entry)["user"]), editor: true }] : [];
  });
}

/** every github.com account the GitHub CLI holds a working sign-in for; the active one alone on an older CLI */
async function ghTokens(ctx: UsageContext): Promise<GitHubToken[]> {
  // only github.com: status checks every host it lists with that host's own credentials
  const accounts = record(record(parseJson(await ctx.run(["gh", "auth", "status", "--hostname", "github.com", "--json", "hosts"])))["hosts"])["github.com"];
  if (!Array.isArray(accounts)) {
    const token = text(await ctx.run(["gh", "auth", "token", "--hostname", "github.com"]));
    return token ? [{ token, login: null, editor: false }] : [];
  }
  const tokens = await Promise.all(accounts.map(async (entry): Promise<GitHubToken | null> => {
    const account = record(entry);
    const login = text(account["login"]);
    // gh has already found a sign-in in error (a revoked token) refused
    if (!login || account["state"] !== "success") return null;
    // a GH_TOKEN/GITHUB_TOKEN sign-in has no stored token: a per-user lookup finds nothing
    const fromEnv = ["GH_TOKEN", "GITHUB_TOKEN"].includes(text(account["tokenSource"]) ?? "");
    const token = text(await ctx.run(["gh", "auth", "token", "--hostname", "github.com", ...(fromEnv ? [] : ["--user", login])]));
    return token ? { token, login, editor: false } : null;
  }));
  return tokens.filter((token): token is GitHubToken => token !== null);
}

function copilotWindow(value: unknown, scope: string, resetsAt: string | null): UsageWindow | null {
  const quota = record(value);
  const entitlement = number(quota["entitlement"]);
  const left = number(quota["percent_remaining"]);
  if (quota["unlimited"] === true || entitlement === null || entitlement <= 0 || left === null) return null;
  return { kind: "month", scope, used_percent: percent(100 - left), resets_at: resetsAt };
}

const copilot: UsageProvider = {
  id: "copilot",
  async signIns(ctx) {
    const dir = join(ctx.env["XDG_CONFIG_HOME"] || join(ctx.home, ".config"), "github-copilot");
    const tokens = [...copilotFileTokens(readText(join(dir, "apps.json"))), ...copilotFileTokens(readText(join(dir, "hosts.json"))), ...await ghTokens(ctx)];
    const editorAccounts = tokens.flatMap(({ login, editor }) => editor && login ? [login.toLowerCase()] : []);
    // One sign-in per GitHub account. An editor sign-in can outlive its token by years: the same
    // account's next token (the GitHub CLI's) is tried after it. A token of no known login is a
    // sign-in of its own: it may be anyone's, and the first to answer would hide the others.
    const accounts = new Map<string, { login: string | null; tokens: string[]; editor: boolean }>();
    const seen = new Set<string>();
    let unknown = 0;
    for (const { token, login, editor } of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      const id = login?.toLowerCase() ?? `#${++unknown}`;
      const account = accounts.get(id) ?? { login, tokens: [], editor: false };
      account.tokens.push(token);
      account.editor ||= editor;
      accounts.set(id, account);
    }
    return [...accounts].map(([id, { login, tokens: [token, ...fallbacks], editor }]): Found => ({
      source: login ? `github:${id}` : `github${id}`, token: token!, expiresAt: null, fallbacks, account: login ? { id, label: login } : null, cliOnly: !editor, editorAccounts,
    }));
  },
  async read(ctx, signIn) {
    // The tokens may belong to different GitHub accounts: the first one with Copilot answers. A 404
    // is an account without it; only when every token says so is Copilot left out.
    let body: Json | null = null;
    let refusal: UsageHttpError | null = null;
    for (const token of [signIn.token, ...signIn.fallbacks ?? []]) {
      try {
        body = await requestJson(ctx, "https://api.github.com/copilot_internal/user", {
          headers: {
            authorization: `token ${token}`, accept: "application/json", "user-agent": "GitHubCopilotChat/0.26.7",
            "editor-version": "vscode/1.96.2", "editor-plugin-version": "copilot-chat/0.26.7", "x-github-api-version": "2025-04-01",
          },
        });
        break;
      } catch (error) {
        if (!(error instanceof UsageHttpError) || ![401, 403, 404].includes(error.status)) throw error;
        if (error.status !== 404) refusal = error;
      }
    }
    if (body === null) {
      if (refusal) throw refusal;
      return null;
    }
    const resetsAt = isoTime(body["quota_reset_date"]);
    const snapshots = record(body["quota_snapshots"]);
    const windows = [
      copilotWindow(snapshots["premium_interactions"], "Premium", resetsAt),
      copilotWindow(snapshots["chat"], "Chat", resetsAt),
      copilotWindow(snapshots["completions"], "Completions", resetsAt),
    ].filter((window): window is UsageWindow => window !== null);
    // Copilot Free states what is left of a monthly allowance instead
    const left = record(body["limited_user_quotas"]);
    const monthly = record(body["monthly_quotas"]);
    for (const [key, scope] of [["chat", "Chat"], ["completions", "Completions"]] as const) {
      const total = number(monthly[key]);
      const remaining = number(left[key]);
      if (total && total > 0 && remaining !== null && !windows.some((window) => window.scope === scope)) {
        windows.push({ kind: "month", scope, used_percent: percent((total - remaining) / total * 100), resets_at: isoTime(body["limited_user_reset_date"]) ?? resetsAt });
      }
    }
    // Copilot Free reports its plan as "individual"; only the SKU tells them apart
    const plan = text(body["access_type_sku"])?.includes("free") ? "free" : text(body["copilot_plan"]);
    const login = text(body["login"]);
    // GitHub grants Copilot Free to every account: a GitHub CLI sign-in alone is no sign of
    // using Copilot. An unnamed CLI token can still answer for a known editor account.
    const editorAccount = login !== null && signIn.editorAccounts?.includes(login.toLowerCase());
    if (plan === "free" && signIn.cliOnly && !editorAccount) return null;
    return { plan, windows, account: login ? { id: login.toLowerCase(), label: login } : null };
  },
};

// ---- Grok CLI: ~/.grok/auth.json ----

const PERIOD_KINDS: Record<string, UsageWindow["kind"]> = {
  USAGE_PERIOD_TYPE_DAILY: "day", USAGE_PERIOD_TYPE_WEEKLY: "week", USAGE_PERIOD_TYPE_MONTHLY: "month",
};

const grok: UsageProvider = {
  id: "grok",
  async signIns(ctx) {
    // one entry per account signed in
    return Object.entries(record(parseJson(readText(join(ctx.home, ".grok", "auth.json"))))).flatMap(([source, entry]): Found[] => {
      const value = record(entry);
      const token = text(value["key"]);
      const id = text(value["user_id"]) ?? text(value["principal_id"]) ?? source;
      return token ? [{ source, token, expiresAt: epochMs(value["expires_at"] ?? value["expires"]), account: { id, label: text(value["email"]) } }] : [];
    });
  },
  async read(ctx, signIn) {
    const body = await requestJson(ctx, "https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      headers: { authorization: `Bearer ${signIn.token}`, "x-xai-token-auth": "xai-grok-cli", accept: "application/json", "user-agent": USER_AGENT },
    });
    const config = record(body["config"]);
    const period = record(config["currentPeriod"]);
    const stated = number(config["creditUsagePercent"]);
    const knownKind = PERIOD_KINDS[text(period["type"]) ?? ""];
    // an answer that states neither is not a plan's usage, whatever its status
    if (stated === null && knownKind === undefined) return { plan: null, windows: [] };
    const start = epochMs(period["start"]);
    const end = epochMs(period["end"]);
    const kind = knownKind ?? kindOf(start !== null && end !== null ? (end - start) / 1000 : null, "month");
    // proto-JSON leaves a zero out: a stated period without a percent is nothing used
    return { plan: null, windows: [{ kind, scope: null, used_percent: percent(stated ?? 0), resets_at: isoTime(period["end"]) }] };
  },
};

// ---- Antigravity (Google's Gemini and third-party model quota): keychain `gemini` / `antigravity` ----

function antigravitySignIn(value: string): SignIn | null {
  const encoded = value.startsWith("go-keyring-base64:") ? Buffer.from(value.slice("go-keyring-base64:".length), "base64").toString("utf8") : value;
  const token = record(record(parseJson(encoded))["token"]);
  const access = text(token["access_token"]);
  return access ? { token: access, expiresAt: epochMs(token["expiry"]) } : null;
}

const ANTIGRAVITY_BUCKETS: Record<string, { kind: UsageWindow["kind"]; scope: string | null }> = {
  "gemini-5h": { kind: "session", scope: null },
  "gemini-weekly": { kind: "week", scope: null },
  "3p-5h": { kind: "session", scope: "Other models" },
  "3p-weekly": { kind: "week", scope: "Other models" },
};

const antigravity: UsageProvider = {
  id: "antigravity",
  signIns: async (ctx) => keychainFound(await fromKeychain(ctx, "gemini", ["antigravity"], antigravitySignIn), "keychain"),
  async read(ctx, signIn) {
    const init: RequestInit = {
      method: "POST",
      headers: { authorization: `Bearer ${signIn.token}`, accept: "application/json", "content-type": "application/json", "user-agent": "antigravity" },
      body: "{}",
    };
    let body: Json;
    try {
      body = await requestJson(ctx, "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init);
    } catch (error) {
      if (error instanceof UsageHttpError && (error.status === 401 || error.status === 403 || error.status === 429)) throw error;
      body = await requestJson(ctx, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", init);
    }
    const groups = body["groups"] ?? record(body["response"])["groups"];
    const windows: UsageWindow[] = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const buckets = record(group)["buckets"];
      for (const bucket of Array.isArray(buckets) ? buckets : []) {
        const value = record(bucket);
        const shape = ANTIGRAVITY_BUCKETS[text(value["bucketId"]) ?? ""];
        const remaining = number(value["remainingFraction"]);
        // no fraction is left out, as OpenUsage does, rather than shown as 0% or 100% used
        if (shape && remaining !== null) windows.push({ ...shape, used_percent: percent((1 - remaining) * 100), resets_at: isoTime(value["resetTime"]) });
      }
    }
    return { plan: null, windows };
  },
};

export const USAGE_PROVIDERS: readonly UsageProvider[] = [claude, codex, cursor, copilot, grok, antigravity];

/** Keychain services whose read hung (an access prompt nobody answered): not asked again. */
const promptedServices = new Set<string>();

async function readKeychain(service: string, account?: string): Promise<KeychainRead> {
  if (promptedServices.has(service)) return { status: "locked" };
  const child = Bun.spawn(["security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, COMMAND_TIMEOUT_MS);
  try {
    const output = await readCapped(child.stdout);
    if (output === null) child.kill();
    const code = await child.exited;
    // the command is over: its timer must not fire during the login-session read below and pass for a prompt
    clearTimeout(timer);
    if (output === null) return { status: "missing" };
    if (code === 0) return { status: "found", value: output.trim() };
    // 44: errSecItemNotFound. Anything else found an item it could not read (36: a locked keychain).
    if (code === 44 && !timedOut) return { status: "missing" };
    // 36 without a prompt: this server runs outside the login (Aqua) session - started over SSH or by a
    // detached multiplexer - where the login keychain refuses any read. Ask from the login session instead.
    if (code === 36 && !timedOut) {
      const gui = await readKeychainInLoginSession(service, account);
      if (gui !== null) return { status: "found", value: gui };
    }
    if (timedOut) promptedServices.add(service);
    return { status: "locked" };
  } catch {
    return { status: "missing" };
  } finally {
    clearTimeout(timer);
  }
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** launchd labels must be unique per call: concurrent reads for different config dirs can start in the same millisecond. */
let loginSessionJobs = 0;

/** `launchctl <args>`'s exit code, killed after COMMAND_TIMEOUT_MS so a stalled launchctl cannot hold up the caller. */
async function launchctl(args: string[]): Promise<number> {
  const child = Bun.spawn(["launchctl", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
  try { return await child.exited; } finally { clearTimeout(timer); }
}

/**
 * Reads a keychain item through a one-shot launchd job in the user's gui/<uid> domain, which runs in the
 * login session where the keychain is unlocked. The value comes back through a FIFO, never a file on disk.
 * null when not on macOS, the job cannot be loaded, or nothing came back in time.
 *
 * The FIFO is opened for reading and writing: that open never waits for the job, and since a FIFO read
 * cannot be cancelled, a newline of our own ends one the job never answers. `security -w` ends the
 * value with a newline, so the first line is the value.
 */
async function readKeychainInLoginSession(service: string, account?: string): Promise<string | null> {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return null;
  const args = ["/usr/bin/security", "find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
  const domain = `gui/${process.getuid()}`;
  const label = `dev.herdr-web-ui.keychain.${process.pid}.${Date.now()}.${++loginSessionJobs}`;
  const dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-keychain-"));
  const fifo = join(dir, "out");
  const plist = join(dir, "job.plist");
  let pipe: FileHandle | undefined;
  try {
    if (Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode !== 0) return null;
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>StandardOutPath</key><string>${xml(fifo)}</string><key>StandardErrorPath</key><string>/dev/null</string><key>RunAtLoad</key><true/></dict></plist>
`, { mode: 0o600 });
    const handle = pipe = await open(fifo, "r+");
    let gaveUp = false;
    const giveUp = () => {
      gaveUp = true;
      try { writeSync(handle.fd, "\n"); } catch { /* nothing reads any more */ }
    };
    const reading = (async () => {
      const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
      let size = 0;
      let line = -1;
      while (line === -1 && size <= MAX_READ_BYTES) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
        line = buffer.subarray(0, size).indexOf(0x0a);
      }
      return line === -1 ? null : buffer.toString("utf8", 0, line).trim();
    })().catch(() => null);
    const timer = setTimeout(giveUp, COMMAND_TIMEOUT_MS);
    try {
      if (await launchctl(["bootstrap", domain, plist]).catch(() => -1) !== 0) giveUp();
      const value = await reading;
      return gaveUp || !value ? null : value;
    } finally { clearTimeout(timer); }
  } catch {
    return null;
  } finally {
    await launchctl(["bootout", `${domain}/${label}`]).catch(() => undefined);
    await pipe?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runCommand(argv: string[]): Promise<string | null> {
  if (!Bun.which(argv[0]!)) return null;
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
    try {
      const output = await readCapped(child.stdout);
      if (output === null) child.kill();
      const code = await child.exited;
      return code === 0 && output !== null ? output.trim() : null;
    } finally { clearTimeout(timer); }
  } catch {
    return null;
  }
}

export function systemUsageContext(): UsageContext {
  return {
    home: homedir(),
    env: process.env,
    platform: process.platform,
    fetch: (url, init) => fetch(url, init),
    keychain: readKeychain,
    run: runCommand,
    now: Date.now,
  };
}

/** one sign-in's last reading */
interface Entry {
  /** null: signed in without this plan */
  usage: ProviderUsage | null;
  readAt: number;
  nextAt: number;
}

/** when a provider's sign-ins were last looked for, and the sources found then */
interface Search {
  readAt: number;
  nextAt: number;
  sources: string[];
}

export class UsageService {
  private readonly searches = new Map<UsageProviderId, Search>();
  /** by provider and source */
  private readonly entries = new Map<string, Entry>();
  /** when each account may be asked again after a 429, wherever its sign-in is found next */
  private readonly backoffs = new Map<string, number>();
  private pending: Promise<UsageReport> | null = null;
  private pendingRefresh = false;

  constructor(private readonly ctx: UsageContext = systemUsageContext(), private readonly providers: readonly UsageProvider[] = USAGE_PROVIDERS) {}

  /**
   * `refresh` asks again sooner than FRESH_MS. Concurrent callers share one pass; a refresh that
   * arrives during a plain pass runs after it, so no provider it could force is answered from cache.
   */
  report(refresh = false): Promise<UsageReport> {
    if (this.pending && (!refresh || this.pendingRefresh)) return this.pending;
    const pass: Promise<UsageReport> = (this.pending ?? Promise.resolve())
      .then(() => this.collect(refresh))
      .finally(() => { if (this.pending === pass) { this.pending = null; this.pendingRefresh = false; } });
    this.pending = pass;
    this.pendingRefresh = refresh;
    return pass;
  }

  private async collect(refresh: boolean): Promise<UsageReport> {
    const now = this.ctx.now();
    const usages = await Promise.all(this.providers.map((provider) => this.collectProvider(provider, now, refresh)));
    // one account found in two places is listed once: the reading without a problem, else the first
    const byKey = new Map<string, ProviderUsage>();
    for (const usage of usages.flat()) {
      const held = byKey.get(usage.key);
      if (!held || (held.problem !== null && usage.problem === null)) byKey.set(usage.key, usage);
    }
    // two sign-ins of one provider that name no account are told apart by a number, in key order
    const unnamed = new Map<UsageProviderId, ProviderUsage[]>();
    for (const usage of byKey.values()) if (usage.account === null) unnamed.set(usage.id, [...unnamed.get(usage.id) ?? [], usage]);
    for (const group of unnamed.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.key.localeCompare(b.key)).forEach((usage, i) => byKey.set(usage.key, { ...usage, account: `#${i + 1}` }));
    }
    return { providers: [...byKey.values()] };
  }

  private async collectProvider(provider: UsageProvider, now: number, refresh: boolean): Promise<ProviderUsage[]> {
    const search = this.searches.get(provider.id);
    // an account's readAt is never later than its provider's, so a forced search may ask each again
    const forced = refresh && search !== undefined && now - search.readAt >= MIN_REFRESH_MS;
    const usages = (sources: readonly string[]) => sources.map((source) => this.entries.get(source)?.usage ?? null).filter((usage): usage is ProviderUsage => usage !== null);
    if (search && now < search.nextAt && !forced) return usages(search.sources);

    let found: Found[];
    try { found = await provider.signIns(this.ctx); } catch { found = []; }
    // the same token in two places is one sign-in
    const tokens = new Set<string>();
    found = found.filter((signIn) => "locked" in signIn || (!tokens.has(signIn.token) && Boolean(tokens.add(signIn.token))));
    const read = await Promise.all(found.map(async (signIn): Promise<[string, Entry]> => {
      const source = `${provider.id}|${signIn.source}`;
      const entry = this.entries.get(source);
      const current = entry !== undefined && now < entry.nextAt && !(forced && entry.usage?.problem !== "rate_limited");
      return [source, current ? entry : await this.read(provider, signIn, entry?.usage ?? null, now)];
    }));
    for (const source of search?.sources ?? []) if (!read.some(([found]) => found === source)) this.entries.delete(source);
    for (const [source, entry] of read) this.entries.set(source, entry);
    const sources = read.map(([source]) => source);
    this.searches.set(provider.id, { readAt: now, nextAt: Math.min(now + FRESH_MS, ...read.map(([, entry]) => entry.nextAt)), sources });
    return usages(sources);
  }

  private async read(provider: UsageProvider, found: Found, previous: ProviderUsage | null, now: number): Promise<Entry> {
    const settle = (usage: ProviderUsage | null, wait: number): Entry => ({ usage, readAt: now, nextAt: now + wait });
    // an account is known by its id; one the sign-in does not name, by where it was found (hashed:
    // the key reaches the browser, the credential's path must not)
    const identity = (account: Account | null | undefined) => {
      const known = account ?? found.account ?? null;
      const place = createHash("sha256").update(found.source).digest("hex").slice(0, 12);
      return { key: known ? `${provider.id}:${known.id}` : `${provider.id}@${place}`, account: known?.label ?? null };
    };
    // the last numbers stay, named by what went wrong since - unless the place now holds another
    // account's sign-in: those numbers and that name were someone else's
    const kept = previous !== null && (!found.account || previous.key === identity(null).key) ? previous : null;
    const keep = (problem: UsageProblem, plan: string | null, wait: number) => settle({
      id: provider.id, ...(kept ? { key: kept.key, account: kept.account } : identity(null)),
      plan: kept?.plan ?? plan, windows: kept?.windows ?? [], problem, checked_at: kept?.checked_at ?? null,
    }, wait);
    if ("locked" in found) return keep("locked", null, FRESH_MS);
    const signIn: SignIn = found;
    if (signIn.expiresAt !== null && signIn.expiresAt <= now) return keep("expired", signIn.plan ?? null, RETRY_MS);
    // a 429 holds for the account, not the place: a sign-in moved or copied elsewhere waits too
    const backoff = found.account ? `${provider.id}:${found.account.id}` : `${provider.id}#${createHash("sha256").update(signIn.token).digest("hex")}`;
    const until = this.backoffs.get(backoff);
    if (until !== undefined && now < until) return keep("rate_limited", signIn.plan ?? null, until - now);
    this.backoffs.delete(backoff);
    try {
      const reading = await provider.read(this.ctx, signIn);
      if (reading === null) return settle(null, FRESH_MS);
      return settle({
        id: provider.id, ...identity(reading.account), plan: reading.plan ?? signIn.plan ?? null, windows: reading.windows, problem: null, checked_at: new Date(now).toISOString(),
      }, FRESH_MS);
    } catch (error) {
      if (error instanceof UsageHttpError && (error.status === 401 || error.status === 403)) return keep("expired", signIn.plan ?? null, RETRY_MS);
      if (error instanceof UsageHttpError && error.status === 429) {
        const wait = Math.max(RETRY_MS, error.retryAfterMs ?? FRESH_MS);
        this.backoffs.set(backoff, now + wait);
        return keep("rate_limited", signIn.plan ?? null, wait);
      }
      console.warn(`usage: ${provider.id} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      return keep("failed", signIn.plan ?? null, RETRY_MS);
    }
  }
}

export async function handleUsageRequest(request: Request, url: URL, service: UsageService): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET /api/usage" } }, 405, { allow: "GET" });
  return jsonResponse(await service.report(url.searchParams.get("refresh") === "1"), 200, { "cache-control": "no-store" });
}
