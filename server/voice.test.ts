import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICE_MAX_AUDIO_BYTES, type VoiceEvent, type VoiceStatus } from "../shared/voice.ts";
import { handleVoiceRequest, VoiceService } from "./voice.ts";

const KEY = "sk-test-0123456789abcdef";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

let stateDir: string;
let requests: Array<{ url: string; init: RequestInit }>;
let handler: Handler;

function service(env: Record<string, string | undefined> = {}): VoiceService {
  return new VoiceService({
    stateDir, env,
    async fetch(url, init) {
      requests.push({ url, init });
      return handler(url, init);
    },
  });
}

function call(voice: VoiceService, pathname: string, init: RequestInit = {}): Promise<Response> {
  return handleVoiceRequest(new Request(`http://localhost${pathname}`, init), pathname, voice);
}

const put = (voice: VoiceService, body: unknown) => call(voice, "/api/voice/config", { method: "PUT", body: JSON.stringify(body) });

function clipForm(fields: { audio?: Blob | null; name?: string; mode?: string; polish?: string; keywords?: string; language?: string } = {}): FormData {
  const form = new FormData();
  const audio = fields.audio === undefined ? new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm;codecs=opus" }) : fields.audio;
  if (audio) form.append("audio", audio, fields.name ?? "clip.webm");
  form.append("mode", fields.mode ?? "chat");
  form.append("polish", fields.polish ?? "0");
  if (fields.keywords !== undefined) form.append("keywords", fields.keywords);
  if (fields.language !== undefined) form.append("language", fields.language);
  return form;
}

const transcribe = (voice: VoiceService, form: FormData) => call(voice, "/api/voice/transcribe", { method: "POST", body: form });

async function events(response: Response): Promise<VoiceEvent[]> {
  return (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as VoiceEvent);
}

/** an SSE answer cut at fixed byte offsets: mid-line and mid-character */
function sse(events: unknown[], cuts: number[]): Response {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  const bounds = [0, ...cuts, bytes.length];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i + 1 < bounds.length; i++) controller.enqueue(bytes.slice(bounds[i], bounds[i + 1]));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

const DELTAS = ["안녕하세요 ", "git status ", "실행해 줘"];
function transcriptAnswer(): Response {
  return sse([
    ...DELTAS.map((delta) => ({ type: "transcript.text.delta", delta })),
    { type: "transcript.text.done", text: DELTAS.join("") },
  ], [7, 40, 61, 95, 150]);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "herdr-web-ui-voice-"));
  requests = [];
  handler = () => new Response("unexpected", { status: 500 });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("voice config", () => {
  it("reports no key and the defaults when nothing is set", async () => {
    const response = await call(service(), "/api/voice");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      configured: false, source: null, base_url: "https://api.openai.com/v1", transcribe_model: "gpt-transcribe", polish_model: "gpt-6-luna",
    } satisfies VoiceStatus);
  });

  it("takes the env key and refuses to change it", async () => {
    const voice = service({ HERDR_WEB_OPENAI_API_KEY: KEY });
    const status = await (await call(voice, "/api/voice")).json() as VoiceStatus;
    expect(status).toMatchObject({ configured: true, source: "env" });
    for (const api_key of ["sk-other", null]) {
      const response = await put(voice, { api_key });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "key_from_env" } });
    }
  });

  it("never sends a key to a base_url it was not saved with", async () => {
    writeFileSync(join(stateDir, "voice.json"), JSON.stringify({ base_url: "http://attacker.invalid/v1" }));
    const fromEnv = service({ HERDR_WEB_OPENAI_API_KEY: KEY });
    expect((await (await call(fromEnv, "/api/voice")).json() as VoiceStatus).base_url).toBe("https://api.openai.com/v1");
    const moved = await put(fromEnv, { base_url: "http://attacker.invalid/v1" });
    expect(moved.status).toBe(409);
    expect(await moved.json()).toMatchObject({ error: { code: "key_from_env" } });

    rmSync(join(stateDir, "voice.json"));
    const fromFile = service();
    expect((await put(fromFile, { api_key: KEY })).status).toBe(200);
    const alone = await put(fromFile, { base_url: "http://attacker.invalid/v1" });
    expect(alone.status).toBe(400);
    expect(await alone.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect((await (await call(fromFile, "/api/voice")).json() as VoiceStatus).base_url).toBe("https://api.openai.com/v1");
    expect((await put(fromFile, { api_key: "sk-new-key", base_url: "http://127.0.0.1:9/v1" })).status).toBe(200);
  });

  it("stores the key owner-only and never answers it", async () => {
    const voice = service();
    const saved = await put(voice, { api_key: ` ${KEY} `, base_url: "http://127.0.0.1:9/v1/" });
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain(KEY);
    const path = join(stateDir, "voice.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ api_key: KEY });
    const body = await (await call(voice, "/api/voice")).text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body)).toMatchObject({ configured: true, source: "file", base_url: "http://127.0.0.1:9/v1" });
  });

  it("removes the key with null", async () => {
    const voice = service();
    await put(voice, { api_key: KEY });
    const response = await put(voice, { api_key: null });
    expect(await response.json()).toMatchObject({ configured: false, source: null });
    expect(readFileSync(join(stateDir, "voice.json"), "utf8")).not.toContain(KEY);
  });

  it("refuses a base_url that is not http(s) and a wrong method", async () => {
    const voice = service();
    const response = await put(voice, { base_url: "ftp://example.com" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    const wrong = await call(voice, "/api/voice", { method: "POST" });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
  });
});

