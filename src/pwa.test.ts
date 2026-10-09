import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const publicDir = join(import.meta.dir, "..", "public");

/** Runs public/sw.js against a stand-in `self` and returns its fetch listener. */
function serviceWorkerFetch(): (request: { method: string; url: string; mode: string }) => boolean {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = { location: { origin: "https://app.test" }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) };
  const caches = { match: async () => new Response("cached"), open: async () => ({ put: () => {}, match: async () => new Response("termweave cached") }) };
  const fetch = async () => new Response("network");
  new Function("self", "caches", "fetch", readFileSync(join(publicDir, "sw.js"), "utf8"))(self, caches, fetch);
  const listener = listeners.get("fetch")!;
  return (request) => {
    let answered = false;
    listener({ request, respondWith: () => { answered = true; } });
    return answered;
  };
}

describe("installed app", () => {
  it("leaves the screen orientation to the device's rotation lock", () => {
    // Chrome for Android before mid-2026 ran an `orientation: "any"` app full-sensor,
    // rotating it even with auto-rotate off; no orientation follows the system setting
    const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf8")) as Record<string, unknown>;
    expect(manifest["orientation"]).toBeUndefined();
  });

  it("rereads the web manifest from the network while static assets stay cache-first", () => {
    const answers = serviceWorkerFetch();
    const get = (path: string) => ({ method: "GET", url: `https://app.test${path}`, mode: "no-cors" });
    expect(answers(get("/manifest.webmanifest"))).toBe(false);
    expect(answers(get("/icons/termweave.svg"))).toBe(true);
    expect(answers(get("/assets/index-abc123.js"))).toBe(true);
  });
});

it('worker reads only its cache namespace, never global upstream cache',()=>{
 const source=readFileSync(join(publicDir,'sw.js'),'utf8');expect(source).not.toMatch(/(?<!\.)\bcaches\.match\(/);expect(source).toContain('caches.open(CACHE_NAME)');expect(source).toContain('name.startsWith("termweave-")');
});