describe("voice transcribe", () => {
  it("refuses without a key", async () => {
    const response = await transcribe(service(), clipForm());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "voice_not_configured" } });
    expect(requests).toHaveLength(0);
  });

  it("refuses an oversize clip", async () => {
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ audio: new Blob([new Uint8Array(VOICE_MAX_AUDIO_BYTES + 1)], { type: "audio/webm" }) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "audio_too_large" } });
  });

  it("stops reading a body without a length once it passes the limit", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const chunks = Math.ceil(VOICE_MAX_AUDIO_BYTES / chunk.byteLength) + 8;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= chunks * chunk.byteLength) { controller.close(); return; }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("http://127.0.0.1/api/voice/transcribe", {
      method: "POST", body, headers: { "content-type": "multipart/form-data; boundary=x" }, duplex: "half",
    } as RequestInit);
    const response = await handleVoiceRequest(request, "/api/voice/transcribe", service({ HERDR_WEB_OPENAI_API_KEY: KEY }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "audio_too_large" } });
    expect(pulled).toBeLessThan(VOICE_MAX_AUDIO_BYTES + 4 * chunk.byteLength);
  });

  it("refuses a missing audio part", async () => {
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ audio: null }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_audio" } });
  });

  it("asks for the speaker's language and English, Korean when the client names none", async () => {
    const asked: string[][] = [];
    handler = async (_url, init) => { asked.push((init.body as FormData).getAll("languages[]") as string[]); return transcriptAnswer(); };
    const voice = service({ HERDR_WEB_OPENAI_API_KEY: KEY });
    for (const language of ["ja", "zh", "en", undefined]) await events(await transcribe(voice, clipForm({ language })));
    expect(asked).toEqual([["ja", "en"], ["zh", "en"], ["en"], ["ko", "en"]]);
    const bad = await transcribe(voice, clipForm({ language: "japanese" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("refuses a bad mode", async () => {
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ mode: "shell" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("streams deltas and the done text from a split SSE answer", async () => {
    handler = transcriptAnswer;
    const keywords = JSON.stringify([" git ", "git", "", "server/voice.ts", "x".repeat(81)]);
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ keywords, mode: "terminal" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await events(response)).toEqual([
      ...DELTAS.map((text) => ({ type: "delta" as const, text })),
      { type: "done", text: DELTAS.join("") },
    ]);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(new Headers(request!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const form = request!.init.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("stream")).toBe("true");
    expect(form.getAll("languages[]")).toEqual(["ko", "en"]);
    expect(form.getAll("keywords[]")).toEqual(["git", "server/voice.ts"]);
    expect(form.get("prompt")).toBe("Dictation of a shell command line typed into a terminal");
    expect((form.get("file") as File).name).toBe("audio.webm");
  });

  it("adds the polished text when asked", async () => {
    handler = (url, init) => {
      if (url.endsWith("/audio/transcriptions")) return transcriptAnswer();
      const body = JSON.parse(String(init.body)) as { model: string; reasoning_effort?: string; temperature?: number; messages: Array<{ content: string }> };
      expect(body).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none" });
      expect(body.temperature).toBeUndefined();
      expect(body.messages.at(-1)!.content).toBe(DELTAS.join(""));
      return Response.json({ choices: [{ message: { content: "안녕하세요. `git status` 실행해 줘." } }] });
    };
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ polish: "1" }));
    expect((await events(response)).slice(-2)).toEqual([
      { type: "done", text: DELTAS.join("") },
      { type: "polished", text: "안녕하세요. `git status` 실행해 줘." },
    ]);
    expect(requests.map((request) => request.url)).toEqual(["https://api.openai.com/v1/audio/transcriptions", "https://api.openai.com/v1/chat/completions"]);
  });

  it("sends a model without a reasoning setting a fixed temperature instead", async () => {
    let body: Record<string, unknown> = {};
    handler = (url, init) => {
      if (url.endsWith("/audio/transcriptions")) return transcriptAnswer();
      body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: "tidy" } }] });
    };
    const voice = service({ HERDR_WEB_OPENAI_API_KEY: KEY });
    voice.update({ polish_model: "gpt-4.1-mini" });
    await events(await transcribe(voice, clipForm({ polish: "1" })));
    expect(body).toMatchObject({ model: "gpt-4.1-mini", temperature: 0 });
    expect("reasoning_effort" in body).toBe(false);
  });

  it("ends after done when polishing fails", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      handler = (url) => url.endsWith("/audio/transcriptions") ? transcriptAnswer() : Response.json({ error: { message: `bad key ${KEY}` } }, { status: 500 });
      const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm({ polish: "1" }));
      const lines = await events(response);
      expect(lines.at(-1)).toEqual({ type: "done", text: DELTAS.join("") });
      expect(lines.some((event) => event.type === "polished" || event.type === "error")).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(KEY);
    } finally {
      warn.mockRestore();
    }
  });

  it("reports a refused key as provider_auth without echoing it", async () => {
    handler = () => Response.json({ error: { message: `Incorrect API key provided: ${KEY}` } }, { status: 401 });
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm());
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "provider_auth" } });
    expect(body).not.toContain(KEY);
  });

  it("emits one error line when the provider fails mid-stream", async () => {
    handler = () => sse([{ type: "transcript.text.delta", delta: "안녕" }, { type: "error", error: { message: "server_error" } }], []);
    const response = await transcribe(service({ HERDR_WEB_OPENAI_API_KEY: KEY }), clipForm());
    expect(await events(response)).toEqual([
      { type: "delta", text: "안녕" },
      { type: "error", code: "provider_error", message: "server_error" },
    ]);
  });
});
